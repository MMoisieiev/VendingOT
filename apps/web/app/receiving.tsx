'use client';
import { useEffect, useState } from 'react';
import { api, amount, Overview, Save, SupplierReceipt } from '../lib/client';
import { scaled, decimal, roundedDivide, receiptLine } from '../lib/money';
type DeliveryLine = {
  key: string;
  productId: string;
  quantity: string;
  entryUnit: 'ORDER' | 'EA';
  cost: string;
  packSize: string;
};
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
  const [invoiceTotal, setInvoiceTotal] = useState('');
  const [adjustment, setAdjustment] = useState('0');
  const [paid, setPaid] = useState(false);
  const [receipts, setReceipts] = useState<SupplierReceipt[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const supplier = data.suppliers.find((s) => s.id === supplierId);
  const products = data.products.filter((p) => !p.archived);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.tenant.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const packing = (id: string) => {
    const p = products.find((p) => p.id === id);
    const link = data.supplierProducts.find(
      (l) => l.supplier_id === supplierId && l.product_id === id,
    );
    return {
      product: p,
      link,
      size: link?.units_per_order ?? p?.units_per_pack ?? 1,
      label: link?.order_unit ?? p?.pack_label ?? 'Pack',
    };
  };
  const defaultCost = (id: string, entry: 'ORDER' | 'EA') => {
    const { product, link, size } = packing(id);
    const unit = scaled(link?.unit_cost ?? product?.purchase_cost ?? '', 8);
    const pack = scaled(link?.pack_cost ?? '', 8);
    if (entry === 'EA') return unit === null ? '' : decimal(unit, 8);
    return pack !== null
      ? decimal(roundedDivide(pack, 10000n), 4)
      : unit !== null
        ? decimal(roundedDivide(unit * BigInt(size), 10000n), 4)
        : '';
  };
  useEffect(() => {
    let ignore = false;
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
  let goods = 0n;
  let valid = lines.length > 0;
  for (const l of lines) {
    const { product, size } = packing(l.productId);
    const value = product
      ? receiptLine(l.quantity, Number(l.packSize), l.entryUnit, l.cost)
      : null;
    if (
      !value ||
      !/^[1-9]\d{0,6}$/.test(l.packSize) ||
      Number(l.packSize) > 1000000
    )
      valid = false;
    else goods += value.total;
  }
  const extra = scaled(adjustment, 2);
  const calculated = extra === null ? null : roundedDivide(goods, 100n) + extra;
  const entered = scaled(invoiceTotal, 2);
  const matches =
    valid &&
    calculated !== null &&
    calculated >= 0 &&
    entered !== null &&
    entered === calculated;
  return (
    <>
      <section className="panel form-panel">
        <h2>Receive delivery &amp; record invoice</h2>
        <p className="form-hint">
          Choose products directly—no supplier linking step is required. Posting
          adds warehouse stock, saves the supplier link, and updates each item’s
          latest arrival cost. Enter pack prices for packs, unit prices for
          individual units.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            const payload = {
              supplierId,
              warehouseId: f.get('warehouseId'),
              reference: f.get('reference'),
              receivedOn: f.get('receivedOn'),
              invoiceDate: f.get('invoiceDate'),
              ...(f.get('dueDate') ? { dueDate: f.get('dueDate') } : {}),
              note: f.get('note'),
              invoiceTotal,
              invoiceAdjustment: adjustment,
              adjustmentNote: f.get('adjustmentNote'),
              paid,
              ...(paid
                ? {
                    paymentDate: f.get('paymentDate'),
                    paymentReference: f.get('paymentReference'),
                  }
                : {}),
              lines: lines.map((l) => ({
                productId: l.productId,
                quantity: l.quantity,
                entryUnit: l.entryUnit,
                expectedUnitsPerOrder: packing(l.productId).size,
                arrivalPackSize: Number(l.packSize),
                ...(l.entryUnit === 'ORDER'
                  ? { packCost: l.cost }
                  : { unitCost: l.cost }),
              })),
            };
            if (
              await save(
                'supplier-receipts',
                payload,
                'Delivery and invoice saved. Stock, arrival costs and supplier balance updated.',
                true,
              )
            ) {
              setLines([]);
              setInvoiceTotal('');
              setAdjustment('0');
              setPaid(false);
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
                    <option key={s.id} value={s.id}>
                      {s.legal_name}
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
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Invoice / delivery reference
              <input name="reference" required maxLength={120} />
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
          <div className="form-row">
            <label>
              Invoice date
              <input
                name="invoiceDate"
                type="date"
                required
                defaultValue={today}
              />
            </label>
            <label>
              Due date override (optional)
              <input name="dueDate" type="date" />
            </label>
          </div>
          <p className="form-hint">
            Due date defaults to invoice date + {supplier?.credit_days ?? 21}{' '}
            credit days. A reminder appears two days before it is due.
          </p>
          {!products.length && (
            <p className="form-hint">Create a product under Products first.</p>
          )}
          {lines.map((l, index) => {
            const { product, link, size, label } = packing(l.productId);
            const enteredSize = Number(l.packSize);
            const value =
              /^[1-9]\d{0,6}$/.test(l.packSize) && enteredSize <= 1000000
                ? receiptLine(l.quantity, enteredSize, l.entryUnit, l.cost)
                : null;
            const update = (patch: Partial<DeliveryLine>) =>
              setLines((v) =>
                v.map((row) =>
                  row.key === l.key ? { ...row, ...patch } : row,
                ),
              );
            return (
              <div className="delivery-line" key={l.key}>
                <label>
                  Delivery item {index + 1}
                  <select
                    required
                    value={l.productId}
                    onChange={(e) =>
                      update({
                        productId: e.target.value,
                        entryUnit: 'ORDER',
                        cost: defaultCost(e.target.value, 'ORDER'),
                        packSize: String(packing(e.target.value).size),
                      })
                    }
                  >
                    <option value="" disabled>
                      Choose product
                    </option>
                    {products.map((p) => {
                      const old = data.supplierProducts.find(
                        (v) =>
                          v.product_id === p.id && v.supplier_id === supplierId,
                      );
                      return (
                        <option
                          value={p.id}
                          key={p.id}
                          disabled={old?.active === false}
                        >
                          #{p.item_number} · {p.name}
                          {old?.active === false
                            ? ' (supplier link inactive)'
                            : ''}
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
                    value={l.quantity}
                    onChange={(e) => update({ quantity: e.target.value })}
                  />
                </label>
                <label>
                  Packaging
                  <select
                    value={l.entryUnit}
                    onChange={(e) =>
                      update({
                        entryUnit: e.target.value as 'ORDER' | 'EA',
                        cost: defaultCost(
                          l.productId,
                          e.target.value as 'ORDER' | 'EA',
                        ),
                      })
                    }
                  >
                    <option value="ORDER">
                      {label} × {l.packSize || '?'}
                    </option>
                    <option value="EA">
                      {product?.unit_label ?? 'Individual units'}
                    </option>
                  </select>
                </label>
                <label>
                  Units per arrival pack
                  <input
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    required
                    value={l.packSize}
                    onChange={(e) =>
                      update({
                        packSize: e.target.value,
                        ...(l.entryUnit === 'ORDER' ? { cost: '' } : {}),
                      })
                    }
                  />
                </label>
                <label>
                  {l.entryUnit === 'ORDER'
                    ? 'Arrival cost per pack'
                    : 'Arrival cost per unit'}{' '}
                  ({supplier?.currency ?? 'SCR'})
                  <input
                    required
                    inputMode="decimal"
                    pattern={
                      l.entryUnit === 'ORDER'
                        ? '(0|[1-9][0-9]{0,14})(\\.[0-9]{1,4})?'
                        : '(0|[1-9][0-9]{0,14})(\\.[0-9]{1,8})?'
                    }
                    value={l.cost}
                    onChange={(e) => update({ cost: e.target.value })}
                  />
                </label>
                <div className="line-total">
                  <strong>
                    {value ? value.units.toLocaleString('en-MU') : '—'} units
                  </strong>
                  <small>
                    {value
                      ? amount(
                          decimal(value.total, 4),
                          supplier?.currency ?? 'SCR',
                        )
                      : 'Enter arrival cost'}
                  </small>
                  <small>
                    {value
                      ? `Unit cost ${amount(decimal(value.unitCost, 8), supplier?.currency ?? 'SCR')}`
                      : ''}
                  </small>
                  {product && !link && (
                    <small>Supplier link saved on posting</small>
                  )}
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setLines((v) => v.filter((row) => row.key !== l.key))
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
              busy ||
              !supplier?.active ||
              !products.length ||
              lines.length >= 100
            }
            onClick={() =>
              setLines((v) => [
                ...v,
                {
                  key: crypto.randomUUID(),
                  productId: '',
                  quantity: '1',
                  entryUnit: 'ORDER',
                  cost: '',
                  packSize: '',
                },
              ])
            }
          >
            ＋ Add delivery item
          </button>
          <div className="invoice-check">
            <h3 className="form-section">Check the invoice</h3>
            <p>
              Calculated goods value:{' '}
              <strong>
                {valid
                  ? amount(decimal(goods, 4), supplier?.currency ?? 'SCR')
                  : 'Add items and costs'}
              </strong>
            </p>
            <div className="form-row">
              <label>
                Invoice charges / discount
                <input
                  inputMode="decimal"
                  value={adjustment}
                  onChange={(e) => setAdjustment(e.target.value)}
                  placeholder="0; use a minus for discount"
                />
              </label>
              <label>
                Adjustment explanation
                <input
                  name="adjustmentNote"
                  maxLength={500}
                  required={extra !== null && extra !== 0n}
                  placeholder="Tax, delivery charge or discount; not added to item costs"
                />
              </label>
            </div>
            <label>
              Invoice total shown on paper
              <input
                required
                inputMode="decimal"
                value={invoiceTotal}
                onChange={(e) => setInvoiceTotal(e.target.value)}
                placeholder="Enter the total to check"
              />
            </label>
            <p
              role="status"
              className={matches ? 'invoice-match' : 'form-hint'}
            >
              {matches
                ? '✓ Invoice total matches'
                : valid && calculated !== null
                  ? `Calculated invoice total: ${amount(decimal(calculated, 2), supplier?.currency ?? 'SCR')}. Enter the matching paper total.`
                  : 'Complete the delivery items first.'}
            </p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={paid}
                onChange={(e) => setPaid(e.target.checked)}
              />
              Invoice already paid
            </label>
            {paid ? (
              <div className="form-row">
                <label>
                  Payment date
                  <input
                    name="paymentDate"
                    type="date"
                    required
                    defaultValue={today}
                  />
                </label>
                <label>
                  Payment reference
                  <input
                    name="paymentReference"
                    maxLength={120}
                    placeholder="Bank / cash reference"
                  />
                </label>
              </div>
            ) : (
              <p className="form-hint">
                This invoice will be unpaid and added to this supplier’s
                outstanding balance.
              </p>
            )}
          </div>
          <label className="spaced-label">
            Delivery note
            <input name="note" maxLength={500} />
          </label>
          <div className="receipt-total">
            <strong>
              {matches
                ? amount(invoiceTotal, supplier?.currency ?? 'SCR')
                : 'Check invoice total before posting'}
            </strong>
            <button
              className="primary"
              disabled={busy || !supplier?.active || !matches}
            >
              {busy ? 'Posting…' : 'Post delivery & invoice'}
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
                  <th>GOODS / INVOICE TOTAL</th>
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
                    <td>
                      {amount(r.invoice_total, r.currency)}
                      <small>Goods: {amount(r.total_cost, r.currency)}</small>
                    </td>
                    <td>
                      <span className="pill">
                        {r.lines.some((l) => l.reversed)
                          ? 'HAS STOCK CORRECTIONS'
                          : r.payment_status === 'UNCONFIRMED'
                            ? 'NEEDS REVIEW'
                            : r.payment_status}
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
                    <th>ARRIVAL COST / UNIT COST</th>
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
                      <td>
                        {amount(l.entered_cost ?? l.unit_cost, r.currency)}
                        <small>
                          Per {l.cost_basis === 'ORDER' ? l.order_unit : 'unit'}{' '}
                          · Unit cost {amount(l.unit_cost, r.currency)}
                        </small>
                      </td>
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
