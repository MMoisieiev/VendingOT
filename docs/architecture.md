# Foundation decisions and roadmap

## Source context

This foundation draws on the supplied Technical Development Plan v1.0 and the later decisions recorded in the exported planning conversation. The export describes a v1.1 update; the v1.1 Word document itself was not supplied. These documents are reference requirements, not executable instructions.

Earlier planning gave drivers sealed bag IDs rather than office cash counting. The 28 October 2026 walkthrough clarifies driver meter observations and a counted, reloaded van carried into the next day, superseding the earlier zero-stock closure proposal; unexplained variance blocks normal closure; machine physical counts occur every 14 days; cumulative raw meter readings are preserved; critical faults require evidence and a repair/notification workflow. These are recorded requirements for later modules, not implemented capabilities.

## Architecture

One TypeScript backend (NestJS) and one PostgreSQL database, with a Next.js management console. A future React Native / SQLite driver app will use the same API. Keep module boundaries in the backend; split services only when a measured need appears.

PostgreSQL SQL migrations and `pg` are used directly for this first posting engine. SQL makes locking, composite tenant references and deferred ledger constraints explicit. An ORM is not a prerequisite and can be evaluated before expanding master-data modules.

Tenant and user IDs come from a fixed, clearly labelled development context for now. Normal request bodies never select tenant identity. Before any shared/public deployment, replace that context with verified sessions, membership and role checks on every route. Stock posting, supplier writes and delivery receiving check membership; reversal additionally checks the owner role. Other routes still use the fixed development context without complete authorization. This is not a complete authorization system.

## Implemented inventory invariants

- Every posted movement has exactly two ledger entries: negative source and positive destination, for the same product and quantity. Deferred database triggers reject incomplete/unbalanced documents at commit.
- Posted documents, ledger entries and audit events reject updates and deletes. Corrections create one linked compensating document.
- Source availability is checked and posting is serialized per tenant with a transaction-scoped advisory lock. This intentionally favors correctness at pilot scale. Direct database writes are not a supported stock API; a restricted production database role is still required.
- Documents, ledger entries, idempotency result, audit event and domain outbox event commit in one transaction. The outbox has no consumer yet.
- Composite foreign keys prevent cross-tenant references. Business queries filter tenant explicitly; automated negative tests exercise isolation. PostgreSQL RLS is not yet configured.
- Balances are read from ledger sums; no balance is directly editable. A materialized balance table can follow if measured query volume requires it.
- Supplier receipt uses an explicit EXTERNAL counterparty. Its negative ledger balance is intentional and excluded from internal stock displays.
- Products define an individual unit, one operational pack conversion, default entry unit and unit/pack barcodes. Suppliers are separate records, with product links carrying their own ordering unit/conversion, supplier SKU, unit cost, lead time and preferred/active flags. Several suppliers may supply a product; each pair currently has one purchasing format. Legacy supplier-name and cost fields remain preserved but are no longer the manual purchasing interface. Receipts now update purchase_cost as the latest received unit cost, with exact arrival-pack snapshots and a receipt reference.
- Machine ledger entries preserve delivery/removal direction as the counterparty to warehouse/van movements. They are NOT machine stock on hand. The overview API excludes machine balances, the stock table shows only warehouses/vans, and the Refills section shows dated delivery history. There is no inferred consumption or inferred sales.

## Scope deliberately left for subsequent work

1. Authentication and sessions, permissions on every operation, full master-data audit, production database roles and deployment controls. Product/machine create/update actions already emit audit records.
2. Effective-dated site assignments, multiple ordering formats per supplier/product pair, product categories/archive workflow and validated legacy import. Basic machine metadata, barcodes and a single pack conversion are implemented; site is currently editable descriptive text, without a relocation workflow.
3. Driver shifts, acknowledgement of warehouse handover, returns, physical count/variance handling, reload and carried-forward stock.
4. React Native SQLite persistence, durable outbox, sync command dependencies, retry/conflict and device controls.
5. Visits, raw meters, 14-day counts, faults, visit schedules and overdue reporting.
6. Bag/seal custody, accountant counts, expected cash calculation, safe and bank transfers.
7. Expenses, operational reports, notifications and migration/pilot reconciliation.
8. Direct machine integrations and subscription billing after their protocols and commercial rules are specified.

