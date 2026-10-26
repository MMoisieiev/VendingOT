import { pool, DEV_TENANT, DEV_USER } from './db';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO tenants(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [DEV_TENANT, 'Island Vending · Development'],
    );
    await client.query(
      'INSERT INTO users(id,display_name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [DEV_USER, 'Local development owner'],
    );
    await client.query(
      "INSERT INTO tenant_users(tenant_id,user_id,role) VALUES ($1,$2,'OWNER') ON CONFLICT DO NOTHING",
      [DEV_TENANT, DEV_USER],
    );
    await client.query(
      "INSERT INTO products(tenant_id,sku,name) VALUES ($1,'WATER-500','Water · 500 ml') ON CONFLICT DO NOTHING",
      [DEV_TENANT],
    );
    await client.query(
      "INSERT INTO machines(tenant_id,code,name) VALUES ($1,'M-001','Demo machine') ON CONFLICT DO NOTHING",
      [DEV_TENANT],
    );
    for (const [code, name, type] of [
      ['SUPPLIER', 'External supply', 'EXTERNAL'],
      ['WH-001', 'Main warehouse', 'WAREHOUSE'],
      ['VAN-001', 'Delivery van 01', 'VEHICLE'],
    ]) {
      await client.query(
        'INSERT INTO inventory_locations(tenant_id,code,name,type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [DEV_TENANT, code, name, type],
      );
    }
    await client.query(
      `INSERT INTO inventory_locations(tenant_id,code,name,type,machine_id)
      SELECT tenant_id,code,name,'MACHINE',id FROM machines WHERE tenant_id=$1 AND code='M-001' ON CONFLICT DO NOTHING`,
      [DEV_TENANT],
    );
    await client.query('COMMIT');
    console.log(
      'Synthetic development records seeded. Stock starts at zero; existing records preserved.',
    );
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
