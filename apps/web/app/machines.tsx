'use client';
import { useEffect, useState } from 'react';
import {
  api,
  amount,
  Machine,
  Overview,
  prettyQuantity,
  Save,
} from '../lib/client';

type HistoryRow = {
  id: string;
  kind: string;
  quantity: string;
  entered_quantity: string | null;
  entered_unit: string | null;
  units_per_pack_snapshot: number | null;
  posted_at: string;
  note: string;
  product_name: string;
  item_number: number;
  from_name: string;
  to_name: string;
  reversed: boolean;
  refill_id: string | null;
  unit_price_snapshot: string | null;
};
type RefillLine = {
  key: string;
  productId: string;
  quantity: string;
  entryUnit: 'EA' | 'PACK';
};
export function Machines({
  data,
  save,
  busy,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filling, setFilling] = useState(false);
  const [lines, setLines] = useState<RefillLine[]>([]);
  const machine = data.machines.find((m) => m.id === selected);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setLoading(true);
    setHistoryError('');
    api<{ history: HistoryRow[] }>(`machines/${selected}/history`)
      .then((v) => {
        if (!cancelled) setHistory(v.history);
      })
      .catch((e) => {
        if (!cancelled) setHistoryError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, data]);
  const visible = data.machines.filter((m) =>
    `${m.machine_number} ${m.name} ${m.site_name} ${m.code}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  function open(m: Machine) {
    setSelected(m.id);
    setCreating(false);
    setEditing(false);
    setFilling(false);
  }
  return (
    <>
      <div className="panel panel-heading">
        <label className="search-label">
          Find a machine
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by machine ID, name or site"
          />
        </label>
        <button
          className="primary"
          onClick={() => {
            setCreating(true);
            setEditing(false);
            setSelected(null);
            setFilling(false);
          }}
        >
          ＋ Add machine
        </button>
      </div>
      {!creating && !machine && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Machines</h2>
            <span className="pill">{data.machines.length} MACHINES</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>MACHINE ID / NAME</th>
                  <th>SITE</th>
                  <th>PRICE TIER</th>
                  <th>STATUS</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <button
                        className="text-button machine-link"
                        onClick={() => open(m)}
                      >
                        #{m.machine_number} · {m.name}
                      </button>
                      <small>
                        {m.manufacturer} {m.model}
                      </small>
                    </td>
                    <td>{m.site_name || 'Not set'}</td>
                    <td>{m.tier_name}</td>
                    <td>
                      <span className="pill">{m.status}</span>
                    </td>
                    <td>
                      <button className="text-button" onClick={() => open(m)}>
                        Open →
                      </button>
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={5}>No machines match your search.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {(creating || editing) && (
        <MachineEditor
          key={machine?.id ?? 'new'}
          machine={editing ? machine : undefined}
          data={data}
          busy={busy}
          save={save}
          onDone={() => {
            setEditing(false);
            setCreating(false);
          }}
        />
      )}
      {machine && !creating && !editing && (
        <>
          <section className="panel form-panel">
            <div className="editor-heading">
              <div>
                <p className="eyebrow">MACHINE #{machine.machine_number}</p>
                <h2>{machine.name}</h2>
              </div>
              <div className="button-group">
                <button className="secondary" onClick={() => setSelected(null)}>
                  All machines
                </button>
                <button className="secondary" onClick={() => setEditing(true)}>
                  Edit details
                </button>
                <button
                  className="primary"
                  disabled={machine.status !== 'ACTIVE'}
                  onClick={() => {
                    setLines([]);
                    setFilling(true);
                  }}
                >
                  Fill up
                </button>
              </div>
            </div>
            <div className="machine-facts">
              <span>
                Site<strong>{machine.site_name || 'Not set'}</strong>
              </span>
              <span>
                Price tier<strong>{machine.tier_name}</strong>
              </span>
              <span>
                Serial number
                <strong>{machine.serial_number || 'Not set'}</strong>
              </span>
              <span>
                Manufacturer / model
                <strong>
                  {[machine.manufacturer, machine.model]
                    .filter(Boolean)
                    .join(' / ') || 'Not set'}
                </strong>
              </span>
            </div>
            <p className="form-hint">
              This page records deliveries and removals. Current stock and
              individual sales inside the machine are unknown.
            </p>
          </section>
          {filling && (
            <section className="panel form-panel">
              <div className="editor-heading">
                <h2>Fill up {machine.name}</h2>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setFilling(false)}
                >
                  Cancel refill
                </button>
              </div>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  const payload = {
                    sourceLocationId: f.get('sourceLocationId'),
                    note: f.get('note'),
                    lines: lines.map((l) => ({
                      productId: l.productId,
                      quantity: l.quantity,
                      entryUnit: l.entryUnit,
                      expectedUnitsPerPack: data.products.find(
                        (p) => p.id === l.productId,
                      )?.units_per_pack,
                    })),
                  };
                  if (
                    await save(
                      `machines/${machine.id}/refills`,
                      payload,
                      'Refill saved. Source stock deducted once; machine delivery history updated.',
                      true,
                    )
                  ) {
                    setFilling(false);
                    setLines([]);
                  }
                }}
              >
                <p className="form-hint">
                  Choose where these goods are being taken from. This deducts
                  stock once; it does not record a sale.
                </p>
                <label>
                  Take stock from
                  <select name="sourceLocationId" required defaultValue="">
                    <option value="" disabled>
                      Select warehouse or van
                    </option>
                    {data.locations
                      .filter(
                        (l) => l.type === 'WAREHOUSE' || l.type === 'VEHICLE',
                      )
                      .map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </label>
                {lines.map((line, index) => {
                  const product = data.products.find(
                    (p) => p.id === line.productId,
                  );
                  let total = '—';
                  if (product && /^[1-9]\d{0,14}$/.test(line.quantity))
                    total = (
                      BigInt(line.quantity) *
                      BigInt(
                        line.entryUnit === 'PACK' ? product.units_per_pack : 1,
                      )
                    ).toLocaleString('en-MU');
                  const update = (patch: Partial<RefillLine>) =>
                    setLines((v) =>
                      v.map((l) =>
                        l.key === line.key ? { ...l, ...patch } : l,
                      ),
                    );
                  return (
                    <div className="refill-line" key={line.key}>
                      <label>
                        Item {index + 1}
                        <select
                          value={line.productId}
                          required
                          onChange={(e) =>
                            update({
                              productId: e.target.value,
                              entryUnit:
                                data.products.find(
                                  (p) => p.id === e.target.value,
                                )?.default_entry_unit ?? 'EA',
                            })
                          }
                        >
                          <option value="" disabled>
                            Select product
                          </option>
                          {data.products.map((p) => (
                            <option value={p.id} key={p.id}>
                              #{p.item_number} · {p.name}
                            </option>
                          ))}
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
                        Packaging
                        <select
                          value={line.entryUnit}
                          onChange={(e) =>
                            update({
                              entryUnit: e.target.value as 'EA' | 'PACK',
                            })
                          }
                        >
                          <option value="EA">
                            {product?.unit_label ?? 'Individual units'}
                          </option>
                          <option value="PACK">
                            {product?.pack_label ?? 'Pack'} ×{' '}
                            {product?.units_per_pack ?? '?'}
                          </option>
                        </select>
                      </label>
                      <div className="line-total">
                        <strong>{total} units</strong>
                        <small>
                          {line.quantity || '0'} ×{' '}
                          {line.entryUnit === 'PACK'
                            ? (product?.units_per_pack ?? '?')
                            : 1}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Remove item ${index + 1}`}
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
                  disabled={lines.length >= 100}
                  onClick={() =>
                    setLines((v) => [
                      ...v,
                      {
                        key: crypto.randomUUID(),
                        productId: '',
                        quantity: '1',
                        entryUnit: 'PACK',
                      },
                    ])
                  }
                >
                  ＋ Add item
                </button>
                <label className="spaced-label">
                  Refill note
                  <input
                    name="note"
                    maxLength={500}
                    placeholder="Optional handover or visit reference"
                  />
                </label>
                <div className="modal-actions">
                  <button className="primary" disabled={busy || !lines.length}>
                    {busy ? 'Posting all items…' : 'Save refill'}
                  </button>
                </div>
              </form>
            </section>
          )}
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Delivery & removal history</h2>
                <p>
                  Latest 200 lines, including original records and corrections.
                  These quantities are not current machine stock.
                </p>
              </div>
            </div>
            {historyError ? (
              <div role="alert" className="alert error">
                {historyError}
              </div>
            ) : loading ? (
              <p className="empty">Loading history…</p>
            ) : history.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>DATE / ITEM</th>
                      <th>FROM → TO</th>
                      <th>ENTERED</th>
                      <th>UNITS</th>
                      <th>PRICE / UNIT AT REFILL</th>
                      <th>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>
                          <strong>
                            #{h.item_number} · {h.product_name}
                          </strong>
                          <small>
                            {new Date(h.posted_at).toLocaleString('en-GB', {
                              timeZone: data.tenant.timezone,
                            })}
                          </small>
                        </td>
                        <td>
                          {h.from_name} → {h.to_name}
                          <small>{h.note}</small>
                        </td>
                        <td>
                          {prettyQuantity(h.entered_quantity ?? h.quantity)}{' '}
                          {h.entered_unit === 'PACK'
                            ? `packs × ${h.units_per_pack_snapshot}`
                            : 'units'}
                        </td>
                        <td>{prettyQuantity(h.quantity)}</td>
                        <td>
                          {h.refill_id
                            ? amount(
                                h.unit_price_snapshot,
                                data.tenant.currency_code,
                              )
                            : 'Not recorded'}
                        </td>
                        <td>
                          <span className="pill">
                            {h.reversed
                              ? 'REVERSED'
                              : h.kind === 'REVERSAL'
                                ? 'REVERSAL'
                                : 'POSTED'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty">
                No deliveries recorded yet. Use Fill up to record the first one.
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function MachineEditor({
  machine,
  data,
  save,
  busy,
  onDone,
}: {
  machine?: Machine;
  data: Overview;
  save: Save;
  busy: boolean;
  onDone: () => void;
}) {
  return (
    <section className="panel form-panel">
      <div className="editor-heading">
        <h2>
          {machine
            ? `Edit machine #${machine.machine_number}`
            : 'Add a machine'}
        </h2>
        <button className="text-button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p>
        The machine ID is assigned automatically and remains with the physical
        machine permanently.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await save(
              machine ? `machines/${machine.id}` : 'machines',
              Object.fromEntries(new FormData(e.currentTarget)),
              machine ? 'Machine details updated.' : 'Machine created.',
            )
          )
            onDone();
        }}
      >
        <div className="form-row">
          <label>
            Machine name
            <input
              name="name"
              required
              maxLength={120}
              defaultValue={machine?.name}
              placeholder="Airport departures"
            />
          </label>
          <label>
            Site / location
            <input
              name="siteName"
              maxLength={120}
              defaultValue={machine?.site_name}
              placeholder="Airport"
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Asset code (optional)
            <input
              name="code"
              maxLength={120}
              defaultValue={
                machine?.code.startsWith('ASSET-') ? '' : machine?.code
              }
            />
          </label>
          <label>
            Serial number
            <input
              name="serialNumber"
              maxLength={120}
              defaultValue={machine?.serial_number}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Manufacturer
            <input
              name="manufacturer"
              maxLength={120}
              defaultValue={machine?.manufacturer}
            />
          </label>
          <label>
            Model
            <input name="model" maxLength={120} defaultValue={machine?.model} />
          </label>
        </div>
        <div className="form-row">
          <label>
            Price tier
            <select
              name="priceTierId"
              defaultValue={
                machine?.price_tier_id ??
                data.tiers.find((t) => t.is_default)?.id
              }
            >
              {data.tiers.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select name="status" defaultValue={machine?.status ?? 'ACTIVE'}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="MAINTENANCE">Maintenance</option>
            </select>
          </label>
        </div>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : machine ? 'Save machine' : 'Add machine'}
        </button>
      </form>
    </section>
  );
}
