import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppError } from '../domain/errors.js';
import { decidePaymentTransition } from '../domain/payment-state.js';
import type {
  CashInInput,
  CashInOperation,
  CashInView,
  EventDisposition,
  OperationStatus,
  PaymentWebhookEvent,
  ProviderStatus,
} from '../domain/types.js';
import { withTransaction } from './database.js';

interface OperationRow extends QueryResultRow {
  id: string;
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  amount_minor: string;
  currency: string;
  payment_method: string;
  provider_idempotency_key: string;
  provider_payment_id: string | null;
  status: OperationStatus;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  updated_at: Date;
  balance_after_minor?: string | null;
}

export type CreateCashInResult = {
  operation: CashInOperation;
  created: boolean;
};

export type ApplyResult = {
  disposition: EventDisposition;
  currentStatus: OperationStatus;
};

export interface ApplyStatusInput {
  operationId: string;
  status: ProviderStatus;
  providerPaymentId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  source: 'WEBHOOK' | 'PROVIDER_RESPONSE';
  sourceId: string;
  details: Record<string, unknown>;
}

function mapOperation(row: OperationRow): CashInOperation {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency.trim(),
    paymentMethod: row.payment_method,
    providerIdempotencyKey: row.provider_idempotency_key,
    providerPaymentId: row.provider_payment_id,
    status: row.status,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const OPERATION_COLUMNS = `
  id, user_id, idempotency_key, request_hash, amount_minor, currency,
  payment_method, provider_idempotency_key, provider_payment_id, status,
  failure_code, failure_message, created_at, updated_at
`;

export async function createOrGetCashIn(
  pool: Pool,
  input: CashInInput,
): Promise<CreateCashInResult> {
  return withTransaction(pool, async (client) => {
    await client.query(
      `INSERT INTO wallets (user_id, currency, balance_minor)
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [input.userId, input.currency],
    );

    const walletResult = await client.query<{ currency: string }>(
      'SELECT currency FROM wallets WHERE user_id = $1',
      [input.userId],
    );
    const walletCurrency = walletResult.rows[0]?.currency.trim();
    if (walletCurrency !== input.currency) {
      throw new AppError(
        409,
        'WALLET_CURRENCY_MISMATCH',
        `The wallet uses ${walletCurrency ?? 'an unknown currency'}`,
      );
    }

    const operationId = randomUUID();
    const inserted = await client.query<OperationRow>(
      `INSERT INTO cash_in_operations (
         id, user_id, idempotency_key, request_hash, amount_minor, currency,
         payment_method, provider_idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING ${OPERATION_COLUMNS}`,
      [
        operationId,
        input.userId,
        input.idempotencyKey,
        input.requestHash,
        input.amountMinor.toString(),
        input.currency,
        input.paymentMethod,
        `cashin:${operationId}`,
      ],
    );

    const newRow = inserted.rows[0];
    if (newRow) {
      await client.query(
        `INSERT INTO payment_outbox (id, operation_id) VALUES ($1, $2)`,
        [randomUUID(), operationId],
      );
      return { operation: mapOperation(newRow), created: true };
    }

    const existing = await client.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS}
       FROM cash_in_operations
       WHERE user_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [input.userId, input.idempotencyKey],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      throw new Error('Idempotency conflict row disappeared before it could be read');
    }
    if (existingRow.request_hash !== input.requestHash) {
      throw new AppError(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used with different request data',
      );
    }
    return { operation: mapOperation(existingRow), created: false };
  });
}

export async function getCashInOperation(
  pool: Pool,
  operationId: string,
): Promise<CashInOperation | null> {
  const result = await pool.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS} FROM cash_in_operations WHERE id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  return row ? mapOperation(row) : null;
}

export async function getCashInView(
  pool: Pool,
  operationId: string,
): Promise<CashInView | null> {
  const result = await pool.query<OperationRow>(
    `SELECT op.${OPERATION_COLUMNS.replaceAll(', ', ', op.')},
            ledger.balance_after_minor::text AS balance_after_minor
     FROM cash_in_operations AS op
     LEFT JOIN ledger_entries AS ledger ON ledger.operation_id = op.id
     WHERE op.id = $1`,
    [operationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    operation: mapOperation(row),
    balanceAfterMinor:
      row.balance_after_minor === null || row.balance_after_minor === undefined
        ? null
        : BigInt(row.balance_after_minor),
  };
}

export async function claimOutboxOperation(
  pool: Pool,
  operationId: string,
  workerId: string,
  leaseMs: number,
): Promise<number | null> {
  const result = await pool.query<{ attempts: number }>(
    `UPDATE payment_outbox AS outbox
     SET locked_by = $2,
         locked_until = now() + ($3::text || ' milliseconds')::interval,
         attempts = outbox.attempts + 1
     WHERE outbox.operation_id = $1
       AND outbox.completed_at IS NULL
       AND outbox.available_at <= now()
       AND (outbox.locked_until IS NULL OR outbox.locked_until < now())
       AND EXISTS (
         SELECT 1 FROM cash_in_operations AS op
         WHERE op.id = outbox.operation_id AND op.status = 'PENDING'
       )
     RETURNING attempts`,
    [operationId, workerId, leaseMs],
  );
  return result.rows[0]?.attempts ?? null;
}

export async function listReadyOutboxOperations(
  pool: Pool,
  limit = 20,
): Promise<string[]> {
  const result = await pool.query<{ operation_id: string }>(
    `SELECT outbox.operation_id
     FROM payment_outbox AS outbox
     JOIN cash_in_operations AS op ON op.id = outbox.operation_id
     WHERE outbox.completed_at IS NULL
       AND outbox.available_at <= now()
       AND (outbox.locked_until IS NULL OR outbox.locked_until < now())
       AND op.status = 'PENDING'
     ORDER BY outbox.created_at
     LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => row.operation_id);
}

export async function rescheduleOutboxOperation(
  pool: Pool,
  operationId: string,
  workerId: string,
  delayMs: number,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE payment_outbox
     SET available_at = now() + ($3::text || ' milliseconds')::interval,
         locked_by = NULL,
         locked_until = NULL,
         last_error = $4
     WHERE operation_id = $1 AND locked_by = $2 AND completed_at IS NULL`,
    [operationId, workerId, delayMs, errorMessage.slice(0, 500)],
  );
}

export async function completeOutboxOperation(
  executor: Pool | PoolClient,
  operationId: string,
): Promise<void> {
  await executor.query(
    `UPDATE payment_outbox
     SET completed_at = COALESCE(completed_at, now()),
         locked_by = NULL,
         locked_until = NULL,
         last_error = NULL
     WHERE operation_id = $1`,
    [operationId],
  );
}

export async function applyOperationStatus(
  pool: Pool,
  input: ApplyStatusInput,
): Promise<ApplyResult> {
  return withTransaction(pool, async (client) =>
    applyOperationStatusInTransaction(client, input),
  );
}

export async function applyOperationStatusInTransaction(
  client: PoolClient,
  input: ApplyStatusInput,
): Promise<ApplyResult> {
  const selected = await client.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS}
     FROM cash_in_operations
     WHERE id = $1
     FOR UPDATE`,
    [input.operationId],
  );
  const operationRow = selected.rows[0];
  if (!operationRow) {
    throw new AppError(404, 'OPERATION_NOT_FOUND', 'Cash-in operation was not found');
  }

  const operation = mapOperation(operationRow);
  let reconciliationReason: string | null = null;
  if (input.providerPaymentId) {
    // Serialize ownership checks for the same external payment ID. The unique
    // index below remains the final integrity guard.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `provider-payment:${input.providerPaymentId}`,
    ]);
    const otherOperation = await client.query<{ id: string }>(
      `SELECT id FROM cash_in_operations
       WHERE provider_payment_id = $1 AND id <> $2
       LIMIT 1`,
      [input.providerPaymentId, operation.id],
    );
    if (otherOperation.rowCount) {
      reconciliationReason = 'Provider payment ID is already assigned to another operation';
    }
  }
  if (
    operation.providerPaymentId &&
    input.providerPaymentId &&
    operation.providerPaymentId !== input.providerPaymentId
  ) {
    reconciliationReason = 'Provider payment ID changed for the same cash-in operation';
  }

  if (reconciliationReason) {
    await client.query(
      `INSERT INTO reconciliation_cases (id, operation_id, source, reason, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        operation.id,
        input.source,
        reconciliationReason,
        JSON.stringify({
          source_id: input.sourceId,
          stored_provider_payment_id: operation.providerPaymentId,
          incoming_provider_payment_id: input.providerPaymentId,
          ...input.details,
        }),
      ],
    );
    await completeOutboxOperation(client, operation.id);
    return { disposition: 'RECONCILIATION_REQUIRED', currentStatus: operation.status };
  }
  const decision = decidePaymentTransition(operation.status, input.status);

  if (decision.kind === 'APPLY' && decision.nextStatus === 'SUCCEEDED') {
    const priorLedger = await client.query<{ balance_after_minor: string }>(
      `SELECT balance_after_minor::text
       FROM ledger_entries
       WHERE operation_id = $1`,
      [operation.id],
    );
    if (!priorLedger.rowCount) {
      const wallet = await client.query<{ balance_minor: string }>(
        `UPDATE wallets
         SET balance_minor = balance_minor + $2::bigint,
             updated_at = now()
         WHERE user_id = $1
         RETURNING balance_minor::text`,
        [operation.userId, operation.amountMinor.toString()],
      );
      const balanceAfterMinor = wallet.rows[0]?.balance_minor;
      if (!balanceAfterMinor) throw new Error('Wallet disappeared during cash-in finalization');
      await client.query(
        `INSERT INTO ledger_entries (
           id, user_id, operation_id, entry_type, amount_minor,
           balance_after_minor, currency
         ) VALUES ($1, $2, $3, 'CASH_IN', $4, $5, $6)`,
        [
          randomUUID(),
          operation.userId,
          operation.id,
          operation.amountMinor.toString(),
          balanceAfterMinor,
          operation.currency,
        ],
      );
    }
    await client.query(
      `UPDATE cash_in_operations
       SET status = 'SUCCEEDED',
           provider_payment_id = COALESCE($2, provider_payment_id),
           failure_code = NULL,
           failure_message = NULL,
           updated_at = now()
       WHERE id = $1`,
      [operation.id, input.providerPaymentId],
    );
    await completeOutboxOperation(client, operation.id);
    return { disposition: 'APPLIED', currentStatus: 'SUCCEEDED' };
  }

  if (decision.kind === 'APPLY' && decision.nextStatus === 'FAILED') {
    await client.query(
      `UPDATE cash_in_operations
       SET status = 'FAILED',
           provider_payment_id = COALESCE($2, provider_payment_id),
           failure_code = $3,
           failure_message = $4,
           updated_at = now()
       WHERE id = $1`,
      [
        operation.id,
        input.providerPaymentId,
        input.failureCode ?? 'PAYMENT_DECLINED',
        input.failureMessage?.slice(0, 300) ?? 'Payment was declined',
      ],
    );
    await completeOutboxOperation(client, operation.id);
    return { disposition: 'APPLIED', currentStatus: 'FAILED' };
  }

  if (decision.kind === 'RECONCILIATION_REQUIRED') {
    await client.query(
      `INSERT INTO reconciliation_cases (id, operation_id, source, reason, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        randomUUID(),
        operation.id,
        input.source,
        decision.reason,
        JSON.stringify({
          source_id: input.sourceId,
          current_status: operation.status,
          incoming_status: input.status,
          provider_payment_id: input.providerPaymentId,
          ...input.details,
        }),
      ],
    );
    await completeOutboxOperation(client, operation.id);
    return {
      disposition: 'RECONCILIATION_REQUIRED',
      currentStatus: operation.status,
    };
  }

  if (input.providerPaymentId && !operation.providerPaymentId) {
    await client.query(
      `UPDATE cash_in_operations
       SET provider_payment_id = $2, updated_at = now()
       WHERE id = $1`,
      [operation.id, input.providerPaymentId],
    );
  }
  if (operation.status !== 'PENDING') await completeOutboxOperation(client, operation.id);
  return {
    disposition: decision.kind === 'DUPLICATE_EFFECT' ? 'DUPLICATE_EFFECT' : 'NO_STATE_CHANGE',
    currentStatus: operation.status,
  };
}

export interface ApplyWebhookResult extends ApplyResult {
  duplicateEvent: boolean;
}

export async function applyWebhookEvent(
  pool: Pool,
  event: PaymentWebhookEvent,
): Promise<ApplyWebhookResult> {
  return withTransaction(pool, async (client) => {
    const operation = await client.query<{ id: string }>(
      `SELECT id FROM cash_in_operations WHERE id = $1 FOR UPDATE`,
      [event.operationId],
    );
    if (!operation.rowCount) {
      throw new AppError(404, 'OPERATION_NOT_FOUND', 'Cash-in operation was not found');
    }

    const existing = await client.query<{ operation_id: string; disposition: EventDisposition }>(
      `SELECT operation_id, disposition
       FROM provider_webhook_events
       WHERE event_id = $1`,
      [event.eventId],
    );
    const existingEvent = existing.rows[0];
    if (existingEvent) {
      if (existingEvent.operation_id !== event.operationId) {
        throw new AppError(409, 'WEBHOOK_EVENT_ID_REUSED', 'Webhook event ID belongs to another operation');
      }
      const current = await client.query<{ status: OperationStatus }>(
        'SELECT status FROM cash_in_operations WHERE id = $1',
        [event.operationId],
      );
      return {
        duplicateEvent: true,
        disposition: existingEvent.disposition,
        currentStatus: current.rows[0]?.status ?? 'PENDING',
      };
    }

    const operationStatus = await client.query<{ status: OperationStatus }>(
      'SELECT status FROM cash_in_operations WHERE id = $1',
      [event.operationId],
    );
    const currentStatus = operationStatus.rows[0]?.status ?? 'PENDING';

    await client.query(
      `INSERT INTO provider_webhook_events (
         event_id, operation_id, provider_payment_id, event_status,
         provider_sequence, occurred_at, payload, disposition
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'NO_STATE_CHANGE')`,
      [
        event.eventId,
        event.operationId,
        event.providerPaymentId,
        event.status,
        event.providerSequence,
        event.occurredAt,
        JSON.stringify(event.payload),
      ],
    );

    const applied = await applyOperationStatusInTransaction(client, {
      operationId: event.operationId,
      status: event.status,
      providerPaymentId: event.providerPaymentId,
      failureCode: event.failureCode,
      failureMessage: event.failureMessage,
      source: 'WEBHOOK',
      sourceId: event.eventId,
      details: {
        provider_sequence: event.providerSequence,
        occurred_at: event.occurredAt.toISOString(),
      },
    });
    await client.query(
      `UPDATE provider_webhook_events SET disposition = $2 WHERE event_id = $1`,
      [event.eventId, applied.disposition],
    );
    return { ...applied, duplicateEvent: false };
  });
}

export async function ensureWallet(
  pool: Pool,
  userId: string,
  currency: string,
  balanceMinor: bigint,
): Promise<void> {
  await pool.query(
    `INSERT INTO wallets (user_id, currency, balance_minor)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       currency = EXCLUDED.currency,
       balance_minor = EXCLUDED.balance_minor,
       updated_at = now()`,
    [userId, currency, balanceMinor.toString()],
  );
}

export async function getWalletBalanceMinor(pool: Pool, userId: string): Promise<bigint | null> {
  const result = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor::text FROM wallets WHERE user_id = $1',
    [userId],
  );
  const value = result.rows[0]?.balance_minor;
  return value === undefined ? null : BigInt(value);
}

export async function countProviderPayments(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM simulated_provider_payments',
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function countLedgerEntries(pool: Pool, operationId?: string): Promise<number> {
  const result = operationId
    ? await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ledger_entries WHERE operation_id = $1',
        [operationId],
      )
    : await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM ledger_entries');
  return Number(result.rows[0]?.count ?? 0);
}

export async function readOperationByKey(
  pool: Pool,
  userId: string,
  idempotencyKey: string,
): Promise<CashInOperation | null> {
  const result = await pool.query<OperationRow>(
    `SELECT ${OPERATION_COLUMNS}
     FROM cash_in_operations WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, idempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapOperation(row) : null;
}
