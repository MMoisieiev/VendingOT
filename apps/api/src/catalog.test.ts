import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Actor, pool } from './db';
import { createProduct, createTier, saveProduct, saveMachine } from './catalog';
import { createLocation, overview, postMovement } from './inventory';
import { machineHistory, postRefill } from './machines';

after(async () => {
  await pool.end();
});
async function fixture() {
  const actor: Actor = { tenantId: randomUUID(), userId: randomUUID() };
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    actor.tenantId,
    'Catalog integration test',
  ]);
  await pool.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [
    actor.userId,
    'Test owner',
  ]);
  await pool.query(
    "INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",
    [actor.tenantId, actor.userId],
  );
  const tier = (
    await pool.query(
      'SELECT * FROM price_tiers WHERE tenant_id=$1 AND is_default',
      [actor.tenantId],
    )
  ).rows[0];
  const airport = await createTier(actor, { name: 'Airport' });
  const productData = {
    sku: 'WATER',
    name: 'Water',
    unitsPerPack: 12,
    unitLabel: 'Bottle',
    packLabel: 'Pack',
    defaultEntryUnit: 'PACK',
    purchaseCost: '5.5000',
    supplierName: 'Supplier',
    prices: [
      { tierId: tier.id, amount: '10' },
      { tierId: airport.id, amount: '15' },
    ],
  };
  const product = await createProduct(actor, productData);
  const machineData = {
    name: 'Airport departures',
    siteName: 'Airport',
    manufacturer: 'Test maker',
    serialNumber: 'SERIAL-1',
    priceTierId: airport.id,
  };
  const machine = await saveMachine(actor, machineData);
  const warehouse = await createLocation(actor, {
    code: 'WH',
    name: 'Warehouse',
    type: 'WAREHOUSE',
  });
  const supplier = (
    await pool.query(
      "INSERT INTO inventory_locations(tenant_id,code,name,type) VALUES($1,'SUP','Supplier','EXTERNAL') RETURNING id",
      [actor.tenantId],
    )
  ).rows[0];
  await postMovement(actor, randomUUID(), {
    kind: 'RECEIPT',
    productId: product.id,
    fromLocationId: supplier.id,
    toLocationId: warehouse.id,
    quantity: '10',
    entryUnit: 'PACK',
    note: '',
  });
  const refill = {
    sourceLocationId: warehouse.id,
    lines: [
      {
        productId: product.id,
        quantity: '7',
        entryUnit: 'PACK',
        expectedUnitsPerPack: 12,
      },
    ],
  };
  return {
    actor,
    tier,
    airport,
    product,
    productData,
    machine,
    machineData,
    warehouse,
    supplier,
    refill,
  };
}

test('permanent sequential IDs are assigned per business; edits, database writes and clients cannot renumber them', async () => {
  const f = await fixture();
  assert.equal(f.product.item_number, 1);
  assert.equal(f.machine.machine_number, 1);
  const second = await createProduct(f.actor, { sku: 'CHIPS', name: 'Chips' });
  const secondMachine = await saveMachine(f.actor, {
    name: 'Jetty',
    priceTierId: f.tier.id,
  });
  assert.equal(second.item_number, 2);
  assert.equal(secondMachine.machine_number, 2);
  const edited = await saveProduct(
    f.actor,
    { ...f.productData, name: 'Water renamed' },
    f.product.id,
  );
  const editedMachine = await saveMachine(
    f.actor,
    { ...f.machineData, name: 'Airport renamed' },
    f.machine.id,
  );
  assert.equal(edited.item_number, 1);
  assert.equal(editedMachine.machine_number, 1);
  assert.equal(editedMachine.code, f.machine.code);
  await assert.rejects(
    saveProduct(f.actor, { ...f.productData, item_number: 99 }, f.product.id),
  );
  await assert.rejects(
    pool.query('UPDATE products SET item_number=99 WHERE id=$1', [
      f.product.id,
    ]),
    /identities cannot change/,
  );
  await assert.rejects(
    pool.query('DELETE FROM machines WHERE id=$1', [f.machine.id]),
    /Archive/,
  );
  const other = await fixture();
  assert.equal(other.product.item_number, 1);
  assert.equal(other.machine.machine_number, 1);
});

