'use client';
import { useState } from 'react';
import { Movement, Overview, prettyQuantity } from '../lib/client';

export function Transactions({
  data,
  busy,
  onReverse,
  onRecord,
}: {
  data: Overview;
  busy: boolean;
  onReverse: (movement: Movement) => void;
  onRecord: () => void;
}) {
  const [search, setSearch] = useState('');
  const visible = data.movements.filter((m) =>
    `${m.product_name} ${m.from_name} ${m.to_name} ${m.note} ${m.kind} ${m.posted_by}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Stock transaction history</h2>
          <p>
            Latest 50 stock postings · original records are preserved when
            reversed.
          </p>
        </div>
        <label className="search-label">
          Find a transaction
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Product, location or note"
          />
        </label>
      </div>
      {data.movements.length === 0 ? (
        <div className="empty">
          <span className="empty-icon">↔</span>
          <h3>Your stock story starts here.</h3>
          <p>
            Receive stock into the warehouse, then transfer it to a van or
            machine.
          </p>
          <button className="text-button" onClick={() => onRecord()}>
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
              {!visible.length && (
                <tr>
                  <td colSpan={5}>No transactions match your search.</td>
                </tr>
              )}
              {visible.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.product_name}</strong>
                    <small>
                      {new Date(m.posted_at).toLocaleString('en-GB', {
                        timeZone: data.tenant.timezone,
                      })}
                    </small>
                  </td>
                  <td>
                    {m.from_name}
                    <span className="arrow">→</span>
                    {m.to_name}
                    <small>
                      {m.note || m.kind} · {m.posted_by}
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
                        onClick={() => onReverse(m)}
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
  );
}
