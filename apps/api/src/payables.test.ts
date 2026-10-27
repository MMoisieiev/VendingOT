import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Actor, pool } from './db';
import { createProduct } from './catalog';
import { createLocation, overview } from './inventory';
import { saveSupplier, supplierCostHistory } from './suppliers';
import { postReceipt, receiptHistory } from './receiving';
import {
  confirmInvoice,
  recordPayment,
  supplierAccount,
  clearPayment,
} from './payables';
after(async () => {
  await pool.end();
});
test('old-format deliveries create no assumed debt; review confirms a total once and keeps the stock record', async () => {
  const f = await fixture();
  const { invoiceTotal, ...legacy } = f.delivery('OLD-FORMAT');
  await postReceipt(f.actor, randomUUID(), legacy);
  let account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.unconfirmed_count, 1);
  assert.equal(Number(account.summary.outstanding), 0);
  const invoice = account.invoices[0];
  await assert.rejects(
    recordPayment(f.actor, f.supplier.id, randomUUID(), {
      invoiceIds: [invoice.id],
      paidOn: '2026-10-27',
    }),
    /Confirm legacy/,
  );
  await confirmInvoice(f.actor, f.supplier.id, invoice.id, {
    invoiceTotal: '115',
  });
  account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.outstanding, '115.00');
  assert.equal(account.invoices[0].adjustment, '15.00');
  await recordPayment(f.actor, f.supplier.id, randomUUID(), {
    invoiceIds: [invoice.id],
    paidOn: '2026-10-27',
    reference: 'Historical payment',
  });
  account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(Number(account.summary.outstanding), 0);
  assert.equal(account.invoices[0].status, 'PAID');
  assert.equal((await receiptHistory(f.actor))[0].total_cost, '100.0000');
  await assert.rejects(
    confirmInvoice(f.actor, f.supplier.id, invoice.id, { invoiceTotal: '1' }),
    /already confirmed/,
  );
});
async function fixture() {
  const actor: Actor = { tenantId: randomUUID(), userId: randomUUID() };
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [
    actor.tenantId,
    'Invoice test',
  ]);
  await pool.query('INSERT INTO users(id,display_name) VALUES($1,$2)', [
    actor.userId,
    'Test owner',
  ]);
  await pool.query(
    "INSERT INTO tenant_users(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",
    [actor.tenantId, actor.userId],
  );
  const supplier = await saveSupplier(actor, { legalName: 'Apex fixture' });
  const product = await createProduct(actor, {
    sku: 'WATER',
    name: 'Water',
    unitsPerPack: 12,
  });
  const warehouse = await createLocation(actor, {
    code: 'WH',
    name: 'Warehouse',
    type: 'WAREHOUSE',
  });
  const delivery = (reference: string, price = '100', quantity = '1') => ({
    supplierId: supplier.id,
    warehouseId: warehouse.id,
    reference,
    receivedOn: '2026-10-27',
    invoiceTotal: (Number(price) * Number(quantity)).toFixed(2),
    lines: [
      {
        productId: product.id,
        quantity,
        entryUnit: 'ORDER',
        expectedUnitsPerOrder: 12,
        packCost: price,
      },
    ],
  });
  return { actor, supplier, product, warehouse, delivery };
}
test('unlinked products receive directly; exact pack totals update current costs without rewriting past costs', async () => {
  const f = await fixture();
  await postReceipt(f.actor, randomUUID(), f.delivery('PACK-100', '100', '7'));
  let view = await overview(f.actor);
  assert.equal(view.supplierProducts.length, 1);
  assert.equal(view.products[0].purchase_cost, '8.33333333');
  assert.equal(view.products[0].last_purchase_pack_cost, '100.00000000');
  assert.equal(view.balances[0].quantity, '84.000');
  let history = await receiptHistory(f.actor);
  assert.equal(history[0].total_cost, '700.0000');
  assert.equal(history[0].invoice_total, '700.00');
  assert.equal(history[0].payment_status, 'UNPAID');
  assert.equal(history[0].lines[0].entered_cost, '100.00000000');
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('PACK-120', '120'),
    paid: true,
    paymentDate: '2026-10-27',
    paymentReference: 'CASH-1',
  });
  view = await overview(f.actor);
  assert.equal(view.products[0].purchase_cost, '10.00000000');
  assert.equal(view.supplierProducts[0].pack_cost, '120.00000000');
  history = await receiptHistory(f.actor);
  assert.equal(
    history.find((r) => r.reference === 'PACK-100').total_cost,
    '700.0000',
  );
  assert.equal(
    history.find((r) => r.reference === 'PACK-120').payment_status,
    'PAID',
  );
  const account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.outstanding, '700.00');
  assert.equal(account.summary.paid_count, 1);
  assert.equal(account.payments[0].reference, 'CASH-1');
  assert.ok(
    (await supplierCostHistory(f.actor, view.supplierProducts[0].id)).some(
      (c) => c.unit_cost === '8.33333333',
    ),
  );
});
test('arrival pack size can be entered without pre-linking and does not change the product refill pack', async () => {
  const f = await fixture();
  const input = f.delivery('ARRIVAL-24', '120');
  input.lines[0] = {
    ...input.lines[0],
    arrivalPackSize: 24,
  } as (typeof input.lines)[0];
  await postReceipt(f.actor, randomUUID(), input);
  const v = await overview(f.actor);
  assert.equal(v.balances[0].quantity, '24.000');
  assert.equal(v.products[0].units_per_pack, 12);
  assert.equal(v.products[0].purchase_cost, '5.00000000');
  assert.equal(v.products[0].last_purchase_pack_size, 24);
  assert.equal(v.supplierProducts[0].units_per_order, 24);
});
test('invoice mismatch rolls back automatic links and stock; explicit charges reconcile without changing item cost', async () => {
  const f = await fixture();
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery('BAD'),
      invoiceTotal: '101',
    }),
    /Invoice does not match/,
  );
  let view = await overview(f.actor);
  assert.equal(view.supplierProducts.length, 0);
  assert.equal(view.balances.length, 0);
  assert.equal(view.products[0].purchase_cost, null);
  await assert.rejects(
    postReceipt(f.actor, randomUUID(), {
      ...f.delivery('NO-REASON'),
      invoiceTotal: '110',
      invoiceAdjustment: '10',
    }),
    /Explain/,
  );
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('CHARGE'),
    invoiceTotal: '110',
    invoiceAdjustment: '10',
    adjustmentNote: 'Invoice delivery charge',
  });
  const account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.outstanding, '110.00');
  assert.equal(account.invoices[0].goods_total, '100.0000');
  assert.equal(account.invoices[0].adjustment, '10.00');
  view = await overview(f.actor);
  assert.equal(view.products[0].purchase_cost, '8.33333333');
});
test('paying selected invoices clears only their debt, retains records, and retries never pay twice', async () => {
  const f = await fixture();
  for (const [ref, cost] of [
    ['A', '100'],
    ['B', '200'],
    ['C', '50'],
  ])
    await postReceipt(f.actor, randomUUID(), f.delivery(ref, cost));
  let account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.outstanding, '350.00');
  const ids = account.invoices
    .filter((i) => i.reference !== 'B')
    .map((i) => i.id);
  const input = {
    invoiceIds: ids,
    paidOn: '2026-10-27',
    reference: 'BANK-123',
    note: 'Pay A and C',
  };
  const key = randomUUID();
  const results = await Promise.all([
    recordPayment(f.actor, f.supplier.id, key, input),
    recordPayment(f.actor, f.supplier.id, key, input),
  ]);
  assert.equal(results[0].id, results[1].id);
  account = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(account.summary.outstanding, '200.00');
  assert.equal(account.summary.paid_count, 2);
  assert.equal(account.invoices.length, 3);
  assert.equal(account.payments.length, 1);
  assert.equal(account.payments[0].amount, '150.00');
  assert.deepEqual(account.payments[0].invoices, ['A', 'C']);
  await assert.rejects(
    recordPayment(f.actor, f.supplier.id, randomUUID(), input),
    /already been paid/,
  );
  await assert.rejects(
    recordPayment(f.actor, f.supplier.id, key, {
      ...input,
      reference: 'Different',
    }),
    /different payment/,
  );
  await assert.rejects(
    pool.query('DELETE FROM supplier_payments WHERE id=$1', [results[0].id]),
    /immutable/,
  );
  await assert.rejects(
    pool.query('UPDATE supplier_invoices SET invoice_total=0 WHERE id=$1', [
      ids[0],
    ]),
    /immutable/,
  );
  const remaining = account.invoices.find((i) => i.reference === 'B');
  await assert.rejects(
    recordPayment(f.actor, f.supplier.id, randomUUID(), {
      ...input,
      invoiceIds: [ids[0], remaining.id],
    }),
    /already been paid/,
  );
  assert.equal(
    (await supplierAccount(f.actor, f.supplier.id)).summary.outstanding,
    '200.00',
  );
});
test('concurrent payments and cross-business IDs cannot double-settle or expose invoices', async () => {
  const f = await fixture(),
    other = await fixture();
  await postReceipt(f.actor, randomUUID(), f.delivery('ONE'));
  await postReceipt(other.actor, randomUUID(), other.delivery('OTHER'));
  const account = await supplierAccount(f.actor, f.supplier.id);
  const input = { invoiceIds: [account.invoices[0].id], paidOn: '2026-10-27' };
  const results = await Promise.allSettled([
    recordPayment(f.actor, f.supplier.id, randomUUID(), input),
    recordPayment(f.actor, f.supplier.id, randomUUID(), input),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  await assert.rejects(
    supplierAccount(f.actor, other.supplier.id),
    /not found/,
  );
  const foreign = await supplierAccount(other.actor, other.supplier.id);
  await assert.rejects(
    recordPayment(f.actor, f.supplier.id, randomUUID(), {
      ...input,
      invoiceIds: [foreign.invoices[0].id],
    }),
    /not found/,
  );
  assert.equal(
    (await supplierAccount(other.actor, other.supplier.id)).summary.outstanding,
    '100.00',
  );
});
test('a payment allocation failure rolls back every settlement and leaves debt intact', async () => {
  const f = await fixture();
  await postReceipt(f.actor, randomUUID(), f.delivery('FIRST'));
  await postReceipt(f.actor, randomUUID(), f.delivery('SECOND'));
  const account = await supplierAccount(f.actor, f.supplier.id);
  const failId = account.invoices[1].id;
  const name = 'test_payment_' + randomUUID().replaceAll('-', '');
  await pool.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.invoice_id='${failId}' THEN RAISE EXCEPTION 'Injected payment allocation failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${name} BEFORE INSERT ON supplier_payment_allocations FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  try {
    await assert.rejects(
      recordPayment(f.actor, f.supplier.id, randomUUID(), {
        invoiceIds: account.invoices.map((i) => i.id),
        paidOn: '2026-10-27',
      }),
      /allocation failure/,
    );
    const after = await supplierAccount(f.actor, f.supplier.id);
    assert.equal(after.summary.outstanding, '200.00');
    assert.equal(after.payments.length, 0);
    assert.equal(after.summary.unpaid_count, 2);
  } finally {
    await pool.query(
      `DROP TRIGGER ${name} ON supplier_payment_allocations; DROP FUNCTION ${name}()`,
    );
  }
});
test('account totals include invoices beyond the first page', async () => {
  const f = await fixture();
  for (let i = 0; i < 101; i++)
    await postReceipt(f.actor, randomUUID(), f.delivery(`PAGE-${i}`, '1'));
  const first = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(first.invoices.length, 100);
  assert.equal(first.summary.outstanding, '101.00');
  assert.ok(first.nextCursor);
  const older = await supplierAccount(f.actor, f.supplier.id, {
    cursor: first.nextCursor,
    status: 'UNPAID',
  });
  assert.equal(older.invoices.length, 1);
  assert.equal(older.summary.outstanding, '101.00');
  await recordPayment(f.actor, f.supplier.id, randomUUID(), {
    invoiceIds: [older.invoices[0].id],
    paidOn: '2026-10-27',
  });
  assert.equal(
    (await supplierAccount(f.actor, f.supplier.id)).summary.outstanding,
    '100.00',
  );
});

test('bank transfers stay outstanding until cleared; deadlines distinguish pay-now and held cash', async () => {
  const f = await fixture();
  await saveSupplier(
    f.actor,
    { legalName: 'Apex fixture', currency: 'SCR', creditDays: 30 },
    f.supplier.id,
  );
  const dates = (
    await pool.query(
      "SELECT (now() AT TIME ZONE 'Indian/Mauritius')::date::text AS today,((now() AT TIME ZONE 'Indian/Mauritius')::date-31)::text AS overdue,((now() AT TIME ZONE 'Indian/Mauritius')::date-29)::text AS soon",
    )
  ).rows[0];
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('OVERDUE', '10'),
    invoiceDate: dates.overdue,
  });
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('DUE-SOON', '20'),
    invoiceDate: dates.soon,
  });
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('HOLD', '30'),
    invoiceDate: dates.today,
  });
  let a = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(a.summary.outstanding, '60.00');
  assert.equal(a.summary.pay_now_amount, '30.00');
  assert.equal(a.summary.hold_amount, '30.00');
  assert.equal(a.summary.overdue_amount, '10.00');
  const invoice = a.invoices.find((i) => i.reference === 'DUE-SOON');
  const result = await recordPayment(f.actor, f.supplier.id, randomUUID(), {
    invoiceIds: [invoice.id],
    paidOn: dates.today,
    stage: 'IN_BANK',
    reference: 'BANK-PENDING',
  });
  a = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(a.summary.outstanding, '60.00');
  assert.equal(a.summary.in_bank_amount, '20.00');
  assert.equal(a.summary.pay_now_amount, '10.00');
  assert.equal(a.invoices.find((i) => i.id === invoice.id)?.status, 'IN_BANK');
  assert.equal(a.payments[0].stage, 'IN_BANK');
  assert.equal((await overview(f.actor)).suppliers[0].outstanding, '60.00');
  await assert.rejects(
    clearPayment(f.actor, f.supplier.id, result.id, { clearedOn: dates.soon }),
    /cannot precede/,
  );
  const clear = { clearedOn: dates.today, reference: 'BANK-CLEARED' };
  await clearPayment(f.actor, f.supplier.id, result.id, clear);
  await clearPayment(f.actor, f.supplier.id, result.id, clear);
  a = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(a.summary.outstanding, '40.00');
  assert.equal(Number(a.summary.in_bank_amount), 0);
  assert.equal(a.invoices.find((i) => i.id === invoice.id)?.status, 'PAID');
  assert.equal(
    a.invoices.find((i) => i.id === invoice.id)?.paid_on,
    dates.today,
  );
  await assert.rejects(
    clearPayment(f.actor, f.supplier.id, result.id, {
      ...clear,
      reference: 'Changed',
    }),
    /already cleared/,
  );
  assert.equal(
    (await receiptHistory(f.actor)).find((r) => r.reference === 'DUE-SOON')
      .payment_status,
    'PAID',
  );
});

