import { loadDatabaseUrl } from '../config.js';
import { createPool } from '../infrastructure/database.js';
import { runMigrations } from '../infrastructure/migration-runner.js';

const pool = createPool(loadDatabaseUrl());

try {
  await runMigrations(pool);
  console.info('Database migrations applied.');
} finally {
  await pool.end();
}
