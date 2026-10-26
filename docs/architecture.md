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
- All first-milestone products use whole individual units. Quantities use NUMERIC(18,3) in storage and decimal strings in JSON; Decimal.js handles stock comparison. Product costs and money are not implemented.
- Machine inventory is an estimate derived from recorded movements; consumption/sales telemetry and physical-count corrections are not implemented. The interface labels it accordingly.

## Scope deliberately left for subsequent work

1. Authentication and sessions, permissions on every operation, audit of master changes, production database roles and deployment controls.
2. Stable site assignments, machine metadata, barcodes, units/pack conversion, suppliers and validated legacy import.
3. Driver shifts, acknowledgement of warehouse handover, returns, variance handling and zero-stock closure.
4. React Native SQLite persistence, durable outbox, sync command dependencies, retry/conflict and device controls.
5. Visits, raw meters, 14-day counts, faults, visit schedules and overdue reporting.
6. Bag/seal custody, accountant counts, expected cash calculation, safe and bank transfers.
7. Expenses, operational reports, notifications and migration/pilot reconciliation.
8. Direct machine integrations and subscription billing after their protocols and commercial rules are specified.

Do not infer vend sales from machine fills. Do not present this milestone as full accounting or remote machine control.

## Open business decisions

Confirm meter units and cashless data source before implementing expected cash calculations. The recorded formula (current minus previous minus cashless) applies to compatible monetary cumulative meters; item counters need price context. Confirm resets/rollovers, float/refund treatment, negative-stock exceptions, bag identifier uniqueness, pack units, POS migration boundaries and pilot devices before their affected features. These do not prevent building the current whole-unit stock flow.

## Migration operations

Migration 001 is transactional and recorded in `schema_migrations`, with an advisory lock against concurrent runners. Rerunning skips an applied migration. Future changes must add new ordered migrations rather than edit applied SQL. There is no destructive rollback command: before live use, add tested backup/restore and forward-fix procedures. Development fixtures default to MUR and Indian/Mauritius for illustration; confirm business settings before live data.
