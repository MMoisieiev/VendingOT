import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Actor, pool } from './db';
import {
  createLocation,
  createProduct,
  movementInput,
  overview,
  parse,
  postMovement,
} from './inventory';

after(async () => {
  await pool.end();
});

async function fixture() {
  const actor: Actor = { tenantId: randomUUID(), userId: randomUUID() };
  await pool.query('INSERT INTO tenants(id,name) VALUES ($1,$2)', [
    actor.tenantId,
    'Synthetic integration test',
  ]);
  await pool.query('INSERT INTO users(id,display_name) VALUES ($1,$2)', [
    actor.userId,
    'Test owner',
  ]);
  await pool.query(
    "INSERT INTO tenant_users(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')",
    [actor.tenantId, actor.userId],
  );
  const product = await createProduct(actor, {
    sku: 'WATER',
    name: 'Test water',
  });
  const supplier = (
    await pool.query(
      "INSERT INTO inventory_locations(tenant_id,code,name,type) VALUES ($1,'EXT','Supplier','EXTERNAL') RETURNING id",
      [actor.tenantId],
    )
  ).rows[0];
  const warehouse = await createLocation(actor, {
    code: 'WH',
    name: 'Warehouse',
    type: 'WAREHOUSE',
  });
  const van = await createLocation(actor, {
    code: 'VAN',
    name: 'Van',
    type: 'VEHICLE',
  });
  const machine = await createLocation(actor, {
    code: 'M',
    name: 'Machine',
    type: 'MACHINE',
  });
  const move = (
    from: string,
    to: string,
    quantity: string,
    key = randomUUID(),
  ) =>
    postMovement(actor, key, {
      kind: from === supplier.id ? 'RECEIPT' : 'TRANSFER',
      productId: product.id,
      fromLocationId: from,
      toLocationId: to,
      quantity,
      note: '',
    });
  return { actor, product, supplier, warehouse, van, machine, move };
}

