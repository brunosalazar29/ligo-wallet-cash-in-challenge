import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'ligo-cash-in-challenge',
  });
}

export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original failure. The connection will be discarded by pg
      // if PostgreSQL has already closed it.
    }
    throw error;
  } finally {
    client.release();
  }
}

export type DbExecutor = Pool | PoolClient;

export function queryRows<T extends QueryResultRow>(
  executor: DbExecutor,
  sql: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return executor.query<T>(sql, [...values]);
}
