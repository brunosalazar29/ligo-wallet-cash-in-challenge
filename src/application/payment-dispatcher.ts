import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ProviderTimeoutError } from '../domain/errors.js';
import type { CashInOperation } from '../domain/types.js';
import {
  applyOperationStatus,
  claimOutboxOperation,
  completeOutboxOperation,
  getCashInOperation,
  listReadyOutboxOperations,
  rescheduleOutboxOperation,
} from '../infrastructure/cash-in-repository.js';
import type { PaymentProvider } from '../infrastructure/payment-provider.js';

export interface DispatcherOptions {
  leaseMs: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class PaymentDispatcher {
  private workerTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly provider: PaymentProvider,
    private readonly options: DispatcherOptions,
  ) {}

  async dispatchOperation(operationId: string): Promise<CashInOperation | null> {
    const workerId = randomUUID();
    const attempts = await claimOutboxOperation(
      this.pool,
      operationId,
      workerId,
      this.options.leaseMs,
    );
    if (attempts === null) return getCashInOperation(this.pool, operationId);

    const operation = await getCashInOperation(this.pool, operationId);
    if (!operation || operation.status !== 'PENDING') {
      await completeOutboxOperation(this.pool, operationId);
      return operation;
    }

    try {
      const result = await this.provider.charge({
        idempotencyKey: operation.providerIdempotencyKey,
        amountMinor: operation.amountMinor,
        currency: operation.currency,
        paymentMethod: operation.paymentMethod,
      });
      await applyOperationStatus(this.pool, {
        operationId: operation.id,
        status: result.status,
        providerPaymentId: result.providerPaymentId,
        failureCode: result.failureCode,
        failureMessage: result.failureMessage,
        source: 'PROVIDER_RESPONSE',
        sourceId: operation.providerIdempotencyKey,
        details: { replayed: result.replayed },
      });
    } catch (error) {
      const delayMs = this.retryDelayMs(attempts);
      const message = error instanceof Error ? error.message : 'Unknown provider error';
      await rescheduleOutboxOperation(this.pool, operationId, workerId, delayMs, message);
      if (error instanceof ProviderTimeoutError) {
        this.options.logger?.warn(
          { operationId, attempts, delayMs },
          'Payment provider result is uncertain; operation remains pending',
        );
      } else {
        this.options.logger?.error(
          { operationId, attempts, delayMs, error: message },
          'Payment dispatch failed and was scheduled for retry',
        );
      }
    }

    return getCashInOperation(this.pool, operationId);
  }

  async runOnce(): Promise<number> {
    const operationIds = await listReadyOutboxOperations(this.pool);
    for (const operationId of operationIds) {
      await this.dispatchOperation(operationId);
    }
    return operationIds.length;
  }

  startWorker(intervalMs: number): void {
    if (this.workerTimer) return;
    this.workerTimer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.options.logger?.error(
          { error: error instanceof Error ? error.message : 'Unknown worker error' },
          'Outbox worker iteration failed',
        );
      });
    }, intervalMs);
    this.workerTimer.unref();
  }

  stopWorker(): void {
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
  }

  private retryDelayMs(attempt: number): number {
    return Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7));
  }
}
