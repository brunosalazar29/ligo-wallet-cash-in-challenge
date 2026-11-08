import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { ProviderIdempotencyConflictError, ProviderTimeoutError } from '../domain/errors.js';
import type { ProviderResult } from '../domain/types.js';
import { withTransaction } from './database.js';

export type FakeProviderScenario =
  | 'success'
  | 'declined'
  | 'timeout-after-charge'
  | 'timeout-before-charge';

export interface ChargeRequest {
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  paymentMethod: string;
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<ProviderResult>;
}

interface StoredProviderPayment {
  idempotency_key: string;
  provider_payment_id: string;
  amount_minor: string;
  currency: string;
  payment_method: string;
  status: 'SUCCEEDED' | 'FAILED';
  failure_code: string | null;
}

/**
 * A deterministic local provider. Its durable idempotency table models the
 * provider-side contract that a real processor must offer for safe retries.
 */
export class FakePaymentProvider implements PaymentProvider {
  private readonly queuedScenarios: FakeProviderScenario[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly defaultScenario: FakeProviderScenario = 'success',
  ) {}

  enqueueScenario(scenario: FakeProviderScenario): void {
    this.queuedScenarios.push(scenario);
  }

  async charge(request: ChargeRequest): Promise<ProviderResult> {
    const prior = await this.findPayment(request.idempotencyKey);
    if (prior) return this.toResult(prior, request, true);

    const scenario = this.queuedScenarios.shift() ?? this.defaultScenario;
    if (scenario === 'timeout-before-charge') {
      throw new ProviderTimeoutError('Provider timed out before creating a payment');
    }

    const providerPaymentId = `pay_${randomUUID()}`;
    const status = scenario === 'declined' ? 'FAILED' : 'SUCCEEDED';
    const created = await withTransaction(this.pool, async (client) => {
      const inserted = await client.query<StoredProviderPayment>(
        `INSERT INTO simulated_provider_payments (
           idempotency_key, provider_payment_id, amount_minor, currency,
           payment_method, status, failure_code
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING idempotency_key, provider_payment_id, amount_minor::text,
                   currency, payment_method, status, failure_code`,
        [
          request.idempotencyKey,
          providerPaymentId,
          request.amountMinor.toString(),
          request.currency,
          request.paymentMethod,
          status,
          status === 'FAILED' ? 'PAYMENT_DECLINED' : null,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow) return { row: insertedRow, wasCreated: true };

      const existing = await client.query<StoredProviderPayment>(
        `SELECT idempotency_key, provider_payment_id, amount_minor::text,
                currency, payment_method, status, failure_code
         FROM simulated_provider_payments
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [request.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('Provider idempotency row disappeared');
      return { row, wasCreated: false };
    });

    const result = this.toResult(created.row, request, !created.wasCreated);
    if (created.wasCreated && scenario === 'timeout-after-charge') {
      throw new ProviderTimeoutError('Provider charged successfully but its response was lost');
    }
    return result;
  }

  private async findPayment(key: string): Promise<StoredProviderPayment | null> {
    const result = await this.pool.query<StoredProviderPayment>(
      `SELECT idempotency_key, provider_payment_id, amount_minor::text,
              currency, payment_method, status, failure_code
       FROM simulated_provider_payments
       WHERE idempotency_key = $1`,
      [key],
    );
    return result.rows[0] ?? null;
  }

  private toResult(
    row: StoredProviderPayment,
    request: ChargeRequest,
    replayed: boolean,
  ): ProviderResult {
    if (
      BigInt(row.amount_minor) !== request.amountMinor ||
      row.currency.trim() !== request.currency ||
      row.payment_method !== request.paymentMethod
    ) {
      throw new ProviderIdempotencyConflictError();
    }
    return {
      status: row.status,
      providerPaymentId: row.provider_payment_id,
      failureCode: row.failure_code,
      failureMessage: row.failure_code ? 'Payment was declined by the simulated provider' : null,
      replayed,
    };
  }
}
