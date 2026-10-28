'use client';
import { useEffect, useState } from 'react';
import { api, Machine, Overview, prettyQuantity, Save } from '../lib/client';

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
type LastRefill = { id: string; posted_at: string; source_name: string };
type RefillLine = {
  key: string;
  productId: string;
  quantity: string;
  entryUnit: 'EA' | 'PACK';
};

export function Refills({
  data,
  save,
  busy,
}: {
  data: Overview;
  save: Save;
  busy: boolean;
}) {
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [filling, setFilling] = useState(false);
  const machine = data.machines.find((m) => m.id === selected);
  const visible = data.machines.filter((m) =>
    `${m.machine_number} ${m.name} ${m.site_name} ${m.code}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="refills-layout">
      <div className="refills-work">
        {machine ? (
          <RefillWorkspace
            key={machine.id}
            machine={machine}
            data={data}
            save={save}
            busy={busy}
            filling={filling}
            setFilling={setFilling}
          />
        ) : (
          <section className="panel empty">
            <h2>Select a machine</h2>
            <p>
              Choose a machine to see its recent refills or record a new one.
            </p>
          </section>
        )}
      </div>
      <section className="panel form-panel refill-machine-picker">
        <h2>Machine</h2>
        <label className="spaced-label">
          Find a machine
          <input
            value={search}
            disabled={busy || filling}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Machine ID, name or site"
          />
        </label>
        {filling && (
          <p className="form-hint">
            Save or cancel this refill before selecting another machine.
          </p>
        )}
        <div className="machine-options">
          {visible.map((m) => (
            <button
              key={m.id}
              className={`machine-option${selected === m.id ? ' selected' : ''}`}
              aria-pressed={selected === m.id}
              disabled={busy || filling}
              onClick={() => setSelected(m.id)}
            >
              <strong>
                #{m.machine_number} · {m.name}
              </strong>
              <small>
                {m.site_name || 'No site recorded'}
                {m.status !== 'ACTIVE' ? ` · ${m.status}` : ''}
              </small>
            </button>
          ))}
          {!visible.length && (
            <p className="form-hint">No machines match your search.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function RefillWorkspace({
  machine,
  data,
  save,
  busy,
  filling,
  setFilling,
}: {
  machine: Machine;
  data: Overview;
  save: Save;
  busy: boolean;
  filling: boolean;
  setFilling: (value: boolean) => void;
}) {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [latest, setLatest] = useState<LastRefill | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setHistoryError('');
    api<{ history: HistoryRow[]; latestRefill: LastRefill | null }>(
      `machines/${machine.id}/history`,
    )
      .then((v) => {
        if (!cancelled) {
          setHistory(v.history);
          setLatest(v.latestRefill);
        }
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
  }, [machine.id, data, retry]);
  return (
    <>
      <section className="panel form-panel">
        <div className="editor-heading">
          <div>
            <p className="eyebrow">MACHINE #{machine.machine_number}</p>
            <h2>{machine.name}</h2>
          </div>
          {!filling && (
            <button
              className="primary"
              disabled={busy || machine.status !== 'ACTIVE'}
              onClick={() => setFilling(true)}
            >
              ＋ New refill
            </button>
          )}
        </div>
        <p className="form-hint">
          {machine.site_name || 'No site recorded'} · {machine.tier_name}
        </p>
        <p className="last-refill">
          Last recorded refill:{' '}
          <strong>
            {loading
              ? 'Loading…'
              : historyError
                ? 'Unavailable'
                : latest
                  ? new Date(latest.posted_at).toLocaleString('en-GB', {
                      timeZone: data.tenant.timezone,
                    })
                  : 'None recorded'}
          </strong>
        </p>
        {historyError && (
          <button
            className="text-button"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry history
          </button>
        )}
      </section>
      {filling ? (
        <RefillEditor
          machine={machine}
          data={data}
          save={save}
          busy={busy}
          onDone={() => setFilling(false)}
        />
      ) : (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Refill & correction history</h2>
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
              No deliveries recorded yet. Use New refill to record the first
              one.
            </div>
          )}
        </section>
      )}
    </>
  );
}

function RefillEditor({
  machine,
  data,
  save,
  busy,
  onDone,
}: {
  machine: Machine;
  data: Overview;
  save: Save;
  busy: boolean;
  onDone: () => void;
}) {
  const [lines, setLines] = useState<RefillLine[]>([]);
  return (
    <section className="panel form-panel">
      <div className="editor-heading">
        <h2>Fill up {machine.name}</h2>
        <button className="text-button" disabled={busy} onClick={onDone}>
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
            onDone();
            setLines([]);
          }
        }}
      >
        <p className="form-hint">
          Choose where these goods are being taken from. This deducts stock
          once; it does not record a sale.
        </p>
        <label>
          Take stock from
          <select name="sourceLocationId" required defaultValue="">
            <option value="" disabled>
              Select warehouse or van
            </option>
            {data.locations
              .filter((l) => l.type === 'WAREHOUSE' || l.type === 'VEHICLE')
              .map((l) => (
                <option value={l.id} key={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </label>
        {lines.map((line, index) => {
          const product = data.products.find((p) => p.id === line.productId);
          let total = '—';
          if (product && /^[1-9]\d{0,14}$/.test(line.quantity))
            total = (
              BigInt(line.quantity) *
              BigInt(line.entryUnit === 'PACK' ? product.units_per_pack : 1)
            ).toLocaleString('en-MU');
          const update = (patch: Partial<RefillLine>) =>
            setLines((v) =>
              v.map((l) => (l.key === line.key ? { ...l, ...patch } : l)),
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
                        data.products.find((p) => p.id === e.target.value)
                          ?.default_entry_unit ?? 'EA',
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
  );
}