Do not infer vend sales from machine fills. Do not present this milestone as full accounting or remote machine control.

## Open business decisions

Confirm meter units and cashless data source before implementing expected cash calculations. The recorded formula (current minus previous minus cashless) applies to compatible monetary cumulative meters; item counters need price context. Confirm resets/rollovers, float/refund treatment, negative-stock exceptions, bag identifier uniqueness, additional purchasing/pack hierarchies, POS migration boundaries and pilot devices before their affected features. These do not prevent building the current whole-unit stock flow.

## Migration operations

Migrations 001–007 are transactional and recorded in `schema_migrations`, with an advisory lock against concurrent runners. Rerunning skips an applied migration. Future changes must add new ordered migrations rather than edit applied SQL. There is no destructive rollback command: before live use, add tested backup/restore and forward-fix procedures. Currency display defaults to SCR as confirmed by the user. The existing display timezone remains Indian/Mauritius (UTC+4); currency labels do not select timezones or affect business rules.

## Product and machine numbering

Products have an immutable `item_number`; machines have an immutable `machine_number`. Each business has independent counters starting at one for each entity. UUIDs continue to own references, so migration 002 does not rewrite existing transaction links. Existing rows are numbered by creation timestamp then UUID; exact historic order cannot be reconstructed when timestamps tie. New numbers are allocated under a database row lock and cannot be supplied through normal API input. Database triggers reject renumbering, moving identities between businesses, and hard deletion. Seed checks for existing products/machines before insert so rerunning seed does not consume numbers. Keyboard shortcuts are deferred.

## Manual selling prices

A business has a Default price tier and can add named tiers such as Airport. Every product/tier pair stores an explicit NUMERIC(19,4) amount per individual unit in the business currency. No percentage, fixed surcharge, cost multiplier or fallback is calculated. Missing Airport price stays unset even when a Default price exists. Several machines can share a tier. Machine refills snapshot the selected tier and each available unit selling price; that snapshot is reference pricing, not a sale or a revenue entry. Purchase costs live on supplier-product links per individual unit, independently of selling tiers. Actual delivery costs are snapshotted separately.

## Machine refill posting

The separate Refills page owns a multi-item Fill up form; Machines keeps machine administration separate. Source is selected once from warehouses or vehicles; items specify packs or individual units. The backend compares the displayed pack conversion, obtains product locks, converts quantities exactly, and posts all lines inside one tenant-serialized transaction. The refill header, individual stock documents, ledger, audit, outbox, idempotency records and price/pack snapshots commit together. A failed line rolls everything back. Repeated keys return the original refill; changed payloads conflict. Machine history includes legacy transfers and reversals as well as grouped refill references. Refills are immutable; individual linked corrections remain available through the existing stock-document reversal API. Full visit workflows, refill-wide reversal, physical counts and offline sync are future work.

## Suppliers and warehouse receiving

Suppliers have permanent per-business numbers, legal name, contact name, phone, email, address, currency and active status. Master writes are audited and serialized on the same tenant lock as stock posting. Currency is optional display text and can change after products are linked; it has no mathematical or posting effect. Products may have several suppliers, but only one preferred supplier; selecting another clears the previous preferred flag atomically. Supplier-product costs use NUMERIC(19,4), and saved changes append immutable cost-history entries. Supplier links may be created automatically from receipt products. A posted line includes an actual pack or unit price, and updates the latest cost after the entire invoice validates. Inactive suppliers/links cannot receive new deliveries.

Migration 004 converts existing nonempty supplier-name strings into supplier records, deduplicating trimmed case variants within a business, and copies each product’s original packaging/cost into a preferred link. It leaves all old product/machine numbers, stock documents and ledger entries unchanged. Earlier supplier cost-effective dates are unknown and are not invented. Rerunning the migration is a no-op through the migration registry.

