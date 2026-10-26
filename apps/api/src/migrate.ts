import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool } from './db';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('vendingot:migrations'))",
    );
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = await client.query(
      "SELECT 1 FROM schema_migrations WHERE version = '001_foundation'",
    );
    if (!applied.rowCount) {
      await client.query(
        await readFile(
          resolve(__dirname, '../../../infra/001_foundation.sql'),
          'utf8',
        ),
      );
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES ('001_foundation')",
      );
    }
    await client.query('COMMIT');
    console.log('Database migrations are current.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
