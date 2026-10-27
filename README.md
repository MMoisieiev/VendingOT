# VendingOT

An operations platform for Island Vending, starting with traceable stock movements.

**Current milestone:** pack-cost receiving, checked supplier invoices, outstanding debt, bank/clearing records and credit-term reminders, alongside product and machine records with permanent incremental IDs, pack-aware stock entry, explicit per-product price tiers, and multi-item machine refills. Warehouse and van stock are tracked; machines show delivery history, never a claimed current stock balance.

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

## Test supplier receiving, invoice debt and payments

1. Create a supplier under **Suppliers**. No product-linking step is required to receive goods. Set the credit term (Apex uses 30 days in the reference workbook; the default is 21).
2. Open **Receiving**, choose the supplier/warehouse, and enter invoice reference, invoice date and received date. A due-date override is optional; otherwise the supplier’s credit term is snapshotted.
3. Click **Add delivery item**, select any active product and enter its arrival pack size, quantity and **cost per arrival pack**. For example, 2 packs of 12 at SCR 100 per pack means 24 units and SCR 200 exactly. The displayed unit cost is derived to eight decimal places; totals use the original pack price, not the rounded unit cost.
4. Add more products if needed. Enter the paper invoice total. Posting requires the calculated total (rounded to cents) to match. Optional signed invoice charges/discounts need an explanation; these header adjustments are not allocated into item costs.
5. Leave **Invoice already paid** unchecked to create unpaid debt, or check it and enter payment date/reference for an already settled invoice. Posting updates stock, remembers product–supplier links/arrival packing, and updates each item’s **latest purchase cost**. It does not change selling prices or the product’s normal refill pack.
6. Open **Suppliers → supplier → Supplier account**. Select unpaid invoices and choose **Paid / cleared** or **Sent to bank · awaiting clearing**. One record may cover several complete invoices.
7. A pending bank transfer remains in outstanding debt. Use **Mark cleared** in payment history and record the clearing date to settle its invoices. Paid invoices remain in the Paid/All views, and all payment records are retained.
8. Check deadline indicators: overdue, pay now (due within two days), or not due yet. These are reminders, not restrictions on when you may pay. Supplier term edits affect new invoices; old due dates remain recorded.

A supplier case may contain 24 bottles even when the product’s normal refill pack contains 12. Receiving remembers the supplier case; machine refill continues using the product pack. Manually linking supplier products is still available for setup/default prices, but is optional. An intentionally inactive supplier/product link must be reactivated before receiving that product.

Old deliveries have no known payment status or checked invoice total. They appear under **Needs review** and do not silently become debt. Confirm the paper invoice total, then record the original payment if already paid. Old-format API requests without a checked invoice total also stay unconfirmed. Existing stock, invoice references and recorded amounts are preserved by migration.

Posting and payments are atomic/idempotent. Duplicate references are blocked per supplier; failed lines or payment allocations roll back all effects. Stock reversals do not cancel a supplier invoice or count as payment; original financial records remain. Settlements currently cover full selected invoices; partial payments, payment reversals, supplier credit notes and a general ledger are separate future workflows. The application records bank status; it never initiates bank transfers. Currency remains cosmetic SCR text.

See [purchasing specification](docs/purchasing.md) for the reference workbook mapping and API details.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

Integration tests require the migrated database. Each creates its own synthetic tenant and never resets development records. Tests cover permanent numbering, stock/refill invariants, automatic supplier links, exact pack costs, invoice matching, latest cost updates, duplicate invoices/payments, multi-invoice settlement, bank clearing, credit terms/deadlines, cross-business isolation, atomic rollback and immutable history. Test fixtures remain in the local database under separate tenants.

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

Receiving input: `supplierId`, `warehouseId`, `reference`, `receivedOn` (YYYY-MM-DD), optional `note`, and `lines: [{ supplierProductId, quantity, entryUnit, expectedUnitsPerOrder, unitCost }]`. `entryUnit` is `ORDER` or `EA`; quantity is a positive whole-number string. Use `productId` without pre-linking; send `packCost` for an arrival pack or `unitCost` for an individual unit. Checked invoice/payment fields are documented in docs/purchasing.md. Old `supplierProductId` input remains supported. The reference is unique per business/supplier, case-insensitively; use a distinct delivery reference for separate shipments.

Product fields include `sku`, `name`, `unitLabel`, `packLabel`, `unitsPerPack`, `defaultEntryUnit` (`EA` or `PACK`), `barcode`, `packBarcode`, `prices: [{ tierId, amount }]` and the supplier links described above. Costs and prices are decimal strings per individual unit. Omit a tier price to leave it unset. Legacy `supplierName` and `purchaseCost` values remain preserved for compatibility; supplier links store purchasing defaults, and received costs update the product’s latest purchase cost.

Stock payloads additionally accept `entryUnit` (`EA` by default or `PACK`) and `expectedUnitsPerPack`. The server calculates base quantities and rejects stale pack conversions.

Refill payloads use `sourceLocationId`, optional `note` and `lines: [{ productId, quantity, entryUnit, expectedUnitsPerPack }]`. Use an `Idempotency-Key`. Both warehouse and vehicle sources are supported; choose the source representing where goods actually came from, so stock is not deducted twice.

## Next milestones

See [architecture and roadmap](docs/architecture.md). Mobile offline sync, cash custody, accounting, machine hardware commands, notifications and subscriptions are not implemented in this milestone.

## SCR display labels

Island Vending uses SCR. Currency is an optional text label (for example SCR or Rs), not an ISO code, a conversion setting or a reason to disable receiving. Labels can be changed after products are linked; amounts are never converted or recalculated. Existing receipt labels remain snapshots of the text shown when posted. Migration 005 corrects the earlier development-only MUR assumption to SCR for the seeded Island Vending business and its inherited MUR supplier/history labels. It changes no numeric amount, quantity, ID or invoice reference, records a correction audit event, and restores immutable-record protections before committing. Other businesses and intentional non-MUR labels are untouched.
