import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Actor, pool } from './db';
import { createProduct, saveProduct } from './catalog';
import { createLocation, overview, postMovement } from './inventory';
import {
  saveSupplier,
  saveSupplierProduct,
  supplierCostHistory,
} from './suppliers';
import { postReceipt, receiptHistory } from './receiving';

after(async () => {
  await pool.end();
});
async function fixture() {
  const actor: Actor = { tenantId: randomUUID(), userId: randomUUID() };
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    actor.tenantId,
    'Receiving test',
  ]);
  await pool.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [
    actor.userId,
    'Test owner',
  ]);
  await pool.query(
    "INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",
    [actor.tenantId, actor.userId],
  );
  const supplierData = {
    legalName: 'Test supplier',
    contactName: 'Contact',
    phone: '123',
    email: 'test@example.com',
    address: 'Test address',
    currency: 'SCR',
  };
  const supplier = await saveSupplier(actor, supplierData);
  const productData = { sku: 'WATER', name: 'Water', unitsPerPack: 12 };
  const product = await createProduct(actor, productData);
  const linkData = {
    supplierId: supplier.id,
    productId: product.id,
    supplierSku: 'SUP-W',
    orderUnit: 'Carton',
    unitsPerOrder: 24,
    unitCost: '5.25',
    leadDays: 3,
    preferred: true,
  };
  const link = await saveSupplierProduct(actor, linkData);
  const warehouse = await createLocation(actor, {
    code: 'WH',
    name: 'Warehouse',
    type: 'WAREHOUSE',
  });
  const delivery = {
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    reference: 'INV-001',
    receivedOn: '2026-10-27',
    lines: [
      {
        supplierProductId: link.id,
        quantity: '2',
        entryUnit: 'ORDER',
        expectedUnitsPerOrder: 24,
        unitCost: '5.25',
      },
    ],
  };
  return {
    actor,
    supplier,
    supplierData,
    product,
    productData,
    link,
    linkData,
    warehouse,
    delivery,
  };
}

test('supplier identities, contacts, preferred links and cost histories survive editing and deactivation', async () => {
  const f = await fixture();
  assert.equal(f.supplier.supplier_number, 1);
  const second = await saveSupplier(f.actor, {
    legalName: 'Other supplier',
    currency: 'SCR',
  });
  assert.equal(second.supplier_number, 2);
  const otherLink = await saveSupplierProduct(f.actor, {
    ...f.linkData,
    supplierId: second.id,
    unitCost: '6',
    preferred: true,
  });
  const view = await overview(f.actor);
  assert.equal(view.supplierProducts.filter((l) => l.preferred).length, 1);
  assert.equal(
    view.supplierProducts.find((l) => l.id === f.link.id)?.preferred,
    false,
  );
  await saveSupplierProduct(f.actor, { ...f.linkData, unitCost: '5.7500' });
  await saveSupplierProduct(f.actor, { ...f.linkData, unitCost: '5.75' });
  const costs = await supplierCostHistory(f.actor, f.link.id);
  assert.equal(costs.length, 2);
  assert.equal(costs[0].unit_cost, '5.75000000');
  assert.equal(costs[1].unit_cost, '5.25000000');
  const edited = await saveSupplier(
    f.actor,
    { ...f.supplierData, legalName: 'Renamed supplier', active: false },
    f.supplier.id,
  );
  assert.equal(edited.supplier_number, 1);
  assert.equal(edited.contact_name, 'Contact');
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), f.delivery),
    /inactive/,
  );
  const relabelled = await saveSupplier(
    f.actor,
    { ...f.supplierData, currency: 'Rs (display)' },
    f.supplier.id,
  );
  assert.equal(relabelled.currency, 'Rs (display)');
  await assert.rejects(
    pool.query('UPDATE suppliers SET supplier_number=99 WHERE id=$1', [
      f.supplier.id,
    ]),
    /identity cannot change/,
  );
  await assert.rejects(
    pool.query('DELETE FROM suppliers WHERE id=$1', [f.supplier.id]),
    /Deactivate/,
  );
  await assert.rejects(
    pool.query(
      'DELETE FROM supplier_cost_history WHERE supplier_product_id=$1',
      [otherLink.id],
    ),
    /immutable/,
  );
});

