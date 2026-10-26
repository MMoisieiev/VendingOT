# VendingOT

An operations platform for Island Vending, starting with traceable stock movements.

**Current milestone:** product and machine records with permanent incremental IDs, pack-aware stock entry, explicit per-product price tiers, and multi-item machine refills. Warehouse and van stock are tracked; machines show delivery history, never a claimed current stock balance.

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

## Update an existing laptop checkout

Stop the web and API terminals with Ctrl+C, then run these commands in the repository folder:

```bash
git pull --ff-only origin main
npm ci
npm run db:up
npm run db:migrate
npm run db:seed
```

Restart the API with `npm run dev -w @vendingot/api` and the web in another terminal with `npm run dev -w @vendingot/web`. These separate commands work in Windows PowerShell too. Do not delete your database volume. Migration 002 retains products, machines and transaction history while assigning permanent numbers to existing records. Existing products keep a one-unit pack until you configure their actual packaging; fresh seed records use twelve-bottle water packs.

## Try products, pricing and a machine refill

1. Open **Products**. Add a price tier named **Airport**.
2. Edit Water: unit name Bottle, pack name Pack, **12 units per pack**, default entry Packs. Enter supplier, unit/pack barcodes and purchase cost per individual unit if known.
3. Enter selling prices independently: **Default = MUR 10**, **Airport = MUR 15** per bottle. Blank means not set; no automatic markup or fallback applies.
4. Add a machine in **Machines**, choose the Airport price tier, and fill in its name, site, serial number, manufacturer and model. Its machine ID is assigned automatically.
5. In **Record movement**, receive **10 packs** of water into the warehouse (120 bottles). If using a van, transfer the load to that van first.
6. Open the machine, select **Fill up**, choose the source warehouse or van once, and press **Add item**.
7. Select Water, enter **7 packs** and review **7 × 12 = 84 units**. Add other products to the same refill if needed, then save.
8. The source loses 84 bottles; machine history records seven packs and 84 bottles. With a fresh empty warehouse and this one receipt/refill, 36 bottles remain. Existing stock changes that total. No machine stock-on-hand figure is displayed.

A refill is all-or-nothing. If any line has insufficient stock, nothing posts. Retrying the same command cannot deduct twice. Pack sizes and tier prices are snapshotted, so later edits do not rewrite posted quantities or prices. Refills record deliveries, not sales or revenue. Existing movement corrections remain available through **Reverse** in inventory history.

Products and machines have separate permanent number sequences per business. Item #1 and machine #1 can coexist. Numbers cannot be edited or reused by deleting a record. Keyboard shortcuts are deferred.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Integration tests require the migrated database. Each creates its own synthetic tenant and never resets development records. Tests cover permanent/concurrent numbering, manual tier prices, seven-pack conversion, historical snapshots, atomic multi-line refills, cross-business access, stock posting, concurrent retries, reversals and immutable ledger constraints. Test fixtures remain in the local database under separate tenants.

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
| POST   | `/products`                    | Create product with auto-assigned item number                       |
| POST   | `/locations`                   | `{ "code": "VAN-02", "name": "Van 02", "type": "VEHICLE" }`         |
| POST   | `/stock-documents`             | Post a receipt or transfer                                          |
| POST   | `/stock-documents/:id/reverse` | `{ "reason": "Wrong destination" }`                                 |

Stock writes require an `Idempotency-Key` header (8–128 letters, digits, colons, underscores or hyphens). Repeating the same key and normalized payload returns the original document; different content returns 409. A normal stock payload contains `kind` (`RECEIPT` or `TRANSFER`), `productId`, `fromLocationId`, `toLocationId`, `quantity` as a positive whole-unit decimal string, and optional `note`. Quantities return as decimal strings. Unsupported fields, including tenant overrides, are rejected.

Additional endpoints:

| Method | Route                   | Purpose                                                                                                        |
| ------ | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/products/:id`         | Edit product packaging, supplier, barcodes, unit purchase cost and explicit tier prices; identity is unchanged |
| POST   | `/price-tiers`          | Add a named manual price tier                                                                                  |
| POST   | `/machines`             | Create a machine and its delivery-history reference                                                            |
| POST   | `/machines/:id`         | Edit machine details and assign a price tier                                                                   |
| GET    | `/machines/:id/history` | Latest 200 delivery/removal lines, including legacy movements                                                  |
| POST   | `/machines/:id/refills` | Atomically post multiple products from one warehouse or van                                                    |

Product fields include `sku`, `name`, `unitLabel`, `packLabel`, `unitsPerPack`, `defaultEntryUnit` (`EA` or `PACK`), `barcode`, `packBarcode`, `supplierName`, nullable `purchaseCost`, and `prices: [{ tierId, amount }]`. Costs and prices are decimal strings per individual unit. Omit a tier price to leave it unset.

Stock payloads additionally accept `entryUnit` (`EA` by default or `PACK`) and `expectedUnitsPerPack`. The server calculates base quantities and rejects stale pack conversions.

Refill payloads use `sourceLocationId`, optional `note` and `lines: [{ productId, quantity, entryUnit, expectedUnitsPerPack }]`. Use an `Idempotency-Key`. Both warehouse and vehicle sources are supported; choose the source representing where goods actually came from, so stock is not deducted twice.

## Next milestones

See [architecture and roadmap](docs/architecture.md). Mobile offline sync, cash custody, accounting, machine hardware commands, notifications and subscriptions are not implemented in this milestone.
