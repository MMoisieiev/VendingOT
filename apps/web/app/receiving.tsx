'use client';
import { useEffect, useState } from 'react';
import { api, amount, Overview, Save, SupplierReceipt } from '../lib/client';

type DeliveryLine = {
  key: string;
  linkId: string;
  quantity: string;
  entryUnit: 'ORDER' | 'EA';
  unitCost: string;
};
function lineValue(quantity: string, unitCost: string, multiplier: number) {
  if (
    !/^[1-9]\d{0,14}$/.test(quantity) ||
    !/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/.test(unitCost)
  )
    return null;
  const [whole, fraction = ''] = unitCost.split('.');
  const scaled = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0'));
  return BigInt(quantity) * BigInt(multiplier) * scaled;
}
function exactAmount(scaled: bigint, currency: string) {
  const integer = scaled / 10000n;
  const fraction = (scaled % 10000n).toString().padStart(4, '0');
  return `${currency ? currency + ' ' : ''}${integer.toLocaleString('en-MU')}.${fraction}`;
}
export function Receiving({
  data,
  save,
  busy,
  initialSupplierId,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
  initialSupplierId: string;
}) {
  const [supplierId, setSupplierId] = useState(initialSupplierId);
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [receipts, setReceipts] = useState<SupplierReceipt[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const supplier = data.suppliers.find((s) => s.id === supplierId);
  const links = data.supplierProducts.filter(
    (l) => l.supplier_id === supplierId && l.active,
  );
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.tenant.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  useEffect(() => {
    let ignore = false;
    setHistoryError('');
    api<SupplierReceipt[]>('supplier-receipts')
      .then((v) => {
        if (!ignore) setReceipts(v);
      })
      .catch((e) => {
        if (!ignore) setHistoryError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [data]);
  let total = 0n;
  let validTotal = lines.length > 0;
  for (const line of lines) {
    const link = links.find((l) => l.id === line.linkId);
    const value = link
      ? lineValue(
          line.quantity,
          line.unitCost,
          line.entryUnit === 'ORDER' ? link.units_per_order : 1,
        )
      : null;
    if (value === null) validTotal = false;
    else total += value;
  }
  return (
    <>
      <section className="panel form-panel">
        <h2>Receive a supplier delivery</h2>
        <p className="form-hint">
          Record the invoice or delivery reference once, enter all products, and
          post them together. Costs below are per individual unit. Separate
          taxes and fees are not recorded here. No supplier balance, payment or
          currency conversion is calculated.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const values = Object.fromEntries(new FormData(form));
            const payload = {
              ...values,
              supplierId,
              lines: lines.map((l) => ({
                supplierProductId: l.linkId,
                quantity: l.quantity,
                entryUnit: l.entryUnit,
                expectedUnitsPerOrder: links.find((v) => v.id === l.linkId)
                  ?.units_per_order,
                unitCost: l.unitCost,
              })),
            };
            if (
              await save(
                'supplier-receipts',
                payload,
                'Delivery received. Warehouse stock and delivery history updated.',
                true,
              )
            ) {
              setLines([]);
              form.reset();
            }
          }}
        >
          <div className="form-row">
            <label>
              Supplier
              <select
                required
                value={supplierId}
                onChange={(e) => {
                  setSupplierId(e.target.value);
                  setLines([]);
                }}
              >
                <option value="" disabled>
                  Choose supplier
                </option>
                {data.suppliers
                  .filter((s) => s.active)
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.legal_name} · {s.currency}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Receive into warehouse
              <select name="warehouseId" required defaultValue="">
                <option value="" disabled>
                  Choose warehouse
                </option>
                {data.locations
                  .filter((l) => l.type === 'WAREHOUSE')
                  .map((l) => (
                    <option value={l.id} key={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Invoice / delivery reference
              <input
                name="reference"
                required
                maxLength={120}
                placeholder="INV-2026-001"
              />
            </label>
            <label>
              Received on
              <input
                name="receivedOn"
                type="date"
                required
                defaultValue={today}
              />
            </label>
          </div>
          {supplierId && !links.length && (
            <p className="form-hint">
              Link active products to this supplier in Suppliers or Products
              before receiving.
            </p>
          )}
          {lines.map((line, index) => {
            const link = links.find((l) => l.id === line.linkId);
            const p = data.products.find((p) => p.id === link?.product_id);
            const update = (patch: Partial<DeliveryLine>) =>
              setLines((v) =>
                v.map((l) => (l.key === line.key ? { ...l, ...patch } : l)),
              );
            const qty =
              /^[1-9]\d{0,14}$/.test(line.quantity) && link
                ? BigInt(line.quantity) *
                  BigInt(line.entryUnit === 'ORDER' ? link.units_per_order : 1)
                : null;
            const cost = link
              ? lineValue(
                  line.quantity,
                  line.unitCost,
                  line.entryUnit === 'ORDER' ? link.units_per_order : 1,
                )
              : null;
            return (
              <div className="delivery-line" key={line.key}>
                <label>
                  Delivery item {index + 1}
                  <select
                    value={line.linkId}
                    required
                    onChange={(e) => {
                      const chosen = links.find((l) => l.id === e.target.value);
                      update({
                        linkId: e.target.value,
                        unitCost: chosen?.unit_cost ?? '',
                        entryUnit: 'ORDER',
                      });
                    }}
                  >
                    <option value="" disabled>
                      Choose linked product
                    </option>
                    {links.map((l) => {
                      const prod = data.products.find(
                        (p) => p.id === l.product_id,
                      );
                      return (
                        <option value={l.id} key={l.id}>
                          #{prod?.item_number} · {prod?.name}
                          {l.supplier_sku ? ` (${l.supplier_sku})` : ''}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label>
                  Quantity
                  <input
                    required
                    inputMode="numeric"
                    pattern="[1-9][0-9]{0,14}"
                    value={line.quantity}
                    onChange={(e) => update({ quantity: e.target.value })}
                  />
                </label>
                <label>
                  Ordering packaging
                  <select
                    value={line.entryUnit}
                    onChange={(e) =>
                      update({ entryUnit: e.target.value as 'ORDER' | 'EA' })
                    }
                  >
                    <option value="ORDER">
                      {link?.order_unit ?? 'Pack'} ×{' '}
                      {link?.units_per_order ?? '?'}
                    </option>
                    <option value="EA">
                      {p?.unit_label ?? 'Individual units'}
                    </option>
                  </select>
                </label>
                <label>
                  Actual cost per unit (
                  {supplier?.currency ?? data.tenant.currency_code})
                  <input
                    required
                    type="text"
                    inputMode="decimal"
                    pattern="(0|[1-9][0-9]{0,14})(\.[0-9]{1,4})?"
                    value={line.unitCost}
                    onChange={(e) => update({ unitCost: e.target.value })}
                  />
                </label>
                <div className="line-total">
                  <strong>
                    {qty === null ? '—' : qty.toLocaleString('en-MU')} units
                  </strong>
                  <small>
                    {cost === null
                      ? 'Enter cost'
                      : exactAmount(
                          cost,
                          supplier?.currency ?? data.tenant.currency_code,
                        )}
                  </small>
                </div>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove delivery item ${index + 1}`}
                  onClick={() =>
                    setLines((v) => v.filter((l) => l.key !== line.key))
                  }
                >
                  Remove
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="secondary"
            disabled={
              busy || !supplier?.active || !links.length || lines.length >= 100
            }
            onClick={() =>
              setLines((v) => [
                ...v,
                {
                  key: crypto.randomUUID(),
                  linkId: '',
                  quantity: '1',
                  entryUnit: 'ORDER',
                  unitCost: '',
                },
              ])
            }
          >
            ＋ Add delivery item
          </button>
          <label className="spaced-label">
            Delivery note
            <input name="note" maxLength={500} placeholder="Optional" />
          </label>
          <div className="receipt-total">
            <div>
              <span>Recorded delivery value</span>
              <strong>
                {validTotal
                  ? exactAmount(
                      total,
                      supplier?.currency ?? data.tenant.currency_code,
                    )
                  : 'Complete the item quantities and costs'}
              </strong>
            </div>
            <button
              className="primary"
              disabled={busy || !validTotal || !supplier?.active}
            >
              {busy ? 'Receiving all items…' : 'Post delivery'}
            </button>
          </div>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Supplier delivery history</h2>
            <p>
              Latest 50 deliveries. Original quantities and costs remain visible
              after linked stock corrections.
            </p>
          </div>
        </div>
        {historyError ? (
          <p role="alert" className="alert error">
            {historyError}
          </p>
        ) : receipts.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>REFERENCE / DATE</th>
                  <th>SUPPLIER / WAREHOUSE</th>
                  <th>RECORDED VALUE</th>
                  <th>STATUS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.reference}</strong>
                      <small>{r.received_on}</small>
                    </td>
                    <td>
                      {r.supplier_name_snapshot}
                      <small>{r.warehouse_name_snapshot}</small>
                    </td>
                    <td>{amount(r.total_cost, r.currency)}</td>
                    <td>
                      <span className="pill">
                        {r.lines.some((l) => l.reversed)
                          ? 'HAS STOCK CORRECTIONS'
                          : 'POSTED'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setDetail(detail === r.id ? null : r.id)}
                      >
                        {detail === r.id ? 'Hide items' : 'View items'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No supplier deliveries recorded yet.</div>
        )}
      </section>
      {receipts
        .filter((r) => r.id === detail)
        .map((r) => (
          <section className="panel" key={r.id}>
            <div className="panel-heading">
              <div>
                <h2>{r.reference} · delivery items</h2>
                <p>
                  {r.note ||
                    'Original receipt values; corrections do not rewrite this record.'}
                </p>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>PRODUCT</th>
                    <th>RECEIVED</th>
                    <th>INDIVIDUAL UNITS</th>
                    <th>COST / UNIT</th>
                    <th>LINE TOTAL</th>
                  </tr>
                </thead>
                <tbody>
                  {r.lines.map((l) => (
                    <tr key={l.line_number}>
                      <td>
                        {l.product_name}
                        <small>
                          {l.supplier_sku}
                          {l.reversed ? ' · STOCK REVERSED' : ''}
                        </small>
                      </td>
                      <td>
                        {l.entered_quantity}{' '}
                        {l.entry_unit === 'ORDER'
                          ? `${l.order_unit} × ${l.units_per_order}`
                          : 'individual units'}
                      </td>
                      <td>{l.base_quantity}</td>
                      <td>{amount(l.unit_cost, r.currency)}</td>
                      <td>{amount(l.line_total, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </>
  );
}
