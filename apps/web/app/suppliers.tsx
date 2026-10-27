'use client';
import { useState } from 'react';
import {
  api,
  amount,
  Overview,
  Save,
  Supplier,
  SupplierProduct,
} from '../lib/client';
import { SupplierAccounts } from './supplier-account';

export function Suppliers({
  data,
  save,
  busy,
  onReceive,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
  onReceive: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const supplier = data.suppliers.find((s) => s.id === selected);
  const visible = data.suppliers.filter((s) =>
    `${s.supplier_number} ${s.legal_name} ${s.contact_name}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <section className="panel panel-heading">
        <label className="search-label">
          Find a supplier
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, contact or supplier ID"
          />
        </label>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
            setEditing(false);
            setSelected(null);
          }}
        >
          ＋ Add supplier
        </button>
      </section>
      {!supplier && !creating && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Suppliers</h2>
            <span className="pill">{data.suppliers.length} SUPPLIERS</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>ID / SUPPLIER</th>
                  <th>CONTACT</th>
                  <th>OUTSTANDING DEBT</th>
                  <th>STATUS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <button
                        className="text-button machine-link"
                        onClick={() => setSelected(s.id)}
                      >
                        #{s.supplier_number} · {s.legal_name}
                      </button>
                    </td>
                    <td>
                      {s.contact_name || 'Not set'}
                      <small>
                        {[s.phone, s.email].filter(Boolean).join(' · ')}
                      </small>
                    </td>
                    <td>{amount(s.outstanding ?? '0', s.currency)}</td>
                    <td>
                      <span className="pill">
                        {s.active ? 'ACTIVE' : 'INACTIVE'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => setSelected(s.id)}
                      >
                        Open →
                      </button>
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={5}>
                      No suppliers yet. Add one to start linking products and
                      receiving deliveries.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {(creating || editing) && (
        <SupplierEditor
          key={supplier?.id ?? 'new'}
          supplier={editing ? supplier : undefined}
          currency={data.tenant.currency_code}
          save={save}
          busy={busy}
          onDone={() => {
            setCreating(false);
            setEditing(false);
          }}
        />
      )}
      {supplier && !creating && !editing && (
        <>
          <section className="panel form-panel">
            <div className="editor-heading">
              <div>
                <p className="eyebrow">SUPPLIER #{supplier.supplier_number}</p>
                <h2>{supplier.legal_name}</h2>
              </div>
              <div className="button-group">
                <button className="secondary" onClick={() => setSelected(null)}>
                  All suppliers
                </button>
                <button className="secondary" onClick={() => setEditing(true)}>
                  Edit supplier
                </button>
                <button
                  className="primary"
                  disabled={!supplier.active}
                  onClick={() => onReceive(supplier.id)}
                >
                  Receive delivery
                </button>
              </div>
            </div>
            <div className="machine-facts">
              <span>
                Contact<strong>{supplier.contact_name || 'Not set'}</strong>
              </span>
              <span>
                Phone<strong>{supplier.phone || 'Not set'}</strong>
              </span>
              <span>
                Email<strong>{supplier.email || 'Not set'}</strong>
              </span>
              <span>
                Currency / status
                <strong>
                  {supplier.currency} ·{' '}
                  {supplier.active ? 'Active' : 'Inactive'}
                </strong>
              </span>
            </div>
            <p className="form-hint address-text">
              {supplier.address || 'No address recorded.'}
            </p>
          </section>
          <SupplierAccounts
            key={supplier.id}
            data={data}
            supplier={supplier}
            save={save}
            busy={busy}
          />
          <SupplierLinks
            data={data}
            save={save}
            busy={busy}
            supplierId={supplier.id}
          />
        </>
      )}
    </>
  );
}

function SupplierEditor({
  supplier,
  currency,
  save,
  busy,
  onDone,
}: {
  supplier?: Supplier;
  currency: string;
  save: Save;
  busy: boolean;
  onDone: () => void;
}) {
  return (
    <section className="panel form-panel">
      <div className="editor-heading">
        <h2>
          {supplier
            ? `Edit supplier #${supplier.supplier_number}`
            : 'Add a supplier'}
        </h2>
        <button className="text-button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p>
        Deactivate a supplier to stop new deliveries while keeping its history.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const values = Object.fromEntries(form);
          if (
            await save(
              supplier ? `suppliers/${supplier.id}` : 'suppliers',
              {
                ...values,
                active: form.get('active') === 'on',
                creditDays: Number(values.creditDays),
              },
              supplier ? 'Supplier updated.' : 'Supplier created.',
            )
          )
            onDone();
        }}
      >
        <div className="form-row">
          <label>
            Legal / business name
            <input
              name="legalName"
              required
              maxLength={120}
              defaultValue={supplier?.legal_name}
            />
          </label>
          <label>
            Contact person
            <input
              name="contactName"
              maxLength={120}
              defaultValue={supplier?.contact_name}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Phone
            <input
              name="phone"
              maxLength={120}
              defaultValue={supplier?.phone}
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              maxLength={254}
              defaultValue={supplier?.email}
            />
          </label>
        </div>
        <label>
          Address
          <textarea
            name="address"
            maxLength={1000}
            rows={3}
            defaultValue={supplier?.address}
          />
        </label>
        <label>
          Currency label (display only)
          <input
            name="currency"
            maxLength={24}
            defaultValue={supplier?.currency ?? currency}
          />
        </label>
        <p className="form-hint">
          Optional display text, such as SCR or Rs. It never changes amounts or
          blocks receiving.
        </p>
        <label>
          Credit term (days)
          <input
            name="creditDays"
            type="number"
            min="0"
            max="36500"
            step="1"
            required
            defaultValue={supplier?.credit_days ?? 21}
          />
        </label>
        <p className="form-hint">
          For example Apex: 30 days. New invoices use this term; existing
          recorded due dates stay unchanged.
        </p>
        <label className="checkbox-label">
          <input
            name="active"
            type="checkbox"
            defaultChecked={supplier?.active ?? true}
          />
          Active supplier
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : supplier ? 'Save supplier' : 'Add supplier'}
        </button>
      </form>
    </section>
  );
}