test('supplier term changes affect new invoices only and explicit due dates remain recorded', async () => {
  const f = await fixture();
  await saveSupplier(
    f.actor,
    { legalName: 'Apex fixture', creditDays: 30 },
    f.supplier.id,
  );
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('TERM-30'),
    invoiceDate: '2026-10-01',
  });
  await saveSupplier(
    f.actor,
    { legalName: 'Apex fixture', creditDays: 45 },
    f.supplier.id,
  );
  await postReceipt(f.actor, randomUUID(), {
    ...f.delivery('OVERRIDE'),
    invoiceDate: '2026-10-01',
    dueDate: '2026-12-01',
  });
  const a = await supplierAccount(f.actor, f.supplier.id);
  assert.equal(
    a.invoices.find((i) => i.reference === 'TERM-30').due_on,
    '2026-10-31',
  );
  assert.equal(
    a.invoices.find((i) => i.reference === 'TERM-30').credit_days_snapshot,
    30,
  );
  assert.equal(
    a.invoices.find((i) => i.reference === 'OVERRIDE').due_on,
    '2026-12-01',
  );
  assert.equal(
    a.invoices.find((i) => i.reference === 'OVERRIDE').credit_days_snapshot,
    45,
  );
  const other = await fixture();
  await assert.rejects(
    clearPayment(other.actor, f.supplier.id, randomUUID(), {
      clearedOn: '2026-10-27',
    }),
    /not found/,
  );
});
