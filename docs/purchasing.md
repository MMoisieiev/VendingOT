# Supplier invoices and payments

Reference: the user-supplied **Invoice transfer from SUPL 2026.xlsx**, inspected read-only. Its `Transfers`, `Suppliers_List` and `Dashboard` sheets describe invoice references/dates/amounts, supplier credit days, bank initiation/clearing dates, comments, and payment urgency. The workbook itself and real financial rows are not added to the repository or imported as live data.

## Workflow and fields

- Receiving selects products directly. On successful posting, the supplier link is created if missing; prior linking is optional. Existing inactive links remain blocked until explicitly reactivated.
- Enter quantity, pack size and arrival price per pack, or choose individual units and enter a unit price. Preserve the exact entered price; derive unit cost to eight decimals for the product cost field. Never reconstruct pack totals from a rounded unit cost (SCR 100 / 12 is a repeating decimal).
- Record invoice reference, invoice date, received date, paper invoice total, optional signed charges/discount and an explanation. The invoice must match rounded goods total plus adjustments to cents before anything posts.
- Post stock, cost history, latest item cost, supplier packing, invoice and optional paid-on-arrival record together. Any failure rolls back all effects. Last arrival cost is not an average stock valuation; header fees are not automatically capitalized into products. Product refill pack and selling prices remain unchanged.
- A new checked invoice is UNPAID unless explicitly paid. Select whole unpaid invoices on the supplier account to record one full payment or one transfer sent to bank. Retain payment date/reference/note and every invoice allocation.
- IN_BANK means sent but not cleared. It is still outstanding debt and cannot be selected for another payment. Marking the payment CLEARED records the clearing date/reference, moves its invoices to PAID and removes their debt. This is local bookkeeping, not a request to a bank.
- Paid and unpaid invoices remain queryable. Supplier balances aggregate all confirmed invoices, even beyond the first display page. Old records with no known payment status/checked invoice total stay UNCONFIRMED until reviewed.

## Workbook mapping

| Workbook concept                                | Application                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| Invoice # / reference, supplier, invoice amount | Immutable receipt + confirmed supplier invoice                                          |
| Invoice date; effective-date fallback           | Separate invoice and received dates; received date is the legacy fallback               |
| Bank initiation date, method/tag                | Payment date/status, reference and note                                                 |
| Cleared date                                    | Append-only CLEARED payment event                                                       |
| `n`, blank clearing date, clearing date         | Explicit UNPAID, IN_BANK, PAID states                                                   |
| Supplier credit term                            | Editable `creditDays`, default 21; Apex is 30 in the reference                          |
| Deadline / manual override                      | Invoice date + snapshotted credit days, or explicit due date                            |
| Overdue / pay now / hold                        | Days left, overdue indicator, due-within-two-days amount, not-due-yet amount            |
| Supplier and portfolio debt                     | Supplier list/account balances; a full portfolio dashboard/date analyzer is future work |

Term changes apply to future invoices. Reminders never prohibit early payment. The workbook's `Transfers!M4 = G4 + J4` omits the pay-now portion of unpaid invoices; the application intentionally computes **all unpaid + all pending bank** so due-now obligations are not lost.

## API

`POST /supplier-receipts` retains its idempotency key and supplier/warehouse/reference/date fields. New fields:

- `invoiceDate`, optional `dueDate`, `invoiceTotal` (two decimals), `invoiceAdjustment` (signed, default zero), `adjustmentNote`.
- `paid` (default false), optional `paymentDate` and `paymentReference` for already cleared payments.
- Each line uses `productId` (or legacy `supplierProductId`), positive whole `quantity`, `entryUnit` (`ORDER`/`EA`), `expectedUnitsPerOrder` and optional `arrivalPackSize`. Supply exactly one of `packCost` (four decimals) or `unitCost` (eight decimals).
- Old-format requests without a checked `invoiceTotal` retain stock behavior but create a review invoice rather than assumed debt. A paid request requires a checked invoice total.

`GET /suppliers/:id/account?status=UNPAID|IN_BANK|PAID|UNCONFIRMED|ALL&cursor=<uuid>` returns all-record totals, a page of at most 100 invoices, a next cursor, and latest 50 payments. All paid invoices remain accessible through pagination.

`POST /suppliers/:id/payments` accepts `invoiceIds` (up to 100 distinct invoices), `paidOn`, `stage` (`PAID` or `IN_BANK`), optional `reference` and `note`, with an `Idempotency-Key`. It settles/assigns only complete confirmed invoices; already assigned invoices cause the entire request to fail.

`POST /suppliers/:id/payments/:paymentId/clear` accepts `clearedOn`, optional `reference` and `note`. Repeating the identical clearing is safe; a different clearing for an already cleared payment conflicts. Clearing cannot precede initiation.

`POST /suppliers/:id/invoices/:invoiceId/confirm` accepts a checked `invoiceTotal` for legacy records. The operator can then record an existing payment with its original date or leave the invoice outstanding.

Currency remains optional display text with SCR as the default. No currency conversion or label matching affects these workflows. Payment reversals/cancellations, partial settlements, supplier credit notes, order processing and general-ledger/bank integration remain separate work.