export function SupplierLinks({
  data,
  save,
  busy,
  supplierId,
  productId,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
  supplierId?: string;
  productId?: string;
}) {
  const [edit, setEdit] = useState<SupplierProduct | null>(null);
  const [chosenSupplier, setChosenSupplier] = useState(supplierId ?? '');
  const [chosenProduct, setChosenProduct] = useState(productId ?? '');
  const [costHistory, setCostHistory] = useState<
    | {
        unit_cost: string | null;
        pack_cost: string | null;
        units_per_order: number | null;
        currency: string;
        changed_at: string;
      }[]
    | null
  >(null);
  const [costError, setCostError] = useState('');
  const product = data.products.find(
    (p) => p.id === (productId ?? chosenProduct),
  );
  const supplier = data.suppliers.find(
    (s) => s.id === (supplierId ?? chosenSupplier),
  );
  const links = data.supplierProducts.filter(
    (l) =>
      (!supplierId || l.supplier_id === supplierId) &&
      (!productId || l.product_id === productId),
  );
  return (
    <section className="panel form-panel">
      <div className="editor-heading">
        <h2>{productId ? 'Product suppliers' : 'Supplied products'}</h2>
        {edit && (
          <button
            className="text-button"
            onClick={() => {
              setEdit(null);
              setChosenSupplier(supplierId ?? '');
              setChosenProduct(productId ?? '');
            }}
          >
            New link
          </button>
        )}
      </div>
      <p className="form-hint">
        Supplier ordering packs can differ from the product’s normal pack. Costs
        are always per individual unit; actual delivery costs are recorded
        separately.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{productId ? 'SUPPLIER' : 'PRODUCT'}</th>
              <th>ORDERING PACK</th>
              <th>COST / UNIT</th>
              <th>STATUS</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.map((l) => {
              const s = data.suppliers.find((v) => v.id === l.supplier_id);
              const p = data.products.find((v) => v.id === l.product_id);
              return (
                <tr key={l.id}>
                  <td>
                    {productId
                      ? s?.legal_name
                      : `#${p?.item_number} · ${p?.name}`}
                    <small>
                      {l.supplier_sku || 'No supplier reference'}
                      {l.lead_days != null
                        ? ` · Lead time ${l.lead_days} days`
                        : ''}
                    </small>
                  </td>
                  <td>
                    {l.order_unit} × {l.units_per_order}
                  </td>
                  <td>
                    {amount(
                      l.unit_cost,
                      s?.currency ?? data.tenant.currency_code,
                    )}
                  </td>
                  <td>
                    <span className="pill">
                      {!l.active
                        ? 'LINK INACTIVE'
                        : !s?.active
                          ? 'SUPPLIER INACTIVE'
                          : l.preferred
                            ? 'PREFERRED'
                            : 'ACTIVE'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="text-button"
                      onClick={() => {
                        setEdit(l);
                        setChosenSupplier(l.supplier_id);
                        setChosenProduct(l.product_id);
                        setCostHistory(null);
                      }}
                    >
                      Edit link
                    </button>
                    <button
                      className="text-button"
                      onClick={async () => {
                        setCostError('');
                        try {
                          setCostHistory(
                            await api(`supplier-products/${l.id}/cost-history`),
                          );
                        } catch (e) {
                          setCostError(
                            e instanceof Error
                              ? e.message
                              : 'Unable to load costs.',
                          );
                        }
                      }}
                    >
                      Cost history
                    </button>
                  </td>
                </tr>
              );
            })}
            {!links.length && (
              <tr>
                <td colSpan={5}>No supplier links yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {costError && (
        <p role="alert" className="alert error">
          {costError}
        </p>
      )}
      {costHistory && (
        <div className="cost-history">
          <h3 className="form-section">Saved supplier cost changes</h3>
          {costHistory.length ? (
            costHistory.map((h, i) => (
              <p key={i}>
                {new Date(h.changed_at).toLocaleString('en-GB', {
                  timeZone: data.tenant.timezone,
                })}{' '}
                · {amount(h.unit_cost, h.currency)} per unit{' '}
                {h.pack_cost != null
                  ? ` · ${amount(h.pack_cost, h.currency)} / pack × ${h.units_per_order}`
                  : ''}
              </p>
            ))
          ) : (
            <p>
              No changes recorded. Migrated legacy costs keep their original
              product value; earlier dates are unknown.
            </p>
          )}
        </div>
      )}
      <h3 className="form-section">
        {edit ? 'Edit supplier product' : 'Link a product and supplier'}
      </h3>
      <form
        key={`${edit?.id ?? 'new'}:${chosenSupplier}:${chosenProduct}`}
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const values = Object.fromEntries(form);
          const payload = {
            ...values,
            supplierId: supplierId ?? chosenSupplier,
            productId: productId ?? chosenProduct,
            unitsPerOrder: Number(values.unitsPerOrder),
            unitCost: values.unitCost || null,
            leadDays: values.leadDays === '' ? null : Number(values.leadDays),
            preferred: form.get('preferred') === 'on',
            active: form.get('active') === 'on',
            creditDays: Number(values.creditDays),
          };
          if (
            await save(
              'supplier-products',
              payload,
              'Supplier product link saved.',
            )
          ) {
            setEdit(null);
            setChosenSupplier(supplierId ?? '');
            setChosenProduct(productId ?? '');
            setCostHistory(null);
          }
        }}
      >
        {!supplierId && (
          <label>
            Supplier
            <select
              value={chosenSupplier}
              required
              onChange={(e) => {
                setEdit(
                  data.supplierProducts.find(
                    (l) =>
                      l.supplier_id === e.target.value &&
                      l.product_id === (productId ?? chosenProduct),
                  ) ?? null,
                );
                setChosenSupplier(e.target.value);
              }}
            >
              <option value="" disabled>
                Choose supplier
              </option>
              {data.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.legal_name}
                  {s.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
        )}
        {!productId && (
          <label>
            Product
            <select
              value={chosenProduct}
              required
              onChange={(e) => {
                setEdit(
                  data.supplierProducts.find(
                    (l) =>
                      l.product_id === e.target.value &&
                      l.supplier_id === (supplierId ?? chosenSupplier),
                  ) ?? null,
                );
                setChosenProduct(e.target.value);
              }}
            >
              <option value="" disabled>
                Choose product
              </option>
              {data.products.map((p) => (
                <option value={p.id} key={p.id}>
                  #{p.item_number} · {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="form-row">
          <label>
            Supplier product reference
            <input
              name="supplierSku"
              maxLength={120}
              defaultValue={edit?.supplier_sku}
            />
          </label>
          <label>
            Ordering unit name
            <input
              name="orderUnit"
              required
              maxLength={120}
              defaultValue={edit?.order_unit ?? product?.pack_label ?? 'Carton'}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Individual units per ordering pack
            <input
              name="unitsPerOrder"
              required
              type="number"
              min="1"
              max="1000000"
              step="1"
              defaultValue={
                edit?.units_per_order ?? product?.units_per_pack ?? 1
              }
            />
          </label>
          <label>
            Purchase cost per individual unit (
            {supplier?.currency ?? data.tenant.currency_code})
            <input
              name="unitCost"
              type="number"
              min="0"
              step="0.00000001"
              defaultValue={edit?.unit_cost ?? ''}
              placeholder="Optional until receiving"
            />
          </label>
        </div>
        <label>
          Lead time (days)
          <input
            name="leadDays"
            type="number"
            min="0"
            max="36500"
            step="1"
            defaultValue={edit?.lead_days ?? ''}
          />
        </label>
        <div className="button-group">
          <label className="checkbox-label">
            <input
              name="preferred"
              type="checkbox"
              defaultChecked={edit?.preferred ?? false}
            />
            Preferred supplier for this product
          </label>
          <label className="checkbox-label">
            <input
              name="active"
              type="checkbox"
              defaultChecked={edit?.active ?? true}
            />
            Active link
          </label>
        </div>
        <button className="primary" disabled={busy || !supplier || !product}>
          {busy ? 'Saving…' : 'Save supplier link'}
        </button>
      </form>
    </section>
  );
}