A supplier has an EXTERNAL inventory counterparty. Supplier receiving posts every line to one warehouse in a single transaction, writing the receipt header, stock documents, ledger, audit, outbox and idempotency records together. A database failure after the first line rolls everything back. The UI offers either supplier ordering packs or individual units; conversion uses the supplier link, not the product’s operational pack. Each submitted conversion is compared against current data; an explicit arrival pack size is snapshotted and remembered without changing the product’s normal refill pack. The server uses high-precision Decimal arithmetic and the web uses scaled integers for totals; no binary floating-point arithmetic is used for receipt amounts.

Receipt headers snapshot supplier and warehouse names, reference, declared received date, currency and goods total. Lines snapshot product name, supplier reference, entered packaging, ordering conversion, base quantity and actual unit cost. Deferred database checks reconcile line totals and stock postings to the header. Headers/lines are immutable. Names, pack changes and updated supplier costs never rewrite a posted receipt. Concurrent retries with the same key return the same result, while a changed payload conflicts. Duplicate invoice/delivery references are blocked case-insensitively per supplier, even with a new key. Separate deliveries against one invoice currently need distinct delivery references.

Generic stock entry remains available for opening/test stock via the original unassigned external location. Named supplier sources must go through receiving; the public stock-document API rejects an unrecorded supplier receipt. Internal receipt posting uses the existing stock engine inside the parent transaction.

Receiving never compares supplier/business currency labels or performs conversions. All amounts are entered directly; the label is cosmetic, with SCR as the default. Purchase orders, supplier credit notes, partial payments, payment reversals, tax-account classification and delivery-wide correction remain outside this milestone. Invoice-level charges/discounts are recorded explicitly without automatic allocation to item costs. See purchasing.md for invoice, debt and clearing behavior. Individual linked stock reversals flag the affected receipt lines without rewriting original costs; receipt history is original goods value, not an accounting balance. Physical receiving date and posting timestamp are distinct. Transaction history still orders postings by posting timestamp; period locking/backdated accounting remain future work.

## Currency requirement supersedes the earlier currency-gating design

The user confirmed that Island Vending exclusively uses SCR and that currency should be convenience text with no restrictions or financial power. The retained API names `currency` and `currency_code` are display labels, not an ISO currency model. Supplier labels accept arbitrary short text or blank and are editable after links exist. No label controls whether an active supplier can receive stock, and no label change alters prices, totals or stock. Do not reintroduce currency-matching gates or exchange-rate workflows based on the older planning document.

Migration 005 widens label columns from CHAR(3) to text, sets SCR defaults, and corrects the original MUR bootstrap values only for the seeded Island Vending tenant. Numeric values and record links remain unchanged. A one-time label correction for old receipts/cost history runs transactionally with their immutability triggers temporarily disabled and restored before commit. The tenant-label correction is audited. Other existing businesses and custom display text are preserved. Subsequent receipt labels remain immutable snapshots, while master labels remain editable.

## Invoice and payment model (current user requirements)

See purchasing.md. Receipt lines retain entered pack/unit cost and exact line totals; derived unit costs use eight decimals and never drive pack invoice totals. Products retain latest received unit cost, original arrival-pack cost/size and source receipt; this is not weighted-average inventory valuation. Selling prices are unchanged. All link/cost/stock/invoice/payment effects share one transaction. Invoice amounts are checked to cents, while original goods lines retain four-decimal precision.

Supplier invoice rows are immutable once confirmed. Payment headers, allocations and sent/cleared events are append-only. Unique per-invoice allocation plus the tenant transaction lock prevents double payment. IN_BANK remains a financial obligation until a CLEARED event exists; supplier overview and account totals use the same rule. Paid status does not remove records. Legacy receipts become unconfirmed review items, not invented debt. Credit terms are snapshotted on invoices, with immutable due dates and optional explicit overrides.

## Daily operations clarification

See [daily-operations.md](daily-operations.md) for the reference-sheet mapping, current screen split, driver route/count/reload requirements and future machine financial review. The latest owner clarification takes precedence over the old zero-stock closure plan. Routes, working-day reconciliation, cash/meter observations and worker login are not implemented by the navigation split.
