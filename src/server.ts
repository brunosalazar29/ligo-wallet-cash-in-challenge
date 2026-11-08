import { loadConfig } from './config.js';
import { PaymentDispatcher } from './application/payment-dispatcher.js';
import { buildApp } from './http/app.js';
import { createPool } from './infrastructure/database.js';
import { FakePaymentProvider } from './infrastructure/payment-provider.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const provider = new FakePaymentProvider(pool, config.FAKE_PROVIDER_OUTCOME);
const dispatcher = new PaymentDispatcher(pool, provider, {
  leaseMs: config.OUTBOX_LEASE_MS,
  logger: console,
});
const app = buildApp({
  pool,
  dispatcher,
  webhookSecret: config.WEBHOOK_SECRET,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  dispatcher.stopWorker();
  await app.close();
  await pool.end();
}

try {
  await app.listen({ host: '0.0.0.0', port: config.PORT });
  dispatcher.startWorker(config.OUTBOX_POLL_INTERVAL_MS);
  app.log.info({ port: config.PORT }, 'Cash-in service started');
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
