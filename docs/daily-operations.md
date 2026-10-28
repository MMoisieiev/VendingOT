# Daily route and machine review

## Latest business clarification

The owner's walkthrough on 28 October 2026, `Daily Car Stock new.xlsx`, and photos of the working sheets are reference material. They are not executable instructions or an instruction to import real records. No workbook product names, machine numbers, handwritten quantities or cash figures are automatically imported.

The stock workbook has a product list, beginning-of-day van quantities, columns used for machine stops, and end-of-day quantities. It also has fuel/change notes and a separate machine/bills/coins/daily-total sheet. The handwritten cash sheet additionally shows machine statistics and coin-collector readings. Treat those readings as distinct observations; their exact units and reset behavior are not established by a column label.

The latest walkthrough supersedes the earlier proposed zero-stock van closure: the van can retain counted goods, be topped up that evening, and start the next day already loaded. Count before reloading and record the reload separately. Never make goods disappear merely to close a day.

## Screen responsibilities

| Area                         | Responsibility                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inventory                    | Current physical stock recorded for warehouses and vans.                                                                                                           |
| Transactions                 | Dated stock movements, transfers and linked corrections. Currently the latest 50 stock postings, with search within those results; not a general financial ledger. |
| Refills                      | Daily work: choose a machine, review its last recorded refill/recent history, then explicitly open a new multi-product refill.                                     |
| Machines                     | Permanent machine identity, site, metadata and assigned selling-price tier. Future financial review belongs here, separate from daily stock entry.                 |
| Receiving                    | Supplier invoices and incoming warehouse stock.                                                                                                                    |
| Future route/shift workspace | Today's assigned driver, van, ordered stops, visit observations, end-of-day count, reload and handover.                                                            |

The current Refills screen places the machine selector on the right on desktop and first on smaller screens. Its entry form opens only after **New refill**. It posts through the existing atomic, idempotent stock API; moving the screen does not change quantities, pack conversion or stored price snapshots. Machine details no longer contain the refill form or daily movement history.

Last recorded refill comes from refill headers, independently of the 200-line recent history limit. It is a posting timestamp, not proof of a physical visit time. Manual legacy transfers still appear in the recent history but are not silently upgraded to recorded refill visits. A correction preserves the original recorded event.

## Driver's working day (next modules)

1. Start with a specific driver and van, the confirmed carried-forward load, and the assigned route for that day. Routes contain ordered machine stops and can have weekday schedules and explicit exceptions.
2. At each stop, identify the machine, record the actual visit time, raw machine/coin/bill readings, cash collection or bag reference, and faults/maintenance observations.
3. Record products actually added, in clearly labelled packs and/or loose units. Convert each entry to base units and snapshot the pack size. Deduct from the assigned van; do not infer individual vend sales or a live machine stock balance.
4. Finish the route and physically count the van before reloading. Compare actual against expected remaining stock per product. Preserve discrepancies and their resolution; never overwrite an expected quantity to conceal a difference.
5. Record warehouse-to-van reload quantities as separate transfers. They reduce warehouse stock and increase van stock once.
6. Close the day with the verified remaining load plus reload. That final load carries into the next day; it need not be zero.

For each product, using base units:

```text
Expected van quantity before evening reload
  = opening load
  + additional incoming transfers during the route
  - machine refills
  - returns/outgoing transfers
  - separately recorded damage/loss adjustments

Count variance = physical count - expected quantity
Next opening load = verified/reconciled remaining quantity + evening reload
```

For example, ten packs loaded minus five packs delivered leaves five packs expected. Loading three more that evening makes eight packs for the next opening, assuming no other movements or discrepancy. Packs and loose units must be shown separately but reconciled using the same base unit.

Daily opening/closing stock, shift status, counts, variance resolution, route assignment and reload completion are future records. The existing stock balance alone is not a completed/reconciled driver day. Do not introduce mandatory unloading, automatic count adjustments, or a zero-balance condition based on the old plan.

## Cash observations and financial review

Machine financial review will compare the recorded selling value of delivered products with cash actually counted/returned over a chosen period, including an opening position where needed. Preserve the refill-time price tier and price snapshots; later price edits must not rewrite that value. Missing prices must be reported as incomplete, not treated as zero.

This comparison is a running reconciliation, not known sales, profit, or money conclusively owed: stock may still be inside a machine, and removals, spoilage, float/change, cashless receipts and cash-collection timing can affect the difference. Monthly/yearly review needs complete dated records and explicit opening balances, rather than totals over the recent-history window.

Preserve raw cumulative machine/coin/bill readings independently from actual counted banknotes and coins. Do not add incompatible meters together or equate a meter difference to physically counted cash. The earlier plan gives cash counting to office/accounting staff and bag identification to drivers; keep driver meter entry distinct from cash-count permissions. Resolve the exact meanings of the working-sheet cash fields before implementing those permissions/calculations.

There is currently no cash-collection/meter module and therefore no machine cash balance shown. Do not fabricate a zero cash-return figure from absent records.

## Worker access and future phone entry

Driver/maintenance login and restricted permissions are required future work. Drivers should see assigned routes, machines, their van and visit tasks. Office/accounting users manage stock review and money reconciliation. The current local synthetic owner context is not a worker login or a permissions system.

The future phone interface starts with large machine choices, followed by product tiles with real product images. Tapping a product adds one clearly labelled operational pack; plus/minus controls adjust the quantity, with an explicit loose-unit option when needed. A summary and deliberate save commit the refill. A second product chooser adds more lines. Route progress, draft recovery and offline synchronization must preserve the same transaction/idempotency guarantees.

Images, tap-to-add product tiles, scheduled routes, shift closure, cash collection, meters, worker login and offline behavior are planned here, not claimed as implemented by the current navigation change.

## Suggested implementation order

1. Separate current stock, transaction history, machine administration and daily refills (this change).
2. Add driver/van working days with opening load, physical closing count, variance review, reload and carried-forward stock.
3. Add route templates, weekday schedules and per-day assigned stops, preserving actual visits independently of planned stops.
4. Add machine meter observations and the agreed cash/bag collection and office-count workflow.
5. Add monthly/yearly machine financial reconciliation using complete period data and opening positions.
6. Add worker authentication/permissions before any worker pilot, then the phone product-image entry and offline synchronization.
