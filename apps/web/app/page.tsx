'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { api, Overview, Movement, prettyQuantity } from '../lib/client';
import { Catalog } from './catalog';
import { Machines } from './machines';
import { Suppliers } from './suppliers';
import { Receiving } from './receiving';
type Tab =
  | 'Overview'
  | 'Inventory'
  | 'Products'
  | 'Locations'
  | 'Machines'
  | 'Suppliers'
  | 'Receiving';

const locationType = (type: string) =>
  ({
    WAREHOUSE: 'Warehouse',
    VEHICLE: 'Vehicle',
    MACHINE: 'Machine',
    EXTERNAL: 'External supply',
  })[type] ?? type;

export default function Home() {
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [receivingSupplier, setReceivingSupplier] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showMovement, setShowMovement] = useState(false);
  const [kind, setKind] = useState('RECEIPT');
  const [movementProductId, setMovementProductId] = useState('');
  const [movementQuantity, setMovementQuantity] = useState('');
  const [movementUnit, setMovementUnit] = useState('EA');
  const [reverse, setReverse] = useState<Movement | null>(null);
  // Preserve the key after an uncertain network result; changing the payload creates a new command.
  const command = useRef<{ payload: string; key: string } | null>(null);
  const load = useCallback(async () => {
    setData(await api<Overview>('overview'));
  }, []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    if (!showMovement && !reverse) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select',
        ) ?? [],
      );
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !dialog?.querySelector('button:disabled')) {
        setShowMovement(false);
        setReverse(null);
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previous?.focus();
    };
  }, [showMovement, reverse]);

  async function save(
    path: string,
    payload: unknown,
    message: string,
    idempotent = false,
  ): Promise<boolean> {
    setBusy(true);
    setError('');
    setNotice('');
    const fingerprint = JSON.stringify([path, payload]);
    if (idempotent && command.current?.payload !== fingerprint)
      command.current = { payload: fingerprint, key: crypto.randomUUID() };
    try {
      await api(path, payload, idempotent ? command.current!.key : undefined);
      command.current = null;
      setNotice(message);
      // A refresh failure must not suggest that a committed write failed.
      try {
        await load();
      } catch {
        setError(
          'Saved, but the view could not refresh. Use Refresh to reload it.',
        );
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save.');
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submitMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {
      ...Object.fromEntries(form),
      expectedUnitsPerPack: movementProduct?.units_per_pack,
    };
    if (
      await save(
        'stock-documents',
        payload,
        'Stock movement posted. Balances and history are up to date.',
        true,
      )
    )
      setShowMovement(false);
  }
  const internal =
    data?.locations.filter(
      (l) => l.type === 'WAREHOUSE' || l.type === 'VEHICLE',
    ) ?? [];
  const machineCount = data?.machines.length ?? 0;
  const movementProduct =
    data?.products.find((p) => p.id === movementProductId) ?? data?.products[0];
  const balance = (locationId: string, productId: string) =>
    data?.balances.find(
      (b) => b.location_id === locationId && b.product_id === productId,
    )?.quantity ?? '0';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            V<span>·</span>
          </span>
          <span>
            Vending<span className="brand-light">OT</span>
            <small>OPERATIONS PLATFORM</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">IV</span>
          <div>
            Island Vending<small>Development workspace</small>
          </div>
          <span className="workspace-dot" />
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {(
            [
              'Overview',
              'Inventory',
              'Products',
              'Machines',
              'Suppliers',
              'Receiving',
              'Locations',
            ] as Tab[]
          ).map((name, i) => (
            <button
              key={name}
              className={tab === name ? 'nav-item active' : 'nav-item'}
              onClick={() => setTab(name)}
            >
              <span aria-hidden="true">
                {['◫', '▤', '▦', '▣', '◇', '↓', '⌖'][i]}
              </span>
              {name}
              {tab === name && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">THE FIRST MILESTONE</span>
          <p>
            Every product.
            <br />
            Every movement.
            <br />
            Accounted for.
          </p>
          <small>Warehouse → van → machine</small>
        </div>
        <div className="profile">
          <span className="avatar">LO</span>
          <div>
            Local owner<small>Development identity</small>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> <strong>{tab}</strong>
          </span>
          <span className="dev-badge">
            <span /> LOCAL DEVELOPMENT
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">ISLAND VENDING</p>
              <h1>
                {tab === 'Overview'
                  ? 'Your operations, in view.'
                  : tab === 'Inventory'
                    ? 'Stock with a paper trail.'
                    : tab === 'Products'
                      ? 'Your product catalog.'
                      : tab === 'Machines'
                        ? 'Your machines, one place.'
                        : tab === 'Suppliers'
                          ? 'Your supplier directory.'
                          : tab === 'Receiving'
                            ? 'Deliveries, recorded once.'
                            : 'A place for every product.'}
              </h1>
              <p className="subtitle">
                {tab === 'Overview'
                  ? 'One workspace for the stock that keeps your business moving.'
                  : tab === 'Inventory'
                    ? 'Live balances and a permanent record of every transfer.'
                    : tab === 'Products'
                      ? 'Manage the products moving through your business.'
                      : tab === 'Machines'
                        ? 'Machine details, price tiers, and refill history.'
                        : tab === 'Suppliers'
                          ? 'Contacts, ordering packs and product purchase costs.'
                          : tab === 'Receiving'
                            ? 'Receive supplier deliveries into warehouse stock.'
                            : 'Warehouses and delivery vehicles.'}
              </p>
            </div>
            {(tab === 'Overview' ||
              tab === 'Inventory' ||
              tab === 'Locations') && (
              <button
                className="primary"
                disabled={!data || busy}
                onClick={() => {
                  setMovementUnit(movementProduct?.default_entry_unit ?? 'EA');
                  setShowMovement(true);
                  setError('');
                }}
              >
                ＋ Record movement
              </button>
            )}
          </div>
          {error && !showMovement && !reverse && (
            <div role="alert" className="alert error">
              {error}
              <button
                onClick={() =>
                  load()
                    .then(() => setError(''))
                    .catch((e) => setError(e.message))
                }
              >
                Refresh
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="alert success">
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice('')}
              >
                ×
              </button>
            </div>
          )}
          {!data ? (
            <div className="panel empty">
              {error
                ? 'The workspace is unavailable. Check that the API and database are running.'
                : 'Loading your workspace…'}
            </div>
          ) : (
            <>
              {(tab === 'Overview' || tab === 'Inventory') && (
                <>
                  <div className="stats">
                    {[
                      [
                        'Products',
                        data.products.length,
                        'Active catalog items',
                        '▦',
                      ],
                      [
                        'Stock locations',
                        internal.length,
                        'Across your operation',
                        '⌖',
                      ],
                      [
                        'Machines',
                        machineCount,
                        'Details & delivery history',
                        '◫',
                      ],
                      [
                        'Posted movements',
                        data.movements.length === 50
                          ? '50+'
                          : data.movements.length,
                        'Receipts, transfers & reversals',
                        '↗',
                      ],
                    ].map(([label, value, detail, icon]) => (
                      <div className="stat" key={String(label)}>
                        <div className="stat-label">
                          {label}
                          <span>{icon}</span>
                        </div>
                        <strong>{value}</strong>
                        <small>{detail}</small>
                      </div>
                    ))}
                  </div>
                  {tab === 'Overview' && (
                    <div className="journey">
                      <div>
                        <span className="eyebrow">
                          BUILT AROUND YOUR WORKING DAY
                        </span>
                        <h2>From the warehouse to the machine.</h2>
                        <p>
                          Record it once. Follow the stock all the way through.
                        </p>
                      </div>
                      <div className="journey-steps">
                        <span>
                          01<small>Warehouse</small>
                        </span>
                        <b>→</b>
                        <span>
                          02<small>Delivery van</small>
                        </span>
                        <b>→</b>
                        <span>
                          03<small>Machine</small>
                        </span>
                      </div>
                    </div>
                  )}
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Warehouse & van stock</h2>
                        <p>
                          Balances calculated from posted movements. Quantities
                          in individual units.
                        </p>
                      </div>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => load().catch((e) => setError(e.message))}
                      >
                        Refresh ↻
                      </button>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>PRODUCT</th>
                            {internal.map((l) => (
                              <th key={l.id}>
                                {l.name}
                                <small>{locationType(l.type)}</small>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {data.products.length ? (
                            data.products.map((p) => (
                              <tr key={p.id}>
                                <td>
                                  <strong>{p.name}</strong>
                                  <small>
                                    #{p.item_number} · {p.sku}
                                  </small>
                                </td>
                                {internal.map((l) => (
                                  <td key={l.id}>
                                    <span
                                      className={
                                        Number(balance(l.id, p.id)) > 0
                                          ? 'quantity positive'
                                          : 'quantity'
                                      }
                                    >
                                      {prettyQuantity(balance(l.id, p.id))}
                                    </span>
                                  </td>
                                ))}
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={internal.length + 1}>
                                Create your first product to begin tracking
                                stock.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    <div className="panel-footer">
                      <span className="small-dot" /> Machine deliveries appear
                      under Machines. Current stock inside a machine is unknown.
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Movement history</h2>
                        <p>
                          Latest 50 postings · original records are preserved
                          when reversed.
                        </p>
                      </div>
                      <span className="pill">APPEND-ONLY</span>
                    </div>
                    {data.movements.length === 0 ? (
                      <div className="empty">
                        <span className="empty-icon">↔</span>
                        <h3>Your stock story starts here.</h3>
                        <p>
                          Receive stock into the warehouse, then transfer it to
                          a van or machine.
                        </p>
                        <button
                          className="text-button"
                          onClick={() => setShowMovement(true)}
                        >
                          Record your first movement →
                        </button>
                      </div>
                    ) : (
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>PRODUCT / DATE</th>
                              <th>MOVEMENT</th>
                              <th>QUANTITY</th>
                              <th>STATUS</th>
                              <th>ACTION</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.movements.map((m) => (
                              <tr key={m.id}>
                                <td>
                                  <strong>{m.product_name}</strong>
                                  <small>
                                    {new Date(m.posted_at).toLocaleString(
                                      'en-GB',
                                      { timeZone: data.tenant.timezone },
                                    )}
                                  </small>
                                </td>
                                <td>
                                  {m.from_name}
                                  <span className="arrow">→</span>
                                  {m.to_name}
                                  <small>
                                    {m.note || locationType(m.kind)} ·{' '}
                                    {m.posted_by}
                                  </small>
                                </td>
                                <td>
                                  <strong>{prettyQuantity(m.quantity)}</strong>
                                </td>
                                <td>
                                  <span
                                    className={`pill ${m.reversed || m.kind === 'REVERSAL' ? '' : 'green'}`}
                                  >
                                    {m.reversed
                                      ? 'REVERSED'
                                      : m.kind === 'REVERSAL'
                                        ? 'REVERSAL'
                                        : 'POSTED'}
                                  </span>
                                </td>
                                <td>
                                  {!m.reversed && m.kind !== 'REVERSAL' && (
                                    <button
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => setReverse(m)}
                                    >
                                      Reverse
                                    </button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                </>
              )}
              {tab === 'Products' && (
                <Catalog data={data} save={save} busy={busy} />
              )}
              {tab === 'Suppliers' && (
                <Suppliers
                  data={data}
                  save={save}
                  busy={busy}
                  onReceive={(id) => {
                    setReceivingSupplier(id);
                    setTab('Receiving');
                  }}
                />
              )}
              {tab === 'Receiving' && (
                <Receiving
                  data={data}
                  save={save}
                  busy={busy}
                  initialSupplierId={receivingSupplier}
                />
              )}
              {tab === 'Machines' && (
                <Machines data={data} save={save} busy={busy} />
              )}
              {tab === 'Locations' && (
                <div className="two-columns">
                  <section className="panel">
                    <div className="panel-heading">
                      <h2>Stock locations</h2>
                      <span className="pill">{internal.length} INTERNAL</span>
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>CODE / NAME</th>
                          <th>TYPE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.locations
                          .filter((l) => l.type !== 'MACHINE')
                          .map((l) => (
                            <tr key={l.id}>
                              <td>
                                <strong>{l.name}</strong>
                                <small>{l.code}</small>
                              </td>
                              <td>
                                <span className="pill">
                                  {locationType(l.type)}
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </section>
                  <section className="panel form-panel">
                    <h2>Add a location</h2>
                    <p>Manage machines in the separate Machines section.</p>
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        if (
                          await save(
                            'locations',
                            Object.fromEntries(new FormData(form)),
                            'Location added.',
                          )
                        )
                          form.reset();
                      }}
                    >
                      <label>
                        Code
                        <input
                          name="code"
                          required
                          maxLength={120}
                          placeholder="VAN-002"
                        />
                      </label>
                      <label>
                        Name
                        <input
                          name="name"
                          required
                          maxLength={120}
                          placeholder="Delivery van 02"
                        />
                      </label>
                      <label>
                        Type
                        <select name="type">
                          <option value="WAREHOUSE">Warehouse</option>
                          <option value="VEHICLE">Vehicle</option>
                        </select>
                      </label>
                      <button className="primary" disabled={busy}>
                        {busy ? 'Saving…' : 'Add location'}
                      </button>
                    </form>
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="footer">
            VendingOT{' '}
            <span>
              Foundation · Synthetic development data · No production
              authentication
            </span>
          </footer>
        </div>
      </main>
      {showMovement && data && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="movement-title"
            className="modal"
          >
            <div className="panel-heading">
              <h2 id="movement-title">Record stock movement</h2>
              <button
                className="close"
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setShowMovement(false)}
              >
                ×
              </button>
            </div>
            <form onSubmit={submitMovement}>
              {error && (
                <div role="alert" className="alert error">
                  {error}
                </div>
              )}
              <p className="form-hint">
                Posting updates both locations together and preserves a
                permanent record.
              </p>
              <label>
                Movement type
                <select
                  name="kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="RECEIPT">
                    Opening / manual stock → warehouse
                  </option>
                  <option value="TRANSFER">Transfer between locations</option>
                </select>
              </label>
              <label>
                Product
                <select
                  name="productId"
                  required
                  value={movementProduct?.id ?? ''}
                  onChange={(e) => {
                    setMovementProductId(e.target.value);
                    setMovementUnit(
                      data.products.find((p) => p.id === e.target.value)
                        ?.default_entry_unit ?? 'EA',
                    );
                  }}
                >
                  {data.products.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  From
                  <select name="fromLocationId" key={`from-${kind}`} required>
                    {data.locations
                      .filter((l) =>
                        kind === 'RECEIPT'
                          ? l.type === 'EXTERNAL' && !l.supplier_id
                          : l.type === 'WAREHOUSE' || l.type === 'VEHICLE',
                      )
                      .map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  To
                  <select name="toLocationId" key={`to-${kind}`} required>
                    {data.locations
                      .filter((l) =>
                        kind === 'RECEIPT'
                          ? l.type === 'WAREHOUSE'
                          : l.type === 'WAREHOUSE' || l.type === 'VEHICLE',
                      )
                      .map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label>
                Quantity
                <input
                  name="quantity"
                  value={movementQuantity}
                  onChange={(e) => setMovementQuantity(e.target.value)}
                  type="text"
                  inputMode="numeric"
                  pattern="[1-9][0-9]{0,14}"
                  required
                  placeholder="100"
                />
              </label>
              <label>
                Packaging
                <select
                  name="entryUnit"
                  value={movementUnit}
                  onChange={(e) => setMovementUnit(e.target.value)}
                >
                  <option value="EA">
                    {movementProduct?.unit_label ?? 'Individual units'}
                  </option>
                  <option value="PACK">
                    {movementProduct?.pack_label ?? 'Pack'} ×{' '}
                    {movementProduct?.units_per_pack ?? 1}
                  </option>
                </select>
              </label>
              <p className="form-hint">
                {movementQuantity || '0'} ×{' '}
                {movementUnit === 'PACK'
                  ? (movementProduct?.units_per_pack ?? 1)
                  : 1}{' '}
                ={' '}
                {/^[1-9]\d{0,14}$/.test(movementQuantity)
                  ? (
                      BigInt(movementQuantity) *
                      BigInt(
                        movementUnit === 'PACK'
                          ? (movementProduct?.units_per_pack ?? 1)
                          : 1,
                      )
                    ).toLocaleString('en-MU')
                  : '0'}{' '}
                individual units
              </p>
              <label>
                Note <span className="optional">optional</span>
                <input
                  name="note"
                  maxLength={500}
                  placeholder="Supplier delivery or handover reference"
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setShowMovement(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={busy || !data.products.length}
                >
                  {busy ? 'Posting…' : 'Post movement'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {reverse && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="reverse-title"
            className="modal"
          >
            <div className="panel-heading">
              <h2 id="reverse-title">Reverse stock movement</h2>
              <button
                className="close"
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setReverse(null)}
              >
                ×
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const reason = new FormData(e.currentTarget).get('reason');
                if (
                  await save(
                    `stock-documents/${reverse.id}/reverse`,
                    { reason },
                    'Reversal posted. The original movement remains in history.',
                    true,
                  )
                )
                  setReverse(null);
              }}
            >
              {error && (
                <div role="alert" className="alert error">
                  {error}
                </div>
              )}
              <p>
                This creates a linked movement of{' '}
                {prettyQuantity(reverse.quantity)} units from {reverse.to_name}{' '}
                back to {reverse.from_name}. Sufficient stock must still be
                available.
              </p>
              <label>
                Reason
                <input
                  name="reason"
                  required
                  minLength={3}
                  maxLength={500}
                  placeholder="Explain the correction"
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setReverse(null)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  {busy ? 'Posting…' : 'Post reversal'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
