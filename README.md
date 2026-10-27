# VendingOT

An operations platform for Island Vending, starting with traceable stock movements.

**Current milestone:** supplier records and product–supplier links, atomic multi-item supplier receiving, product and machine records with permanent incremental IDs, pack-aware stock entry, explicit per-product price tiers, and multi-item machine refills. Warehouse and van stock are tracked; machines show delivery history, never a claimed current stock balance.

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

Restart the API with `npm run dev -w @vendingot/api` and the web in another terminal with `npm run dev -w @vendingot/web`. These separate commands work in Windows PowerShell too. Do not delete your database volume. Migrations retain products, machines and transaction history. Migration 002 assigns permanent numbers; migration 004 converts existing nonempty supplier names into supplier records and links, merging case/space variants within each business. Existing products keep a one-unit pack until you configure their actual packaging; fresh seed records use twelve-bottle water packs.

## Test the complete supplier → warehouse → machine flow

1. In **Products**, edit Water: individual unit Bottle, pack name Pack, **12 units per pack**, default entry Packs. Set its unit/pack barcodes if available. Save it.
2. Add an **Airport** price tier and enter selling prices separately: Default SCR 10 and Airport SCR 15 per bottle. These selling prices are independent of supplier purchase costs.
3. In **Suppliers**, create a supplier with its legal name, contact person, phone, email, address and SCR currency. Open it.
4. Under **Supplied products**, select Water. Enter the supplier’s product reference, ordering unit **Case**, **24 individual units per ordering pack**, and purchase cost **SCR 5.25 per individual bottle**. Mark it preferred if desired and save the link. A supplier case can differ from the product’s normal twelve-bottle pack.
5. Click **Receive delivery**, select Main warehouse, enter a unique invoice/delivery reference and the received date. Add Water and enter **5 cases × 24 = 120 bottles**. Review **SCR 630** goods value. More linked products can be received on the same document.
6. Post the delivery. Warehouse stock increases by 120 bottles once. Expand **View items** in delivery history to see the supplier pack conversion, actual unit costs and original total.
7. In **Machines**, add/open a machine assigned to Airport. Select **Fill up**, choose the warehouse, add Water and enter **7 product packs × 12 = 84 bottles**. Save the refill.
8. Starting with no stock, the warehouse now has **36 bottles**. Existing balances change this total. The machine records an 84-bottle delivery, not current stock or sales.

Supplier links can also be managed by selecting **Edit** on a product. Each product may have several suppliers and one preferred supplier. Link costs and actual delivery costs are separate: receiving does not silently overwrite your supplier’s saved cost. Supplier cost changes are visible through **Cost history**.

**Safety checks to try:** submit the same supplier/reference again (it must be rejected); deactivate a supplier (new receiving must stop); change a supplier’s ordering pack after preparing a delivery (the stale conversion must be rejected). Different suppliers may use the same invoice reference. Supplier/product names, packaging and costs are snapshotted on deliveries so later edits do not rewrite history.

Both deliveries and refills post all lines or none, and retries cannot add/deduct stock twice. Existing stock corrections remain under **Reverse** in inventory history. Original delivery values remain visible with a stock-correction label; they are not supplier payable balances. Separate taxes, fees, discounts, payments, purchase orders and full delivery-wide reversal are future work. Currency is optional display text with SCR as the default. Different labels never block receiving or change amounts; no conversion is performed.

Use **Record movement → Opening / manual stock** only for opening/test stock, not normal supplier deliveries. Named suppliers are received through **Receiving**, with their reference and costs. Products and machines keep separate permanent number sequences; supplier IDs are also permanent. Keyboard shortcuts remain deferred.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Integration tests require the migrated database. Each creates its own synthetic tenant and never resets development records. Tests cover permanent numbering, supplier contacts/status, multiple suppliers and preferred links, cost history, supplier-specific ordering packs, exact actual delivery costs, duplicate invoices/retries, atomic receipt/refill rollback, cross-business isolation, stock posting, reversals and immutable snapshots. Test fixtures remain in the local database under separate tenants.

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

Supplier endpoints:

| Method | Route                                 | Purpose                                                          |
| ------ | ------------------------------------- | ---------------------------------------------------------------- |
| POST   | `/suppliers`                          | Create supplier and automatic permanent number                   |
| POST   | `/suppliers/:id`                      | Edit contact information or deactivate                           |
| POST   | `/supplier-products`                  | Create/update a supplier–product link                            |
| GET    | `/supplier-products/:id/cost-history` | Latest 100 saved cost changes                                    |
| POST   | `/supplier-receipts`                  | Receive all delivery lines with an Idempotency-Key               |
| GET    | `/supplier-receipts`                  | Latest 50 deliveries, original values and stock-correction flags |

Supplier input: `legalName`, `contactName`, `phone`, `email`, `address`, `currency`, `active`. The optional currency label can be edited at any time, including after products are linked; it has no posting or conversion rules. Deactivation retains records and history.

Supplier-product input: `supplierId`, `productId`, `supplierSku`, `orderUnit`, `unitsPerOrder`, nullable `unitCost`, nullable `leadDays`, `preferred`, `active`. Unit cost is a decimal string per individual unit. Currency text is only a display label. Each supplier/product pair has one ordering format in this milestone. Only one preferred supplier is allowed per product.

Receiving input: `supplierId`, `warehouseId`, `reference`, `receivedOn` (YYYY-MM-DD), optional `note`, and `lines: [{ supplierProductId, quantity, entryUnit, expectedUnitsPerOrder, unitCost }]`. `entryUnit` is `ORDER` or `EA`; quantity is a positive whole-number string. Actual cost per individual unit is required, even if the saved supplier cost is unset. The reference is unique per business/supplier, case-insensitively; use a distinct delivery reference for separate shipments.

Product fields include `sku`, `name`, `unitLabel`, `packLabel`, `unitsPerPack`, `defaultEntryUnit` (`EA` or `PACK`), `barcode`, `packBarcode`, `prices: [{ tierId, amount }]` and the supplier links described above. Costs and prices are decimal strings per individual unit. Omit a tier price to leave it unset. Legacy `supplierName` and `purchaseCost` values remain preserved for compatibility; supplier links are authoritative for new purchasing.

Stock payloads additionally accept `entryUnit` (`EA` by default or `PACK`) and `expectedUnitsPerPack`. The server calculates base quantities and rejects stale pack conversions.

Refill payloads use `sourceLocationId`, optional `note` and `lines: [{ productId, quantity, entryUnit, expectedUnitsPerPack }]`. Use an `Idempotency-Key`. Both warehouse and vehicle sources are supported; choose the source representing where goods actually came from, so stock is not deducted twice.

## Next milestones

See [architecture and roadmap](docs/architecture.md). Mobile offline sync, cash custody, accounting, machine hardware commands, notifications and subscriptions are not implemented in this milestone.

## SCR display labels

Island Vending uses SCR. Currency is an optional text label (for example SCR or Rs), not an ISO code, a conversion setting or a reason to disable receiving. Labels can be changed after products are linked; amounts are never converted or recalculated. Existing receipt labels remain snapshots of the text shown when posted. Migration 005 corrects the earlier development-only MUR assumption to SCR for the seeded Island Vending business and its inherited MUR supplier/history labels. It changes no numeric amount, quantity, ID or invoice reference, records a correction audit event, and restores immutable-record protections before committing. Other businesses and intentional non-MUR labels are untouched.