test('concurrent item creation allocates unique increasing numbers', async () => {
  const f = await fixture();
  const rows = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      createProduct(f.actor, { sku: `P-${i}`, name: `Product ${i}` }),
    ),
  );
  assert.deepEqual(
    rows.map((p) => p.item_number).sort((a, b) => a - b),
    [2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('refill converts seven packs to 84 units, posts once, and snapshots manual Airport price', async () => {
  const f = await fixture();
  const key = randomUUID();
  const results = await Promise.all([
    postRefill(f.actor, f.machine.id, key, f.refill),
    postRefill(f.actor, f.machine.id, key, f.refill),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  const view = await overview(f.actor);
  assert.equal(
    view.balances.find((b) => b.location_id === f.warehouse.id)?.quantity,
    '36.000',
  );
  assert.ok(
    view.balances.every(
      (b) => !view.machines.some((m) => m.location_id === b.location_id),
    ),
  );
  const history = await machineHistory(f.actor, f.machine.id);
  assert.equal(history.history.length, 1);
  assert.equal(history.history[0].quantity, '84.000');
  assert.equal(history.history[0].entered_quantity, '7.000');
  assert.equal(history.history[0].units_per_pack_snapshot, 12);
  assert.equal(history.history[0].unit_price_snapshot, '15.0000');
  await saveProduct(
    f.actor,
    {
      ...f.productData,
      unitsPerPack: 6,
      prices: [{ tierId: f.airport.id, amount: '18' }],
    },
    f.product.id,
  );
  const preserved = await machineHistory(f.actor, f.machine.id);
  assert.equal(preserved.history[0].quantity, '84.000');
  assert.equal(preserved.history[0].units_per_pack_snapshot, 12);
  assert.equal(preserved.history[0].unit_price_snapshot, '15.0000');
  await assert.rejects(
    postRefill(f.actor, f.machine.id, randomUUID(), f.refill),
    /pack size changed/,
  );
  await assert.rejects(
    postRefill(f.actor, f.machine.id, key, {
      ...f.refill,
      note: 'Different command',
    }),
    /different refill/,
  );
});

test('multi-item refill is all-or-nothing including ledger, audit, outbox and retry records', async () => {
  const f = await fixture();
  const before = await overview(f.actor);
  const counts = async () =>
    Promise.all(
      [
        'audit_events',
        'domain_outbox',
        'idempotency_records',
        'machine_refills',
        'machine_refill_lines',
      ].map(
        async (table) =>
          (
            await pool.query(
              `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`,
              [f.actor.tenantId],
            )
          ).rows[0].n,
      ),
    );
  const beforeCounts = await counts();
  const bad = {
    ...f.refill,
    lines: [...f.refill.lines, { ...f.refill.lines[0], quantity: '100' }],
  };
  await assert.rejects(
    postRefill(f.actor, f.machine.id, randomUUID(), bad),
    /enough stock/,
  );
  assert.deepEqual(await counts(), beforeCounts);
  assert.equal(
    (await overview(f.actor)).movements.length,
    before.movements.length,
  );
  assert.equal((await machineHistory(f.actor, f.machine.id)).history.length, 0);
});

test('tiers are explicit amounts, missing prices remain unset, and cross-business references are rejected', async () => {
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    saveMachine(f.actor, { ...f.machineData, priceTierId: other.airport.id }),
    /not found/,
  );
  await assert.rejects(
    saveProduct(
      f.actor,
      { ...f.productData, prices: [{ tierId: other.tier.id, amount: '10' }] },
      f.product.id,
    ),
    /not found/,
  );
  await assert.rejects(
    postRefill(f.actor, other.machine.id, randomUUID(), f.refill),
    /not found/,
  );
  await assert.rejects(
    postRefill(f.actor, f.machine.id, randomUUID(), {
      ...f.refill,
      sourceLocationId: other.warehouse.id,
    }),
    /not found/,
  );
  await assert.rejects(
    postRefill(f.actor, f.machine.id, randomUUID(), {
      ...f.refill,
      lines: [{ ...f.refill.lines[0], productId: other.product.id }],
    }),
    /not found/,
  );
  await assert.rejects(machineHistory(f.actor, other.machine.id), /not found/);
  await saveProduct(
    f.actor,
    { ...f.productData, prices: [{ tierId: f.tier.id, amount: '10' }] },
    f.product.id,
  );
  await postRefill(f.actor, f.machine.id, randomUUID(), f.refill);
  assert.equal(
    (await machineHistory(f.actor, f.machine.id)).history[0]
      .unit_price_snapshot,
    null,
  );
  assert.equal((await overview(f.actor)).prices[0].amount, '10.0000');
});

test('last recorded refill remains available beyond the 200-line history window and is machine-scoped', async () => {
  const f = await fixture();
  const empty = await machineHistory(f.actor, f.machine.id);
  assert.equal(empty.latestRefill, null);
  const refill = await postRefill(
    f.actor,
    f.machine.id,
    randomUUID(),
    f.refill,
  );
  await postMovement(f.actor, randomUUID(), {
    kind: 'RECEIPT',
    productId: f.product.id,
    fromLocationId: f.supplier.id,
    toLocationId: f.warehouse.id,
    quantity: '300',
    entryUnit: 'EA',
    note: '',
  });
  const machineLocation = (
    await pool.query(
      'SELECT id FROM inventory_locations WHERE tenant_id=$1 AND machine_id=$2',
      [f.actor.tenantId, f.machine.id],
    )
  ).rows[0].id;
  for (let i = 0; i < 201; i++) {
    await postMovement(f.actor, randomUUID(), {
      kind: 'TRANSFER',
      productId: f.product.id,
      fromLocationId: f.warehouse.id,
      toLocationId: machineLocation,
      quantity: '1',
      entryUnit: 'EA',
      note: 'Legacy manual delivery',
    });
  }
  const history = await machineHistory(f.actor, f.machine.id);
  assert.equal(history.history.length, 200);
  assert.ok(history.history.every((row) => row.refill_id === null));
  assert.equal(history.latestRefill.id, refill.id);
  assert.equal(history.latestRefill.source_name, 'Warehouse');
  const another = await saveMachine(f.actor, {
    name: 'Another machine',
    priceTierId: f.tier.id,
  });
  assert.equal((await machineHistory(f.actor, another.id)).latestRefill, null);
  const other = await fixture();
  await assert.rejects(
    machineHistory(other.actor, f.machine.id),
    /Machine not found/,
  );
});
