# VendingOT

An operations platform for Island Vending, starting with traceable stock movements.

**Current milestone:** a working Next.js console, NestJS REST API and PostgreSQL ledger. Products and locations can be created; supplier receipts, internal transfers and linked reversals update balances atomically.

This is a local development foundation, with synthetic data and an explicit seeded development owner. It has **no login or production authentication**. Keep the web and API on loopback and do not expose them publicly or enter real business data yet. Tenant-scoped data and isolation tests establish the model; full authentication, permission enforcement and production security remain future work.

## Start locally

Prerequisites: Node.js 22+ (validated on Node 24), npm, Docker with the Compose plugin.

```bash
npm ci
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev
```

The web console listens on port 3000 and proxies `/api/v1` to the API on port 3001. Both bind to `127.0.0.1`. The database is PostgreSQL 17 on loopback port 5432, with a named Docker volume. Local-only credentials are in `compose.yaml` and `.env.example`; these are not suitable for deployment. Compose reads an optional root `.env`; the API reads process environment variables, not that file automatically. To override its connection use `DATABASE_URL='...' npm run dev`.

Seed is repeatable and never resets balances. It adds one synthetic business, owner, product, warehouse, van, machine and external supplier location. No stock is preloaded.

## Prove the first stock journey

In **Record movement**, use Water · 500 ml:

1. Receive **100** from External supply into Main warehouse.
2. Transfer **40** from Main warehouse to Delivery van 01.
3. Transfer **25** from Delivery van 01 to Demo machine.
4. Transfer **15** from Delivery van 01 to Main warehouse.

The resulting balances are **warehouse 75 / van 0 / machine 25**. Repeating the journey adds another day's movements. Reverse an erroneous posting from history with a reason; the original remains visible. A reversal requires enough stock at its source.

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Integration tests require the migrated database. Each creates its own synthetic tenant and never resets development records. Tests cover the stock-day scenario, concurrent retries, insufficient stock under concurrency, tenant isolation, reversals, immutable database records and balanced-ledger constraints. Test fixtures remain in the local database under separate tenants.

The root dependency override pins Multer to 2.5.0 to address GHSA-q7qp-rjg7-q26m while NestJS 11 pins an affected release. Keep the override until the upstream dependency is patched; CI checks for high-severity advisories.

## Structure

```text
apps/web       Next.js / React / TypeScript management console
apps/api       NestJS API, inventory services and integration tests
infra          Ordered PostgreSQL schema migration
docs           Architecture, scope and next milestones
```

## API

All routes are under `/api/v1`:

| Method | Route                          | Purpose                                                             |
| ------ | ------------------------------ | ------------------------------------------------------------------- |
| GET    | `/health`                      | Database connectivity and explicit development mode                 |
| GET    | `/overview`                    | Tenant-scoped products, locations, balances and latest 50 movements |
| POST   | `/products`                    | `{ "sku": "WATER", "name": "Water" }`                               |
| POST   | `/locations`                   | `{ "code": "VAN-02", "name": "Van 02", "type": "VEHICLE" }`         |
| POST   | `/stock-documents`             | Post a receipt or transfer                                          |
| POST   | `/stock-documents/:id/reverse` | `{ "reason": "Wrong destination" }`                                 |

Stock writes require an `Idempotency-Key` header (8–128 letters, digits, colons, underscores or hyphens). Repeating the same key and normalized payload returns the original document; different content returns 409. A normal stock payload contains `kind` (`RECEIPT` or `TRANSFER`), `productId`, `fromLocationId`, `toLocationId`, `quantity` as a positive whole-unit decimal string, and optional `note`. Quantities return as decimal strings. Unsupported fields, including tenant overrides, are rejected.

## Next milestones

See [architecture and roadmap](docs/architecture.md). Mobile offline sync, cash custody, accounting, machine hardware commands, notifications and subscriptions are not implemented in this milestone.