test('delivery uses supplier carton size, snapshots actual costs and adds stock once under concurrent retries', async () => {
  const f = await fixture();
  const key = randomUUID();
  const results = await Promise.all([
    postReceipt(f.actor, key, f.delivery),
    postReceipt(f.actor, key, f.delivery),
    postReceipt(f.actor, key, f.delivery),
  ]);
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  let view = await overview(f.actor);
  assert.equal(
    view.balances.find((b) => b.location_id === f.warehouse.id)?.quantity,
    '48.000',
  );
  let history = await receiptHistory(f.actor);
  assert.equal(history.length, 1);
  assert.equal(history[0].total_cost, '252.0000');
  assert.equal(history[0].lines[0].base_quantity, '48.000');
  assert.equal(history[0].lines[0].units_per_order, 24);
  assert.equal(history[0].lines[0].unit_cost, '5.25000000');
  await saveSupplier(
    f.actor,
    { ...f.supplierData, legalName: 'New legal name' },
    f.supplier.id,
  );
  await saveProduct(
    f.actor,
    { ...f.productData, name: 'New product name', unitsPerPack: 6 },
    f.product.id,
  );
  await saveSupplierProduct(f.actor, {
    ...f.linkData,
    orderUnit: 'Crate',
    unitsPerOrder: 36,
    unitCost: '8',
  });
  history = await receiptHistory(f.actor);
  assert.equal(history[0].supplier_name_snapshot, 'Test supplier');
  assert.equal(history[0].lines[0].product_name, 'Water');
  assert.equal(history[0].lines[0].order_unit, 'Carton');
  assert.equal(history[0].total_cost, '252.0000');
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), { ...f.delivery, reference: 'INV-002' }),
    /pack size changed/,
  );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      reference: ' inv-001 ',
    }),
    /already been received/,
  );
  await assert.rejects(
    postReceipt(f.actor, key, { ...f.delivery, note: 'Changed payload' }),
    /different delivery/,
  );
  const source = view.locations.find((l) => l.supplier_id === f.supplier.id)!;
  await assert.rejects(
    postMovement(f.actor, randomUUID(), {
      kind: 'RECEIPT',
      productId: f.product.id,
      fromLocationId: source.id,
      toLocationId: f.warehouse.id,
      quantity: '1',
      note: '',
    }),
    /supplier receiving/,
  );
});

test('mixed ordering packs and individual units keep exact totals; delivery corrections preserve original values', async () => {
  const f = await fixture();
  const input = {
    ...f.delivery,
    lines: [
      { ...f.delivery.lines[0], quantity: '1', unitCost: '0.1' },
      {
        ...f.delivery.lines[0],
        quantity: '3',
        entryUnit: 'EA',
        unitCost: '0.2',
      },
    ],
  };
  await postReceipt(f.actor, randomUUID(), input);
  let history = await receiptHistory(f.actor);
  assert.equal(history[0].total_cost, '3.0000');
  assert.equal(history[0].lines[0].line_total, '2.4000');
  assert.equal(history[0].lines[1].line_total, '0.6000');
  const view = await overview(f.actor);
  assert.equal(view.balances[0].quantity, '27.000');
  await postMovement(f.actor, randomUUID(), {
    reversalOf: view.movements[0].id,
    reason: 'Wrong delivery line',
  });
  history = await receiptHistory(f.actor);
  assert.equal(history[0].total_cost, '3.0000');
  assert.equal(
    history[0].lines.filter((l: { reversed: boolean }) => l.reversed).length,
    1,
  );
  await assert.rejects(
    pool.query('UPDATE supplier_receipts SET total_cost=0 WHERE id=$1', [
      history[0].id,
    ]),
    /immutable/,
  );
});

