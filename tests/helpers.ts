import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PaymentDispatcher } from '../src/application/payment-dispatcher.js';
import { buildApp } from '../src/http/app.js';
import { createWebhookSignature } from '../src/http/webhook-signature.js';
import { createPool } from '../src/infrastructure/database.js';
import { FakePaymentProvider, type FakeProviderScenario } from '../src/infrastructure/payment-provider.js';

export const WEBHOOK_SECRET = 'integration-test-secret-with-enough-length';
export const TEST_USER_ID = 'usr_abc123';
export const TEST_CURRENCY = 'PEN';

export function testDatabaseUrl(): string {
  const testUrl = process.env.TEST_DATABASE_URL ?? 'postgres://challenge:challenge@127.0.0.1:5433/ligo_cash_in_test';
  const appUrl = process.env.DATABASE_URL;
  if (appUrl) {
    const testTarget = new URL(testUrl);
    const appTarget = new URL(appUrl);
    const normalizeHost = (host: string) =>
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase())
        ? 'loopback'
        : host.toLowerCase();
    const normalizePort = (url: URL) =>
      url.port || (url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? '5432' : '');
    if (
      normalizeHost(testTarget.hostname) === normalizeHost(appTarget.hostname) &&
      normalizePort(testTarget) === normalizePort(appTarget) &&
      testTarget.pathname === appTarget.pathname
    ) {
      throw new Error('TEST_DATABASE_URL must point to a different database than DATABASE_URL');
    }
  }
  return testUrl;
}

export async function createTestPool(): Promise<Pool> {
  return createPool(testDatabaseUrl());
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      reconciliation_cases,
      provider_webhook_events,
      ledger_entries,
      payment_outbox,
      cash_in_operations,
      simulated_provider_payments,
      wallets
    CASCADE
  `);
  await pool.query(
    `INSERT INTO wallets (user_id, currency, balance_minor)
     VALUES ($1, $2, 25000)`,
    [TEST_USER_ID, TEST_CURRENCY],
  );
}

export interface TestContext {
  pool: Pool;
  app: FastifyInstance;
  provider: FakePaymentProvider;
  dispatcher: PaymentDispatcher;
}

export function createTestContext(
  pool: Pool,
  outcome: FakeProviderScenario = 'success',
): TestContext {
  const provider = new FakePaymentProvider(pool, outcome);
  const dispatcher = new PaymentDispatcher(pool, provider, {
    leaseMs: 5_000,
    logger: { warn() {}, error() {} },
  });
  const app = buildApp({ pool, dispatcher, webhookSecret: WEBHOOK_SECRET, logger: false });
  return { pool, app, provider, dispatcher };
}

export interface CashInBody {
  user_id?: string;
  amount?: number | string;
  currency?: string;
  payment_method?: string;
}

export function makeCashInBody(overrides: CashInBody = {}) {
  return {
    user_id: TEST_USER_ID,
    amount: 100,
    currency: TEST_CURRENCY,
    payment_method: 'card_xyz',
    ...overrides,
  };
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

export function makeWebhookEvent(input: {
  operationId: string;
  eventId?: string;
  status?: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  providerPaymentId?: string | null;
  providerSequence?: number;
  occurredAt?: string;
  failureCode?: string;
  failureMessage?: string;
}) {
  return {
    event_id: input.eventId ?? `evt_${randomUUID()}`,
    operation_id: input.operationId,
    provider_payment_id: input.providerPaymentId ?? 'pay_test_123',
    status: input.status ?? 'SUCCEEDED',
    provider_sequence: input.providerSequence ?? 1,
    occurred_at: input.occurredAt ?? new Date().toISOString(),
    ...(input.failureCode ? { failure_code: input.failureCode } : {}),
    ...(input.failureMessage ? { failure_message: input.failureMessage } : {}),
  } as const;
}

export async function postWebhook(
  app: FastifyInstance,
  event: ReturnType<typeof makeWebhookEvent>,
  options: { timestamp?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(event);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature ?? createWebhookSignature(rawBody, timestamp, WEBHOOK_SECRET);
  return app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      'x-payment-timestamp': timestamp,
      'x-payment-signature': signature,
    },
    payload: rawBody,
  });
}
