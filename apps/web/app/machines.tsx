'use client';
import { useState } from 'react';
import { Machine, Overview, Save } from '../lib/client';

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
  const machine = data.machines.find((m) => m.id === selected);
  const visible = data.machines.filter((m) =>
    `${m.machine_number} ${m.name} ${m.site_name} ${m.code}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  function open(m: Machine) {
    setSelected(m.id);
    setCreating(false);
    setEditing(false);
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