test('late stock-posting failure rolls back delivery, first line, ledger, audit, outbox and retry records', async () => {
  const f = await fixture();
  const second = await createProduct(f.actor, {
    sku: 'SECOND',
    name: 'Second product',
  });
  const link = await saveSupplierProduct(f.actor, {
    ...f.linkData,
    productId: second.id,
    preferred: false,
  });
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `test_receipt_${suffix}`;
  const counts = async () =>
    Promise.all(
      [
        'stock_documents',
        'inventory_ledger_entries',
        'supplier_receipts',
        'supplier_receipt_lines',
        'idempotency_records',
        'audit_events',
        'domain_outbox',
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
  const before = await counts();
  await pool.query(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.actor.tenantId}' AND NEW.product_id='${second.id}' THEN RAISE EXCEPTION 'Injected second-line database failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${trigger} BEFORE INSERT ON stock_documents FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
  );
  try {
    await assert.rejects(
      postReceipt(f.actor, randomUUID(), {
        ...f.delivery,
        lines: [
          ...f.delivery.lines,
          { ...f.delivery.lines[0], supplierProductId: link.id },
        ],
      }),
      /second-line database failure/,
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await pool.query(
      `DROP TRIGGER ${trigger} ON stock_documents; DROP FUNCTION ${trigger}()`,
    );
  }
});

test('cross-business, inactive links and invalid input cannot post deliveries', async () => {
  const f = await fixture(),
    other = await fixture();
  await assert.rejects(
    saveSupplierProduct(f.actor, {
      ...f.linkData,
      productId: other.product.id,
    }),
    /not found/,
  );
  await assert.rejects(
    saveSupplierProduct(f.actor, {
      ...f.linkData,
      supplierId: other.supplier.id,
    }),
    /not found/,
  );
  await assert.rejects(
    supplierCostHistory(f.actor, other.link.id),
    /not found/,
  );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      supplierId: other.supplier.id,
    }),
    /not found/,
  );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      warehouseId: other.warehouse.id,
    }),
    /not found/,
  );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      lines: [{ ...f.delivery.lines[0], supplierProductId: other.link.id }],
    }),
    /not linked/,
  );
  await saveSupplierProduct(f.actor, {
    ...f.linkData,
    active: false,
    preferred: false,
  });
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), f.delivery),
    /inactive/,
  );
  for (const unitCost of ['-1', 'NaN', '1.12345'])
    await assert.rejects(
      postReceipt(f.actor, randomUUID(), {
        ...f.delivery,
        lines: [{ ...f.delivery.lines[0], unitCost }],
      }),
    );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      tenantId: other.actor.tenantId,
    }),
  );
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery,
      receivedOn: '2026-02-30',
    }),
  );
  assert.equal((await receiptHistory(f.actor)).length, 0);
  assert.equal((await receiptHistory(other.actor)).length, 0);
});

test('currency is optional display text: different labels and edits never block or convert amounts', async () => {
  const f = await fixture();
  assert.equal((await overview(f.actor)).tenant.currency_code, 'SCR');
  const changed = await saveSupplier(
    f.actor,
    { ...f.supplierData, currency: 'Rupees / display' },
    f.supplier.id,
  );
  assert.equal(changed.currency, 'Rupees / display');
  await postReceipt(f.actor, randomUUID(), f.delivery);
  let history = await receiptHistory(f.actor);
  assert.equal(history[0].currency, 'Rupees / display');
  assert.equal(history[0].total_cost, '252.0000');
  await saveSupplier(
    f.actor,
    { ...f.supplierData, currency: '' },
    f.supplier.id,
  );
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery,
    reference: 'INV-EMPTY-LABEL',
  });
  history = await receiptHistory(f.actor);
  assert.equal(
    history.find((r) => r.reference === 'INV-EMPTY-LABEL').currency,
    '',
  );
  assert.ok(history.every((r) => r.total_cost === '252.0000'));
  const defaulted = await saveSupplier(f.actor, {
    legalName: 'Default label supplier',
  });
  assert.equal(defaulted.currency, 'SCR');
  const costs = await supplierCostHistory(f.actor, f.link.id);
  assert.equal(costs[0].unit_cost, '5.25000000');
});
