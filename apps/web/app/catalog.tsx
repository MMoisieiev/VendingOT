'use client';
import { useState } from 'react';
import { amount, Overview, Product, Save } from '../lib/client';
import { SupplierLinks } from './suppliers';

export function Catalog({
  data,
  save,
  busy,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
}) {
  const [edit, setEdit] = useState<Product | null>(null);
  const [view, setView] = useState<'list' | 'product' | 'tiers'>('list');
  const [addingTier, setAddingTier] = useState(false);
  const [search, setSearch] = useState('');
  const visible = data.products.filter((p) =>
    `${p.item_number} ${p.name} ${p.sku}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      {view === 'list' && (
        <div className="panel panel-heading">
          <label className="search-label">
            Find a product
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, SKU or item ID"
            />
          </label>
          <div className="button-group">
            <button className="secondary" onClick={() => setView('tiers')}>
              Price tiers
            </button>
            <button
              className="primary"
              onClick={() => {
                setEdit(null);
                setView('product');
              }}
            >
              ＋ Add product
            </button>
          </div>
        </div>
      )}
      {view === 'tiers' && (
        <section className="panel form-panel tier-strip">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setView('list')}
          >
            Back to products
          </button>
          <div>
            <h2>Price tiers</h2>
            <p>
              Set each product’s price separately. Machines use the tier
              assigned to them.
            </p>
            <div className="tier-list">
              {data.tiers.map((t) => (
                <span className="pill" key={t.id}>
                  {t.name}
                  {t.is_default ? ' · DEFAULT' : ''}
                </span>
              ))}
            </div>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setAddingTier(!addingTier)}
          >
            {addingTier ? 'Cancel new tier' : '＋ Add tier'}
          </button>
          {addingTier && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                if (
                  await save(
                    'price-tiers',
                    Object.fromEntries(new FormData(form)),
                    'Price tier added. Enter its prices on each product.',
                  )
                ) {
                  form.reset();
                  setAddingTier(false);
                }
              }}
            >
              <label>
                New tier name
                <input
                  name="name"
                  required
                  maxLength={120}
                  placeholder="Airport"
                />
              </label>
              <button className="secondary" disabled={busy}>
                Add tier
              </button>
            </form>
          )}
        </section>
      )}
      <div>
        {view === 'list' && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Products</h2>
              <span className="pill">{data.products.length} ITEMS</span>
            </div>
            <div className="table-scroll">
              <table className="product-table">
                <thead>
                  <tr>
                    <th>ITEM ID / PRODUCT</th>
                    <th>PACKAGING</th>
                    <th>LATEST ARRIVAL COST</th>
                    {data.tiers.map((t) => (
                      <th key={t.id}>
                        {t.name}
                        <small>Per individual unit</small>
                      </th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <strong>
                          #{p.item_number} · {p.name}
                        </strong>
                        <small>{p.sku}</small>
                      </td>
                      <td>
                        {p.pack_label} × {p.units_per_pack}
                        <small>
                          {p.unit_label} · Default:{' '}
                          {p.default_entry_unit === 'PACK'
                            ? p.pack_label
                            : p.unit_label}
                        </small>
                      </td>
                      <td>
                        {amount(p.purchase_cost, data.tenant.currency_code)}
                        <small>Per individual unit</small>
                        {p.last_purchase_pack_cost != null && (
                          <small>
                            {amount(
                              p.last_purchase_pack_cost,
                              data.tenant.currency_code,
                            )}{' '}
                            / arrival pack × {p.last_purchase_pack_size}
                          </small>
                        )}
                      </td>
                      {data.tiers.map((t) => (
                        <td key={t.id}>
                          {amount(
                            data.prices.find(
                              (v) =>
                                v.product_id === p.id &&
                                v.price_tier_id === t.id,
                            )?.amount,
                            data.tenant.currency_code,
                          )}
                        </td>
                      ))}
                      <td>
                        <button
                          className="text-button"
                          onClick={() => {
                            setEdit(p);
                            setView('product');
                          }}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!visible.length && (
                    <tr>
                      <td colSpan={data.tiers.length + 4}>
                        No products match your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
        {view === 'product' && (
          <section className="panel form-panel editor-page">
            <div className="editor-heading">
              <h2>
                {edit ? `Edit item #${edit.item_number}` : 'Add a product'}
              </h2>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setEdit(null);
                  setView('list');
                }}
              >
                Cancel
              </button>
            </div>
            <p>
              Item IDs are assigned automatically and never change. Prices and
              costs below are per individual unit.
            </p>
            <form
              key={edit?.id ?? 'new'}
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const values = Object.fromEntries(new FormData(form));
                const prices = data.tiers.flatMap((t) =>
                  values[`price:${t.id}`] !== ''
                    ? [{ tierId: t.id, amount: values[`price:${t.id}`] }]
                    : [],
                );
                for (const t of data.tiers) delete values[`price:${t.id}`];
                const payload = {
                  ...values,
                  unitsPerPack: Number(values.unitsPerPack),
                  prices,
                };
                if (
                  await save(
                    edit ? `products/${edit.id}` : 'products',
                    payload,
                    edit
                      ? 'Product updated. Existing movement quantities are preserved.'
                      : 'Product added.',
                  )
                ) {
                  setEdit(null);
                  setView('list');
                }
              }}
            >
              <label>
                Name
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={edit?.name}
                  placeholder="Water 500 ml"
                />
              </label>
              <label>
                SKU
                <input
                  name="sku"
                  required
                  maxLength={120}
                  defaultValue={edit?.sku}
                  placeholder="WATER-500"
                />
              </label>
              <div className="form-row">
                <label>
                  Individual unit name
                  <input
                    name="unitLabel"
                    required
                    maxLength={120}
                    defaultValue={edit?.unit_label ?? 'Bottle'}
                    placeholder="Bottle or packet"
                  />
                </label>
                <label>
                  Pack name
                  <input
                    name="packLabel"
                    required
                    maxLength={120}
                    defaultValue={edit?.pack_label ?? 'Pack'}
                    placeholder="Pack or carton"
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Units per pack
                  <input
                    name="unitsPerPack"
                    type="number"
                    min="1"
                    max="1000000"
                    step="1"
                    required
                    defaultValue={edit?.units_per_pack ?? 12}
                  />
                </label>
                <label>
                  Default quantity entry
                  <select
                    name="defaultEntryUnit"
                    defaultValue={edit?.default_entry_unit ?? 'PACK'}
                  >
                    <option value="PACK">Packs / cartons</option>
                    <option value="EA">Individual units</option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label>
                  Unit barcode
                  <input
                    name="barcode"
                    maxLength={120}
                    defaultValue={edit?.barcode}
                  />
                </label>
                <label>
                  Pack barcode
                  <input
                    name="packBarcode"
                    maxLength={120}
                    defaultValue={edit?.pack_barcode}
                  />
                </label>
              </div>
              <p className="form-hint">
                Supplier contacts, ordering packs and purchase costs are managed
                through supplier links below. Save a new product first, then
                select Edit to link its suppliers.
              </p>
              <h3 className="form-section">
                Selling prices · {data.tenant.currency_code} per unit
              </h3>
              <p className="form-hint">
                An empty tier price means “not set”. No markup or fallback price
                is calculated.
              </p>
              {data.tiers.map((t) => (
                <label key={t.id}>
                  {t.name}
                  {t.is_default ? ' (default)' : ''}
                  <input
                    name={`price:${t.id}`}
                    type="number"
                    min="0"
                    step="0.0001"
                    defaultValue={
                      data.prices.find(
                        (v) =>
                          v.product_id === edit?.id && v.price_tier_id === t.id,
                      )?.amount ?? ''
                    }
                    placeholder="Not set"
                  />
                </label>
              ))}
              <button className="primary" disabled={busy}>
                {busy ? 'Saving…' : edit ? 'Save product' : 'Add product'}
              </button>
            </form>
          </section>
        )}
      </div>
      {view === 'product' && edit && (
        <SupplierLinks
          key={edit.id}
          data={data}
          save={save}
          busy={busy}
          productId={edit.id}
        />
      )}
    </>
  );
}
