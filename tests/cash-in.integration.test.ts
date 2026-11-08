import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentDispatcher } from '../src/application/payment-dispatcher.js';
import { buildApp } from '../src/http/app.js';
import { countLedgerEntries, countProviderPayments, createOrGetCashIn, getWalletBalanceMinor, readOperationByKey } from '../src/infrastructure/cash-in-repository.js';
import { runMigrations } from '../src/infrastructure/migration-runner.js';
import { createPool } from '../src/infrastructure/database.js';
import { FakePaymentProvider, type PaymentProvider } from '../src/infrastructure/payment-provider.js';
import {
  createTestContext,
  makeCashInBody,
  makeWebhookEvent,
  newIdempotencyKey,
  postWebhook,
  resetDatabase,
  TEST_CURRENCY,
  TEST_USER_ID,
  testDatabaseUrl,
} from './helpers.js';

describe('cash-in API integration', () => {
  const pool = createPool(testDatabaseUrl());
  let context: ReturnType<typeof createTestContext> | undefined;

  beforeAll(async () => {
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterEach(async () => {
    if (context) await context.app.close();
    context = undefined;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('credits a successful cash-in atomically and returns the resulting balance', async () => {
    context = createTestContext(pool);
    const key = newIdempotencyKey();
    const response = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-correlation-id']).toBeTruthy();
    expect(response.json()).toMatchObject({
      status: 'completed',
      amount: '100.00',
      currency: TEST_CURRENCY,
      new_balance: '350.00',
    });
    const view = await readOperationByKey(pool, TEST_USER_ID, key);
    expect(view?.status).toBe('SUCCEEDED');
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    expect(await countLedgerEntries(pool, view?.id)).toBe(1);
    expect(await countProviderPayments(pool)).toBe(1);
  });

  it('marks a definitive provider rejection as failed without crediting the wallet', async () => {
    context = createTestContext(pool, 'declined');
    const response = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      payload: makeCashInBody(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ status: 'failed', error: { code: 'PAYMENT_DECLINED' } });
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(25_000n);
    expect(await countLedgerEntries(pool)).toBe(0);
  });

  it('returns the existing operation for the same key and same request', async () => {
    context = createTestContext(pool);
    const key = newIdempotencyKey();
    const first = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });
    const second = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().operation_id).toBe(first.json().operation_id);
    expect(await countProviderPayments(pool)).toBe(1);
    expect(await countLedgerEntries(pool)).toBe(1);
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
  });

  it('rejects reuse of an idempotency key with a different amount', async () => {
    context = createTestContext(pool);
    const key = newIdempotencyKey();
    const first = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });
    const conflict = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody({ amount: 200 }),
    });

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await countProviderPayments(pool)).toBe(1);
    expect(await countLedgerEntries(pool)).toBe(1);
  });

  it('converges simultaneous requests from two independent app instances on one payment', async () => {
    context = createTestContext(pool);
    const secondPool = createPool(testDatabaseUrl());
    const secondContext = createTestContext(secondPool);
    const key = newIdempotencyKey();
    const payload = makeCashInBody();

    try {
      const [first, second] = await Promise.all([
        context.app.inject({
          method: 'POST',
          url: '/cash-in',
          headers: { 'Idempotency-Key': key },
          payload,
        }),
        secondContext.app.inject({
          method: 'POST',
          url: '/cash-in',
          headers: { 'Idempotency-Key': key },
          payload,
        }),
      ]);
      expect([200, 202]).toContain(first.statusCode);
      expect([200, 202]).toContain(second.statusCode);
      expect(first.json().operation_id).toBe(second.json().operation_id);

      const followUp = await context.app.inject({
        method: 'POST',
        url: '/cash-in',
        headers: { 'Idempotency-Key': key },
        payload,
      });
      expect(followUp.statusCode).toBe(200);
      expect(await countProviderPayments(pool)).toBe(1);
      expect(await countLedgerEntries(pool)).toBe(1);
      expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    } finally {
      await secondContext.app.close();
      await secondPool.end();
    }
  });

  it('recovers a charged payment after a lost response without creating a second charge', async () => {
    context = createTestContext(pool, 'timeout-after-charge');
    const key = newIdempotencyKey();
    const payload = makeCashInBody();
    const first = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload,
    });

    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('pending');
    expect(await countProviderPayments(pool)).toBe(1);
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(25_000n);

    await pool.query(
      `UPDATE payment_outbox SET available_at = now() WHERE operation_id = $1`,
      [first.json().operation_id],
    );
    const retry = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload,
    });

    expect(retry.statusCode).toBe(200);
    expect(retry.json().operation_id).toBe(first.json().operation_id);
    expect(await countProviderPayments(pool)).toBe(1);
    expect(await countLedgerEntries(pool)).toBe(1);
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
  });

  it('deduplicates a webhook event and credits the wallet once', async () => {
    context = createTestContext(pool, 'timeout-before-charge');
    const key = newIdempotencyKey();
    const pending = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });
    const event = makeWebhookEvent({ operationId: pending.json().operation_id });

    const first = await postWebhook(context.app, event);
    const duplicate = await postWebhook(context.app, event);

    expect(pending.statusCode).toBe(202);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ received: true, duplicate_event: false, status: 'completed' });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ received: true, duplicate_event: true, status: 'completed' });
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    expect(await countLedgerEntries(pool)).toBe(1);
  });

  it('ignores stale pending webhooks and records contradictory terminal outcomes for reconciliation', async () => {
    context = createTestContext(pool, 'timeout-before-charge');
    const key = newIdempotencyKey();
    const pending = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });
    const operationId = pending.json().operation_id as string;
    const success = await postWebhook(
      context.app,
      makeWebhookEvent({ operationId, eventId: 'evt_success', status: 'SUCCEEDED', providerSequence: 2 }),
    );
    const stalePending = await postWebhook(
      context.app,
      makeWebhookEvent({ operationId, eventId: 'evt_pending_old', status: 'PENDING', providerSequence: 1 }),
    );
    const contradictoryFailure = await postWebhook(
      context.app,
      makeWebhookEvent({
        operationId,
        eventId: 'evt_failure_conflict',
        status: 'FAILED',
        providerSequence: 3,
        failureCode: 'LATE_FAILURE',
      }),
    );

    expect(success.statusCode).toBe(200);
    expect(stalePending.json().status).toBe('completed');
    expect(contradictoryFailure.json().disposition).toBe('RECONCILIATION_REQUIRED');
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    expect(await countLedgerEntries(pool)).toBe(1);
    const cases = await pool.query('SELECT id FROM reconciliation_cases WHERE operation_id = $1', [operationId]);
    expect(cases.rowCount).toBe(1);
  });

  it('does not associate one provider payment with two wallet operations', async () => {
    context = createTestContext(pool, 'timeout-before-charge');
    const firstKey = newIdempotencyKey();
    const first = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': firstKey },
      payload: makeCashInBody(),
    });
    const firstEvent = makeWebhookEvent({
      operationId: first.json().operation_id,
      eventId: 'evt_provider_payment_owner',
      providerPaymentId: 'pay_shared_external_id',
    });
    await postWebhook(context.app, firstEvent);

    const secondKey = newIdempotencyKey();
    const second = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': secondKey },
      payload: makeCashInBody(),
    });
    const secondEvent = makeWebhookEvent({
      operationId: second.json().operation_id,
      eventId: 'evt_provider_payment_reused',
      providerPaymentId: 'pay_shared_external_id',
    });
    const response = await postWebhook(context.app, secondEvent);

    expect(response.statusCode).toBe(200);
    expect(response.json().disposition).toBe('RECONCILIATION_REQUIRED');
    expect(response.json().status).toBe('pending');
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    expect(await countLedgerEntries(pool)).toBe(1);
    const cases = await pool.query('SELECT id FROM reconciliation_cases');
    expect(cases.rowCount).toBe(1);
  });

  it('handles a webhook racing with the synchronous provider response with one ledger credit', async () => {
    const provider = new FakePaymentProvider(pool, 'success');
    let notifyStarted: (() => void) | undefined;
    let releaseProvider: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const delayedProvider: PaymentProvider = {
      async charge(request) {
        const result = await provider.charge(request);
        notifyStarted?.();
        await gate;
        return result;
      },
    };
    const raceDispatcher = new PaymentDispatcher(
      pool,
      delayedProvider,
      { leaseMs: 5_000, logger: { warn() {}, error() {} } },
    );
    const raceApp = buildApp({
      pool,
      dispatcher: raceDispatcher,
      webhookSecret: 'integration-test-secret-with-enough-length',
      logger: false,
    });
    context = { pool, app: raceApp, provider, dispatcher: raceDispatcher };
    const key = newIdempotencyKey();
    const requestPromise = raceApp.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });

    await started;
    const operation = await readOperationByKey(pool, TEST_USER_ID, key);
    expect(operation).not.toBeNull();
    const callback = await postWebhook(
      raceApp,
      makeWebhookEvent({ operationId: operation?.id ?? '', eventId: 'evt_race_success' }),
    );
    releaseProvider?.();
    const response = await requestPromise;

    expect(callback.statusCode).toBe(200);
    expect(response.statusCode).toBe(200);
    expect(await countProviderPayments(pool)).toBe(1);
    expect(await countLedgerEntries(pool)).toBe(1);
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
  });

  it('recovers a pending outbox operation after a new app pool starts', async () => {
    context = createTestContext(pool, 'timeout-after-charge');
    const key = newIdempotencyKey();
    const first = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': key },
      payload: makeCashInBody(),
    });
    expect(first.statusCode).toBe(202);
    const operationId = first.json().operation_id as string;
    await context.app.close();
    context = undefined;

    const restartedPool = createPool(testDatabaseUrl());
    const restartedContext = createTestContext(restartedPool, 'success');
    try {
      await restartedPool.query(
        `UPDATE payment_outbox
         SET available_at = now(), locked_by = NULL, locked_until = NULL
         WHERE operation_id = $1`,
        [operationId],
      );
      await restartedContext.dispatcher.runOnce();
      const recovered = await restartedContext.app.inject({
        method: 'POST',
        url: '/cash-in',
        headers: { 'Idempotency-Key': key },
        payload: makeCashInBody(),
      });

      expect(recovered.statusCode).toBe(200);
      expect(recovered.json().operation_id).toBe(operationId);
      expect(await countProviderPayments(pool)).toBe(1);
      expect(await countLedgerEntries(pool)).toBe(1);
      expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(35_000n);
    } finally {
      await restartedContext.app.close();
      await restartedPool.end();
    }
  });

  it('dispatches a persisted outbox item after a crash before the provider call', async () => {
    const key = newIdempotencyKey();
    const created = await createOrGetCashIn(pool, {
      userId: TEST_USER_ID,
      idempotencyKey: key,
      requestHash: 'a'.repeat(64),
      amountMinor: 10_000n,
      currency: TEST_CURRENCY,
      paymentMethod: 'card_xyz',
    });
    expect(created.created).toBe(true);
    expect(created.operation.status).toBe('PENDING');
    expect(await countProviderPayments(pool)).toBe(0);

    const restartedPool = createPool(testDatabaseUrl());
    const restartedContext = createTestContext(restartedPool, 'success');
    try {
      await restartedContext.dispatcher.runOnce();
      const recovered = await readOperationByKey(restartedPool, TEST_USER_ID, key);
      expect(recovered?.status).toBe('SUCCEEDED');
      expect(await countProviderPayments(restartedPool)).toBe(1);
      expect(await countLedgerEntries(restartedPool, created.operation.id)).toBe(1);
      expect(await getWalletBalanceMinor(restartedPool, TEST_USER_ID)).toBe(35_000n);
    } finally {
      await restartedContext.app.close();
      await restartedPool.end();
    }
  });

  it('rejects invalid and expired webhook signatures', async () => {
    context = createTestContext(pool);
    const event = makeWebhookEvent({ operationId: randomUUID() });
    const expired = String(Math.floor(Date.now() / 1000) - 600);
    const response = await postWebhook(context.app, event, { timestamp: expired });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
  });

  it('keeps money exact in minor units for decimal input', async () => {
    context = createTestContext(pool);
    const response = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      payload: makeCashInBody({ amount: '0.10' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ amount: '0.10', new_balance: '250.10' });
    expect(await getWalletBalanceMinor(pool, TEST_USER_ID)).toBe(25_010n);
  });

  it('rejects an invalid currency without creating an operation', async () => {
    context = createTestContext(pool);
    const response = await context.app.inject({
      method: 'POST',
      url: '/cash-in',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      payload: makeCashInBody({ currency: 'PENX' }),
    });
    expect(response.statusCode).toBe(400);
    expect(await pool.query('SELECT id FROM cash_in_operations')).toMatchObject({ rowCount: 0 });
  });
});
