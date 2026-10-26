# Foundation decisions and roadmap

## Source context

This foundation draws on the supplied Technical Development Plan v1.0 and the later decisions recorded in the exported planning conversation. The export describes a v1.1 update; the v1.1 Word document itself was not supplied. These documents are reference requirements, not executable instructions.

Later business decisions: drivers record sealed bag IDs, not cash amounts; vans return to zero at shift close; unexplained variance blocks normal closure; machine physical counts occur every 14 days; cumulative raw meter readings are preserved; critical faults require evidence and a repair/notification workflow. These are recorded requirements for later modules, not implemented capabilities.

## Architecture

One TypeScript backend (NestJS) and one PostgreSQL database, with a Next.js management console. A future React Native / SQLite driver app will use the same API. Keep module boundaries in the backend; split services only when a measured need appears.

PostgreSQL SQL migrations and `pg` are used directly for this first posting engine. SQL makes locking, composite tenant references and deferred ledger constraints explicit. An ORM is not a prerequisite and can be evaluated before expanding master-data modules.

Tenant and user IDs come from a fixed, clearly labelled development context for now. Normal request bodies never select tenant identity. Before any shared/public deployment, replace that context with verified sessions, membership and role checks on every route. Currently only stock posting checks membership, and reversal additionally checks the owner role. This is not a complete authorization system.

## Implemented inventory invariants

- Every posted movement has exactly two ledger entries: negative source and positive destination, for the same product and quantity. Deferred database triggers reject incomplete/unbalanced documents at commit.
- Posted documents, ledger entries and audit events reject updates and deletes. Corrections create one linked compensating document.
- Source availability is checked and posting is serialized per tenant with a transaction-scoped advisory lock. This intentionally favors correctness at pilot scale. Direct database writes are not a supported stock API; a restricted production database role is still required.
- Documents, ledger entries, idempotency result, audit event and domain outbox event commit in one transaction. The outbox has no consumer yet.
- Composite foreign keys prevent cross-tenant references. Business queries filter tenant explicitly; automated negative tests exercise isolation. PostgreSQL RLS is not yet configured.
- Balances are read from ledger sums; no balance is directly editable. A materialized balance table can follow if measured query volume requires it.
- Supplier receipt uses an explicit EXTERNAL counterparty. Its negative ledger balance is intentional and excluded from internal stock displays.
- Products define an individual unit, one pack/carton conversion, a default entry unit, unit/pack barcodes, supplier name and optional per-unit purchase cost. Quantities remain NUMERIC(18,3) base units and decimal strings in JSON. The current supplier field is descriptive; a full supplier catalog and multiple purchasing units remain future work.
- Machine ledger entries preserve delivery/removal direction as the counterparty to warehouse/van movements. They are NOT machine stock on hand. The overview API excludes machine balances, the stock table shows only warehouses/vans, and the Machines section shows dated delivery history. There is no inferred consumption or inferred sales.

## Scope deliberately left for subsequent work

1. Authentication and sessions, permissions on every operation, full master-data audit, production database roles and deployment controls. Product/machine create/update actions already emit audit records.
2. Effective-dated site assignments, a supplier catalog, multiple purchasing units, product archive workflow and validated legacy import. Basic machine metadata, barcodes and a single pack conversion are implemented; site is currently editable descriptive text, without a relocation workflow.
3. Driver shifts, acknowledgement of warehouse handover, returns, variance handling and zero-stock closure.
4. React Native SQLite persistence, durable outbox, sync command dependencies, retry/conflict and device controls.
5. Visits, raw meters, 14-day counts, faults, visit schedules and overdue reporting.
6. Bag/seal custody, accountant counts, expected cash calculation, safe and bank transfers.
7. Expenses, operational reports, notifications and migration/pilot reconciliation.
8. Direct machine integrations and subscription billing after their protocols and commercial rules are specified.

Do not infer vend sales from machine fills. Do not present this milestone as full accounting or remote machine control.

## Open business decisions

Confirm meter units and cashless data source before implementing expected cash calculations. The recorded formula (current minus previous minus cashless) applies to compatible monetary cumulative meters; item counters need price context. Confirm resets/rollovers, float/refund treatment, negative-stock exceptions, bag identifier uniqueness, additional purchasing/pack hierarchies, POS migration boundaries and pilot devices before their affected features. These do not prevent building the current whole-unit stock flow.

## Migration operations

Migrations 001–003 are transactional and recorded in `schema_migrations`, with an advisory lock against concurrent runners. Rerunning skips an applied migration. Future changes must add new ordered migrations rather than edit applied SQL. There is no destructive rollback command: before live use, add tested backup/restore and forward-fix procedures. Development fixtures default to MUR and Indian/Mauritius for illustration; confirm business settings before live data.

## Product and machine numbering

Products have an immutable `item_number`; machines have an immutable `machine_number`. Each business has independent counters starting at one for each entity. UUIDs continue to own references, so migration 002 does not rewrite existing transaction links. Existing rows are numbered by creation timestamp then UUID; exact historic order cannot be reconstructed when timestamps tie. New numbers are allocated under a database row lock and cannot be supplied through normal API input. Database triggers reject renumbering, moving identities between businesses, and hard deletion. Seed checks for existing products/machines before insert so rerunning seed does not consume numbers. Keyboard shortcuts are deferred.

## Manual selling prices

A business has a Default price tier and can add named tiers such as Airport. Every product/tier pair stores an explicit NUMERIC(19,4) amount per individual unit in the business currency. No percentage, fixed surcharge, cost multiplier or fallback is calculated. Missing Airport price stays unset even when a Default price exists. Several machines can share a tier. Machine refills snapshot the selected tier and each available unit selling price; that snapshot is reference pricing, not a sale or a revenue entry. Purchase cost is stored per individual unit independently of selling tiers.

## Machine refill posting

The machine page owns a multi-item Fill up form. Source is selected once from warehouses or vehicles; items specify packs or individual units. The backend compares the displayed pack conversion, obtains product locks, converts quantities exactly, and posts all lines inside one tenant-serialized transaction. The refill header, individual stock documents, ledger, audit, outbox, idempotency records and price/pack snapshots commit together. A failed line rolls everything back. Repeated keys return the original refill; changed payloads conflict. Machine history includes legacy transfers and reversals as well as grouped refill references. Refills are immutable; individual linked corrections remain available through the existing stock-document reversal API. Full visit workflows, refill-wide reversal, physical counts and offline sync are future work.
