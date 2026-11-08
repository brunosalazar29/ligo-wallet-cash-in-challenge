import { loadDatabaseUrl } from '../config.js';
import { createPool } from '../infrastructure/database.js';

const pool = createPool(loadDatabaseUrl());

try {
  await pool.query(
    `INSERT INTO wallets (user_id, currency, balance_minor)
     VALUES ($1, 'PEN', 25000)
     ON CONFLICT (user_id) DO NOTHING`,
    ['usr_abc123'],
  );
  console.info('Demo wallet ready: usr_abc123 (PEN 250.00 initial balance).');
} finally {
  await pool.end();
}