test('reference stock day reconciles 75 warehouse / 0 van / 25 machine, with atomic audit and outbox', async () => {
  const f = await fixture();
  await f.move(f.supplier.id, f.warehouse.id, '100');
  await f.move(f.warehouse.id, f.van.id, '40');
  await f.move(f.van.id, f.machine.id, '25');
  await f.move(f.van.id, f.warehouse.id, '15');
  const view = await overview(f.actor);
  const quantity = (id: string) =>
    view.balances.find((b) => b.location_id === id)?.quantity;
  assert.equal(quantity(f.warehouse.id), '75.000');
  assert.equal(quantity(f.van.id), '0.000');
  assert.equal(quantity(f.machine.id), '25.000');
  assert.equal(view.movements.length, 4);
  for (const table of ['audit_events', 'domain_outbox']) {
    const count = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`,
      [f.actor.tenantId],
    );
    assert.equal(count.rows[0].n, 4);
  }
  const ledger = await pool.query(
    'SELECT sum(quantity_delta)::text AS total,count(*)::int AS n FROM inventory_ledger_entries WHERE tenant_id=$1',
    [f.actor.tenantId],
  );
  assert.equal(ledger.rows[0].total, '0.000');
  assert.equal(ledger.rows[0].n, 8);
});

test('concurrent retries post once and reusing a key with changed input fails', async () => {
  const f = await fixture();
  const key = randomUUID();
  const results = await Promise.all([
    f.move(f.supplier.id, f.warehouse.id, '10', key),
    f.move(f.supplier.id, f.warehouse.id, '10', key),
    f.move(f.supplier.id, f.warehouse.id, '10', key),
  ]);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  await assert.rejects(
    f.move(f.supplier.id, f.warehouse.id, '11', key),
    /different movement/,
  );
  assert.equal((await overview(f.actor)).movements.length, 1);
});

test('concurrent withdrawals cannot overdraw stock and a failed posting has no partial effects', async () => {
  const f = await fixture();
  await f.move(f.supplier.id, f.warehouse.id, '10');
  const results = await Promise.allSettled([
    f.move(f.warehouse.id, f.van.id, '7'),
    f.move(f.warehouse.id, f.machine.id, '7'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const view = await overview(f.actor);
  assert.equal(view.movements.length, 2);
  assert.equal(
    view.balances.find((b) => b.location_id === f.warehouse.id)?.quantity,
    '3.000',
  );
  const n = await pool.query(
    'SELECT count(*)::int AS n FROM idempotency_records WHERE tenant_id=$1',
    [f.actor.tenantId],
  );
  assert.equal(n.rows[0].n, 2);
});

test('cross-tenant product/location IDs are rejected and overview never leaks another business', async () => {
  const a = await fixture(),
    b = await fixture();
  await a.move(a.supplier.id, a.warehouse.id, '10');
  await assert.rejects(a.move(a.warehouse.id, b.van.id, '1'), /not found/);
  await assert.rejects(
    postMovement(a.actor, randomUUID(), {
      kind: 'TRANSFER',
      productId: b.product.id,
      fromLocationId: a.warehouse.id,
      toLocationId: a.van.id,
      quantity: '1',
      note: '',
    }),
    /not found/,
  );
  const view = await overview(b.actor);
  assert.equal(view.movements.length, 0);
  assert.equal(view.balances.length, 0);
  assert.equal(view.products.length, 1);
  assert.equal(view.products[0].id, b.product.id);
});

test('reversal preserves original, restores balances, and cannot repeat or overdraw', async () => {
  const f = await fixture();
  await f.move(f.supplier.id, f.warehouse.id, '10');
  const original = await f.move(f.warehouse.id, f.van.id, '7');
  await postMovement(f.actor, randomUUID(), {
    reversalOf: original.id,
    reason: 'Wrong quantity',
  });
  await assert.rejects(
    postMovement(f.actor, randomUUID(), {
      reversalOf: original.id,
      reason: 'Repeat correction',
    }),
    /already has a reversal/,
  );
  const view = await overview(f.actor);
  assert.equal(view.movements.length, 3);
  assert.equal(
    view.movements.find((m) => m.id === original.id)?.reversed,
    true,
  );
  assert.equal(
    view.balances.find((b) => b.location_id === f.warehouse.id)?.quantity,
    '10.000',
  );
  const receipt = view.movements.find((m) => m.kind === 'RECEIPT');
  await f.move(f.warehouse.id, f.van.id, '1');
  await assert.rejects(
    postMovement(f.actor, randomUUID(), {
      reversalOf: receipt!.id,
      reason: 'Cannot remove consumed stock',
    }),
    /enough stock/,
  );
});

test('database rejects posted edits, deletes, and incomplete ledger batches', async () => {
  const f = await fixture();
  const posted = await f.move(f.supplier.id, f.warehouse.id, '10');
  await assert.rejects(
    pool.query('UPDATE stock_documents SET note=$1 WHERE id=$2', [
      'tamper',
      posted.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query('DELETE FROM inventory_ledger_entries WHERE document_id=$1', [
      posted.id,
    ]),
    /immutable/,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO stock_documents(tenant_id,kind,from_location_id,to_location_id,product_id,quantity,posted_by)
    VALUES ($1,'TRANSFER',$2,$3,$4,1,$5)`,
      [
        f.actor.tenantId,
        f.warehouse.id,
        f.van.id,
        f.product.id,
        f.actor.userId,
      ],
    ),
    /two matching balanced entries/,
  );
  assert.equal((await overview(f.actor)).movements.length, 1);
});

test('API input rejects fractional, negative, oversized quantities and client tenant overrides', () => {
  const base = {
    kind: 'TRANSFER',
    productId: randomUUID(),
    fromLocationId: randomUUID(),
    toLocationId: randomUUID(),
    quantity: '1',
  };
  for (const quantity of ['0', '-1', '1.5', '1000000000000000', 'NaN'])
    assert.throws(() => parse(movementInput, { ...base, quantity }));
  assert.throws(() =>
    parse(movementInput, { ...base, tenantId: randomUUID() }),
  );
});
