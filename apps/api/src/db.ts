import { Pool } from 'pg';

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgresql://vendingot:vendingot@127.0.0.1:5432/vendingot',
  max: 10,
});
// An idle connection can fail when the local database is restarted. New requests
// should reconnect rather than terminate the API on an unhandled pool event.
pool.on('error', (error) =>
  console.error('Idle database connection failed:', error.message),
);

// Explicit local-only identity. Production authentication must replace this context.
export const DEV_TENANT = '11111111-1111-4111-8111-111111111111';
export const DEV_USER = '22222222-2222-4222-8222-222222222222';
export type Actor = { tenantId: string; userId: string };
export const devActor: Actor = { tenantId: DEV_TENANT, userId: DEV_USER };
