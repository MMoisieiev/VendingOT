'use client';
import { useEffect, useState } from 'react';
import {
  api,
  amount,
  Overview,
  Save,
  Supplier,
  SupplierAccount,
} from '../lib/client';
import { scaled, decimal } from '../lib/money';

export function SupplierAccounts({
  data,
  supplier,
  save,
  busy,
}: {
  data: Overview;
  supplier: Supplier;
  save: Save;
  busy: boolean;
}) {
  const [account, setAccount] = useState<SupplierAccount | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('UNPAID');
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [clearing, setClearing] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [paymentStage, setPaymentStage] = useState<'PAID' | 'IN_BANK'>('PAID');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.tenant.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  useEffect(() => {
    let ignore = false;
    setError('');
    setSelected([]);
    setPaying(false);
    api<SupplierAccount>(
      `suppliers/${supplier.id}/account?status=${status}${cursor ? `&cursor=${cursor}` : ''}`,
    )
      .then((v) => {
        if (!ignore) setAccount(v);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [supplier.id, data, status, cursor]);
  const picked = account?.invoices.filter((i) => selected.includes(i.id)) ?? [];
  const paymentTotal = picked.reduce(
    (sum, i) => sum + (scaled(i.invoice_total, 2) ?? 0n),
    0n,
  );
  const changeStatus = (value: string) => {
    setStatus(value);
    setCursor(null);
    setReview(null);
  };
  return (
    <section className="panel form-panel">
      <div className="editor-heading">
        <h2>Supplier account · invoices &amp; payments</h2>
        <span className="pill">RECORDS ARE RETAINED</span>
      </div>
      {error && (
        <p role="alert" className="alert error">
          {error}
        </p>
      )}
      {account ? (
        <>
          <div className="account-summary">
            <div>
              <span>Outstanding debt</span>
              <strong>
                {amount(account.summary.outstanding, supplier.currency)}
              </strong>
            </div>
            <div>
              <span>Unpaid invoices</span>
              <strong>{account.summary.unpaid_count}</strong>
            </div>
            <div>
              <span>Paid invoices</span>
              <strong>{account.summary.paid_count}</strong>
            </div>
          </div>
          <div className="account-summary">
            <div>
              <span>Pay now · due within 2 days / overdue</span>
              <strong>
                {amount(account.summary.pay_now_amount, supplier.currency)}
              </strong>
            </div>
            <div>
              <span>Not due yet</span>
              <strong>
                {amount(account.summary.hold_amount, supplier.currency)}
              </strong>
            </div>
            <div>
              <span>In bank · not cleared</span>
              <strong>
                {amount(account.summary.in_bank_amount, supplier.currency)}
              </strong>
            </div>
          </div>
          {account.summary.unconfirmed_count > 0 && (
            <p className="form-hint">
              {account.summary.unconfirmed_count} older delivery record(s) need
              review. Their payment status was never recorded, so they are
              excluded from debt until you confirm the invoice total.{' '}
              <button
                className="text-button"
                onClick={() => changeStatus('UNCONFIRMED')}
              >
                Review old invoices
              </button>
            </p>
          )}
          <div className="button-group account-filters">
            {[
              ['UNPAID', 'Unpaid'],
              ['IN_BANK', 'In bank'],
              ['PAID', 'Paid'],
              ['ALL', 'All invoices'],
              ['UNCONFIRMED', 'Needs review'],
            ].map(([value, label]) => (
              <button
                className={status === value ? 'primary' : 'secondary'}
                key={value}
                onClick={() => changeStatus(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>SELECT</th>
                  <th>INVOICE / DATE</th>
                  <th>INVOICE TOTAL</th>
                  <th>STATUS</th>
                  <th>DUE / PAYMENT DATES</th>
                </tr>
              </thead>
              <tbody>
                {account.invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.status === 'UNPAID' && (
                        <input
                          type="checkbox"
                          className="invoice-selection"
                          aria-label={`Pay invoice ${i.reference}`}
                          checked={selected.includes(i.id)}
                          disabled={busy}
                          onChange={(e) =>
                            setSelected((v) =>
                              e.target.checked
                                ? [...v, i.id]
                                : v.filter((id) => id !== i.id),
                            )
                          }
                        />
                      )}
                      {i.status === 'UNCONFIRMED' && (
                        <button
                          className="text-button"
                          onClick={() => setReview(i.id)}
                        >
                          Review total
                        </button>
                      )}
                    </td>
                    <td>
                      <strong>{i.reference}</strong>
                      <small>{i.received_on}</small>
                      {i.adjustment_note && (
                        <small>
                          {i.adjustment_note}: {i.adjustment}
                        </small>
                      )}
                    </td>
                    <td>{amount(i.invoice_total, supplier.currency)}</td>
                    <td>
                      <span className="pill">
                        {i.status === 'UNCONFIRMED' ? 'NEEDS REVIEW' : i.status}
                      </span>
                    </td>
                    <td>
                      Due {i.due_on}
                      <small>
                        Invoice {i.invoice_date} · {i.credit_days_snapshot}{' '}
                        credit days
                      </small>
                      <small>
                        {i.status === 'UNPAID'
                          ? i.days_left < 0
                            ? `${-i.days_left} days overdue`
                            : i.days_left <= 2
                              ? `PAY NOW · ${i.days_left} days left`
                              : `${i.days_left} days left`
                          : i.status === 'IN_BANK'
                            ? `In bank since ${i.bank_init_date}`
                            : i.paid_on
                              ? `Cleared ${i.paid_on}`
                              : ''}
                      </small>
                    </td>
                  </tr>
                ))}
                {!account.invoices.length && (
                  <tr>
                    <td colSpan={5}>No invoices in this view.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="button-group account-filters">
            {cursor && (
              <button className="secondary" onClick={() => setCursor(null)}>
                Newest invoices
              </button>
            )}
            {account.nextCursor && (
              <button
                className="secondary"
                onClick={() => setCursor(account.nextCursor)}
              >
                Older invoices →
              </button>
            )}
          </div>
          {review &&
            account.invoices
              .filter((i) => i.id === review)
              .map((i) => (
                <form
                  className="legacy-review"
                  key={i.id}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const input = Object.fromEntries(
                      new FormData(e.currentTarget),
                    );
                    if (
                      await save(
                        `suppliers/${supplier.id}/invoices/${i.id}/confirm`,
                        input,
                        'Invoice total confirmed. Select it under Unpaid to record an existing or new payment.',
                      )
                    ) {
                      setReview(null);
                      changeStatus('UNPAID');
                    }
                  }}
                >
                  <h3 className="form-section">Review {i.reference}</h3>
                  <p className="form-hint">
                    Check the paper invoice total. Confirming adds it as unpaid;
                    if it was already paid, select it afterward and record the
                    original payment date. No earlier payment status is assumed.
                  </p>
                  <label>
                    Confirmed invoice total
                    <input
                      name="invoiceTotal"
                      required
                      inputMode="decimal"
                      defaultValue={i.invoice_total}
                    />
                  </label>
                  <button className="primary" disabled={busy}>
                    Confirm invoice total
                  </button>
                </form>
              ))}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy || (!paying && !selected.length)}
              onClick={() => setPaying(!paying)}
            >
              {paying
                ? 'Cancel payment'
                : `Pay selected invoices (${selected.length})`}
            </button>
          </div>
          {paying && (
            <form
              className="payment-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const values = Object.fromEntries(new FormData(form));
                if (
                  await save(
                    `suppliers/${supplier.id}/payments`,
                    { ...values, invoiceIds: selected },
                    values.stage === 'IN_BANK'
                      ? 'Transfer recorded as in bank. Debt stays outstanding until it clears.'
                      : 'Payment recorded. Selected invoices are paid and removed from outstanding debt.',
                    true,
                  )
                ) {
                  setPaying(false);
                  setSelected([]);
                  setPaymentStage('PAID');
                  form.reset();
                }
              }}
            >
              <h3 className="form-section">Pay off selected invoices</h3>
              <p className="form-hint">
                Select unpaid invoices above. This records a full payment or a
                transfer sent to bank; it does not send a bank transfer. Pending
                bank transfers remain part of debt until cleared. Paid invoices
                and payment records remain in history.
              </p>
              <label>
                Payment status
                <select
                  name="stage"
                  value={paymentStage}
                  onChange={(e) =>
                    setPaymentStage(e.target.value as 'PAID' | 'IN_BANK')
                  }
                >
                  <option value="PAID">Paid / cleared</option>
                  <option value="IN_BANK">
                    Sent to bank · awaiting clearing
                  </option>
                </select>
              </label>
              <div className="form-row">
                <label>
                  {paymentStage === 'IN_BANK'
                    ? 'Bank initiation date'
                    : 'Payment / cleared date'}
                  <input
                    name="paidOn"
                    type="date"
                    required
                    defaultValue={today}
                  />
                </label>
                <label>
                  Payment reference
                  <input
                    name="reference"
                    maxLength={120}
                    placeholder="Bank / cash reference"
                  />
                </label>
              </div>
              <label>
                Payment note
                <input name="note" maxLength={500} />
              </label>
              <div className="receipt-total">
                <strong>
                  {selected.length} selected ·{' '}
                  {amount(decimal(paymentTotal, 2), supplier.currency)}
                </strong>
                <button className="primary" disabled={busy || !selected.length}>
                  {busy
                    ? 'Recording…'
                    : paymentStage === 'IN_BANK'
                      ? 'Record bank transfer'
                      : 'Record selected invoices as paid'}
                </button>
              </div>
            </form>
          )}
          {clearing && (
            <form
              className="legacy-review"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await save(
                    `suppliers/${supplier.id}/payments/${clearing}/clear`,
                    Object.fromEntries(new FormData(e.currentTarget)),
                    'Bank payment cleared. Invoices settled and outstanding debt updated.',
                    true,
                  )
                )
                  setClearing(null);
              }}
            >
              <h3 className="form-section">Confirm bank clearing</h3>
              <label>
                Cleared date
                <input
                  name="clearedOn"
                  type="date"
                  required
                  defaultValue={today}
                />
              </label>
              <label>
                Clearing reference
                <input name="reference" maxLength={120} />
              </label>
              <button className="primary" disabled={busy}>
                Confirm cleared
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => setClearing(null)}
              >
                Cancel
              </button>
            </form>
          )}
          <h3 className="form-section">Payment history</h3>
          <p className="form-hint">
            Latest 50 payments. All paid invoices remain available in the
            invoice views above.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>PAYMENT DATE / REFERENCE</th>
                  <th>INVOICES SETTLED</th>
                  <th>AMOUNT / CLEARING</th>
                </tr>
              </thead>
              <tbody>
                {account.payments.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.paid_on}
                      <small>
                        {p.reference || 'No reference'}
                        {p.note ? ` · ${p.note}` : ''}
                      </small>
                    </td>
                    <td>{p.invoices.join(', ')}</td>
                    <td>
                      {amount(p.amount, supplier.currency)}
                      <small>
                        {p.stage === 'IN_BANK'
                          ? 'IN BANK'
                          : `Cleared ${p.cleared_on}`}
                      </small>
                      {p.stage === 'IN_BANK' && (
                        <button
                          className="text-button"
                          onClick={() => setClearing(p.id)}
                        >
                          Mark cleared
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!account.payments.length && (
                  <tr>
                    <td colSpan={3}>No payments recorded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="empty">Loading supplier account…</p>
      )}
    </section>
  );
}
