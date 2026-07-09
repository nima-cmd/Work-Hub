# NetSuite consolidated "Warehouse Order Pipeline" saved search

## Goal

Replace four separate CSV exports —
`WarehouseOpenSalesOrders`, `Item Fulfilment unpacked`, `Pending Orders`,
`invoiced order pending status` — with **one Sales-Order-centric saved search**
that shows, per order, its pipeline stage and whether it needs attention.

> **Status: DESIGN TEMPLATE.** The field and status internal IDs below follow
> NetSuite defaults. They MUST be verified against the Naghedi account once the
> NetSuite MCP connection is re-authenticated. Once I can read the live schema,
> I can produce the exact definition (and export the search) instead of a
> template.

---

## Search type

**Transaction** saved search, filtered to Sales Orders. Base it on the same
grouped approach as the current `WarehouseOpenSalesOrders` search (Main Line =
false, grouped by Document Number) so quantities roll up per order.

## Criteria (filters)

- **Type** = Sales Order
- **Status** = any of: Pending Approval, Pending Fulfillment, Partially
  Fulfilled, Pending Billing/Partially Fulfilled, Pending Billing
  (everything not yet Closed / fully Billed & Shipped — tune to taste)
- optional: **Main Line** = false (so line quantities are available to SUM)

## Result columns

**Header** (use *Maximum* when grouped by Document Number):
Document Number (SO#) · Company Name · Status · Is ATS Order · PO/Check Number ·
Start Date · End/Ship Date · Cancel Date

**Quantities** (*Sum*):
Quantity (ordered) · Quantity Committed (allocated) · Quantity Fulfilled/Received

**Item Fulfillment** (via the *Fulfilling Transaction* join, *Maximum*):
IF Document Number · IF Status (Picked/Packed/Shipped) · IF Date ·
your custom `IF-Packed-Status` field if it exists

**Invoice / payment** (via the applying / created-from join, *Maximum*):
Invoice Number · Invoice Status (Open / Paid In Full) · Amount Remaining ·
payment-approval / shipping-status custom field

---

## Derived columns (formulas)

These are the reason one search can replace four. Verify field IDs + status
strings live before trusting them.

### PIPELINE STAGE — Formula (Text)

```sql
CASE
  WHEN {status} = 'Sales Order : Pending Approval'
       THEN '0 - Awaiting approval'
  WHEN {quantitycommitted} < {quantity}
       THEN '1 - SHORT: allocation decision needed'
  WHEN {status} IN ('Sales Order : Pending Fulfillment','Sales Order : Partially Fulfilled')
       AND {fulfillingtransaction.status} IS NULL
       THEN '2 - Open: create Item Fulfillment'
  WHEN {fulfillingtransaction.status} = 'Item Fulfillment : Picked'
       THEN '3 - Picked: needs packing'
  WHEN {fulfillingtransaction.status} = 'Item Fulfillment : Packed'
       AND {status} LIKE 'Sales Order : Pending Billing%'
       THEN '4 - Packed: needs invoice'
  WHEN {status} LIKE 'Sales Order : Pending Billing%'
       THEN '5 - Invoiced: pending payment'
  ELSE '6 - Approved / ready to ship'
END
```

### SHORT flag — Formula (Text)  *(the "ask a person" case)*

```sql
CASE WHEN {quantitycommitted} < {quantity}
     THEN 'SHORT ' || TO_CHAR({quantity} - {quantitycommitted}) || ' units - INQUIRE'
     ELSE '' END
```

### Aging — Formula (Numeric)

```sql
-- days since the IF was created (packing aging); falls back to SO date
NVL({today} - {fulfillingtransaction.trandate}, {today} - {trandate})
```

### "Lost visibility" alert — Formula (Text)  *(the lost-IF-paper problem)*

```sql
CASE
  WHEN {fulfillingtransaction.status} = 'Item Fulfillment : Picked'
       AND ({today} - {fulfillingtransaction.trandate}) > 3
       THEN 'Picked ' || TO_CHAR({today} - {fulfillingtransaction.trandate})
            || 'd ago, not packed - confirm warehouse has it'
  WHEN {status} = 'Sales Order : Pending Fulfillment'
       AND ({today} - {trandate}) > 3
       THEN 'Approved ' || TO_CHAR({today} - {trandate})
            || 'd, no fulfillment - IF may be lost'
  ELSE '' END
```

---

## Known caveats

- **Multiple Item Fulfillments per SO → multiple rows.** Use *Maximum*/summary
  to collapse, or accept extra rows (most orders have one IF; partial shipments
  create more).
- **Payment / "approved to ship" / box weight** are often custom or manual
  fields — include your existing custom fields (e.g. `IF-Packed-Status`) by
  their internal IDs.
- **Verify every `{field}` and status string** against the live account —
  internal IDs and status labels vary by NetSuite configuration.

---

## How this connects to the EDI base

The EDI base already proves the join model we reuse for reconciliation:

| Link | Key |
|------|-----|
| 850 Tracker ↔ 856 | **Business Number** (the PO) |
| 856 ↔ NetSuite Fulfillments | **BOL** (PO DC Identifier) |
| 850 Tracker ↔ NetSuite Fulfillments | PO ↔ Item Fulfillment |

So the keys stitching **NetSuite ↔ Orderful** are **PO / Business Number** and
**BOL (PO DC Identifier)**. This saved search should therefore also expose
**PO#** and, for EDI trading-partner orders, **BOL**, so each EDI order can be
auto-matched to its 850/856 in the app.

---

## ✅ VERIFIED SuiteQL — open-SO / fulfillment stage (tested live 2026-07-07)

This is the app's actual query for the fulfillment side of the pipeline. It was
run against the live account and reproduces `Warehouse Open Sales Orders`
exactly, plus derives stage, aging, and the SHORT flag.

**NetSuite gotchas confirmed live:**
- SO line `quantity` is stored **negative** → wrap in `ABS()`.
- `transaction.status` is a **single letter** (not `SalesOrd:F`): `A` Pending Approval,
  `B` Pending Fulfillment, `D` Partially Fulfilled, `E` Pending Billing/Partial,
  `F` Pending Billing, `G` Billed, `H` Closed, `C` Cancelled.
- Customer via `BUILTIN.DF(t.entity)` (comes with an entity-id prefix like `494 Level Shoes`).
- Line filter: `tl.mainline = 'F'` and `tl.itemtype = 'InvtPart'` to get item lines only.
- `SYSDATE - t.trandate` = days open.

```sql
SELECT
  t.tranid AS so,
  BUILTIN.DF(t.entity) AS customer,
  CASE t.status
    WHEN 'A' THEN '0 - Awaiting approval'
    WHEN 'B' THEN '2 - Open: needs fulfillment'
    WHEN 'D' THEN '2 - Partially fulfilled'
    WHEN 'E' THEN '3 - Pending billing / partial'
    WHEN 'F' THEN '4 - Pending billing: needs invoice'
  END AS stage,
  ROUND(SYSDATE - t.trandate) AS days_open,
  ABS(SUM(tl.quantity)) AS qty_ordered,
  SUM(NVL(tl.quantitycommitted,0)) AS allocated,
  SUM(NVL(tl.quantityshiprecv,0)) AS fulfilled,
  CASE WHEN SUM(NVL(tl.quantitycommitted,0)) + SUM(NVL(tl.quantityshiprecv,0)) < ABS(SUM(tl.quantity))
       THEN 'SHORT ' || TO_CHAR(ABS(SUM(tl.quantity)) - SUM(NVL(tl.quantitycommitted,0)) - SUM(NVL(tl.quantityshiprecv,0))) || ' - INQUIRE'
       ELSE '' END AS short_flag
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type = 'SalesOrd'
  AND t.status IN ('B','D','E','F')
  AND tl.mainline = 'F'
  AND tl.itemtype = 'InvtPart'
GROUP BY t.tranid, BUILTIN.DF(t.entity), t.status, t.trandate
ORDER BY days_open DESC
```

**Still to add (next iteration):** join Item Fulfillments (`type='ItemShip'`,
`createdfrom = SO`) for picked/packed status + packing aging, and Invoices
(`type='CustInvc'`) for the pending-billing → payment tail. That turns this into
the full single-query lifecycle.

---

## ⚠️ Architecture decision: CSV export, not live API

The NetSuite MCP/SuiteQL connection is **highly unstable**, so the app does **not**
query it at runtime. Instead:

- The app ingests **CSV exports of these saved searches** (the same path as the
  Step-1 analyzer).
- The SuiteQL above is a **design/verification aid** — proof of the logic and a
  spec for what columns each saved search should output. It is *not* wired into
  the app.
- When a stable NetSuite API exists, we swap the ingest source without changing
  the pipeline logic.

**So "refine the search" here means: make sure each saved search's exported
columns carry what the app needs.** Concretely:

| Saved search | Must export |
|---|---|
| Open Sales Orders | Document #, **Is ATS Order**, PO/Check #, qty ordered/allocated/fulfilled, start/end/cancel dates, customer |
| **PO receiving (NEW — we don't have this yet)** | PO #, linked SO(s)/item, status (in transit vs received), **expected receipt / ETA**, qty |
| Item Fulfilment (picked/packed) | IF #, created-from SO, packed status, date |
| Invoiced status | SO #, INV #, shipping/approval status, amount, ship date |

## ATS-aware shortage rule (implemented in `src/model/pipeline.js`)

- **ATS + short** → `STOCK_SHORT` (real exception, act now).
- **Non-ATS + short** → `AWAITING_PO` (normal — presold, waiting on its container).
- **Non-ATS + short + PO already received** → *(open TODO)* real stall / lost
  visibility. Needs the new **PO receiving** CSV above to detect. This is the
  highest-value next data source.

## Open ends (things to revisit)

- ATS field: confirm exact NetSuite field/column name in the export.
- Row multiplication when an SO has multiple IFs.
- EDI orders (ShopBop / Nordstrom / Bloomingdale's) need ship-window + ASN
  (856/810) compliance columns for chargeback prevention.
- Everything here is intentionally kept modular so we can go back and adjust
  column mappings without touching the pipeline logic.

---

## PO-receiving saved search (spec to build in NetSuite + export)

Purpose: give the app inbound supply so it can (a) answer *"when is this short
order covered?"* and (b) detect the real stall (non-ATS short whose PO is already
received).

- **Search type:** Transaction → **Purchase Order**
- **Criteria:** Status = Pending Receipt / Partially Received (open POs); optionally
  Type = Purchase Order only.
- **Columns (line level, `mainline = 'F'`, item lines):**
  - Document Number (PO#)
  - Vendor / supplier
  - Status
  - **Expected Receipt Date** (`expectedreceiptdate`) — the ETA that drives "covered by ~date"
  - Item
  - Quantity ordered / Quantity received / Quantity remaining
  - **Linked OC/SO #** — whatever custom field currently holds the manually-entered
    Order Confirmation number on the PO (so the app can read existing links)
  - Memo / container reference if used

Match key to demand: **item** (PO item ↔ short SO item) and/or the **linked OC#**.

## Connecting NetSuite documents (strategy)

NetSuite has no native link for some of the connections Naghedi maintains by hand.
Strategy: derive what we can, and make the app the single source of truth for the rest.

| Link | Native in NetSuite? | Approach |
|---|---|---|
| IF ↔ Invoice | Not directly (both are siblings created from the SO) | **Derive** in the app by matching on the shared **SO** (`createdfrom`). No manual entry. Flag SOs with multiple IFs/invoices for line-level matching. |
| SO/IF ↔ SO (parent) | Yes (`createdfrom`) | Use natively. |
| OC ↔ PO (bulk container) | **No** (only special-order/drop-ship POs link natively) | **App is the source of truth**: link once in the app (allocation), it maintains both directions, powers short→ETA, and can write back to NetSuite (or generate paste values) when the API is stable. Replaces today's dual manual cross-reference. |

Open question to confirm: the **exact custom-field names** currently holding the
manual OC#-on-PO and PO#-on-OC, so the app can ingest the links already entered.

---

## v2 — Consolidated, location-aware spec (2026-07-08)

Since the data now lives in the **app** (not read visually in NetSuite), searches
no longer need to be view-rigid. Goal: **fewer, data-first searches that cover
ALL locations.** Verified live why this matters — open orders by location:

| Location | Open orders | In current searches? |
|---|---|---|
| Bloomingdale's (EDI) | 33 | ❌ missing |
| Warehouse (boutique) | 24 | ✅ |
| Nordstrom (EDI) | 7 | ❌ missing |
| China (inbound) | 6 | ❌ |
| Shopbop (EDI) | 2 | ❌ missing |

**42 EDI orders were invisible** to the current warehouse-only searches — because
they filtered to the Warehouse location. The consolidated search fixes this by
**not filtering on location** and carrying location as a column instead.

### Search 1 — "Order Pipeline" (SO-centric) — replaces all four current searches
- Transaction / Sales Order; open statuses (`B`,`D`,`E`,`F`); **no location filter**.
- Columns (raw, app-facing — visual order irrelevant): SO#, **Location**,
  **Final Naghedi Destination**, Customer, **Is ATS Order**, PO/Check#, Qty
  ordered / committed / fulfilled, Status, Start / Ship / Cancel dates; joined
  **IF#, IF status, IF-Packed-Status, IF date**; joined **Invoice#, invoice
  status, shipping/approval status, amount**.
- Channel derived from Location (ecom / boutique / EDI / wholesale) — see
  the location→channel map in memory.

## ✅ VERIFIED live 2026-07-08 — field internal IDs confirmed

Queried NetSuite's custom-field catalog directly and validated every field
below against live data (not just the metadata schema):

| Label | Internal ID | Lives on | Notes |
|---|---|---|---|
| Is ATS Order | `custbody_ats_order` | Sales Order (body) | List/Record → decode with `BUILTIN.DF()`. Live: 5,277 No / 468 Yes / 32 blank. |
| Final Naghedi Destination | `custbody_acs_final_destination` | **Purchase Order only** — always `NULL` on Sales Orders | ⚠️ Correction to the v1 draft above: this field does **not** exist on the SO side, so drop it from Search 1's columns. It belongs in Search 2 (PO-centric) only. Live PO values: Shopbop, Nordstrom, Bloomingdale's, Warehouse, Virtual Warehouse, China. |
| PO/Check Number | `otherRefNum` (standard field) | Sales Order (body) | Manually entered customer PO#, e.g. EDI buyer POs like `50073688`. |
| Location (demand side) | `tl.location` (line-level) | Sales Order line | Decode with `BUILTIN.DF()`. This is the field the OC↔PO matcher should join on for the demand side. |

**Also checked and ruled out as the OC↔PO link:** `custbody_hb_edi_assoc_pos`
("EDI Associated POs") exists on the Sales Order but is populated on **0 of
5,777** live SOs — confirmed dead/unused. This closes the CLAUDE.md open
question: **there is no existing NetSuite field holding a manual OC↔PO
link.** The app owning that mapping (`oc_po_links`) is confirmed correct,
not just an assumption.

**Still unverified:** the `IF-Packed-Status` custom field referenced in
`src/ingest/savedSearches.js` — it's likely a field on the Item Fulfillment
record type, not Sales Order, so it didn't surface in this pass. Verify
separately when building the IF join.

Verified SuiteQL core, tested live and returns real rows (extend with the
IF/Invoice joins from the tested query above):
```sql
SELECT
  t.tranid AS so,
  BUILTIN.DF(t.entity) AS customer,
  BUILTIN.DF(tl.location) AS location,
  BUILTIN.DF(t.custbody_ats_order) AS is_ats,
  t.otherrefnum AS po_check_number,
  t.startdate AS start_date,
  t.enddate AS end_date,
  t.status,
  ROUND(SYSDATE - t.trandate) AS days_open,
  ABS(SUM(tl.quantity)) AS qty_ordered,
  SUM(NVL(tl.quantitycommitted,0)) AS allocated,
  SUM(NVL(tl.quantityshiprecv,0)) AS fulfilled
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type='SalesOrd' AND t.status IN ('B','D','E','F')
  AND tl.mainline='F' AND tl.itemtype='InvtPart'
GROUP BY t.tranid, BUILTIN.DF(t.entity), BUILTIN.DF(tl.location),
         BUILTIN.DF(t.custbody_ats_order), t.otherrefnum, t.startdate, t.enddate, t.status, t.trandate
ORDER BY days_open DESC
```

### Search 2 — "Open POs / Receiving" (PO-centric) — for the non-ATS-OC↔PO pain
Different record type, so it stays separate (net consolidation: **4 → 2**).
- Transaction / Purchase Order; open (Pending / Partially Received).
- Columns: PO#, Vendor, **Final Naghedi Destination**, Item, Qty ordered /
  received, **Expected receipt date**, Status.
- **Match non-ATS OCs to POs on: Item + Final Naghedi Destination.** For
  Bloomingdale's / Holt Renfrew / Nordstrom / Saint Bernard / Shopbop, the final
  destination equals the SO's location — so an OC at location X joins to POs
  whose final destination is X carrying the same item. This is the #1 pain point.

### Result
4 rigid, location-limited searches → **2 data-first searches** covering every
location. EDI 856/810 status can be a later third feed (or come from Orderful
directly). The app supplies all visual structure, so these stay lean.

---

## ✅ VERIFIED live 2026-07-09 — ONE search IS enough for the outbound pipeline

**The key question: can a single Sales-Order search carry IF + Invoice status
so we don't juggle four exports? Answer: YES.**

Tested live via `PreviousTransactionLink` (the `createdfrom` column errors on
this connection, but the link table is queryable). For all **76 open Sales
Orders**:

| | Item Fulfillments per SO | Invoices per SO |
|---|---|---|
| Maximum | **1** | **1** |
| SOs with more than one | **0** | **0** |

Because every open SO has **at most one IF and at most one Invoice**, a single
**grouped** Sales-Order saved search can pull all the IF and invoice fields via
joins using **Maximum** aggregation — with no row multiplication and no hidden
records. (An earlier count showing "18 multi-invoice" was a link-table artifact:
the same invoice is listed once per line, e.g. INV11314 appeared twice for
SO12043. Deduping with `COUNT(DISTINCT)` confirmed 1:1.)

### The consolidated "Warehouse Order Pipeline" search — full column list

Keep the current grouped SO search (grouped by Document Number) and **add these
join columns**. In the saved-search UI these live under the **Fulfilling
Transaction …** field group (the Item Fulfillment) and the **Applying
Transaction …** / billing field group (the Invoice). Use **Maximum** for each
(safe, since 1:1).

**Already have (keep):** Document Number · Company Name · Location · Is ATS Order
· PO/Check Number · Start Date · End Date · Status · Approval Status ·
Sum Quantity / Quantity Committed / Quantity Fulfilled.

**Add — Item Fulfillment (via Fulfilling Transaction join, Maximum):**
- IF Document Number  → the IF# (drives Picked/Packed/Shipped bins)
- IF Status           → Picked / Packed / Shipped
- IF-Packed-Status (the custom field: Approved to Ship / FOB… / Pending Invoice / Waiting On Payment)
- IF Date             → the day it entered that status (when it was printed/picked)

**Add — Invoice (via the billing/Applying Transaction join, Maximum):**
- Invoice Number      → the INV# to print for the shipment
- Invoice Status      → Open / Paid In Full
- Invoice Shipping Status → Pending Payment / FOB Pending Approval / Approved For Shipping
- Amount Paid / Amount Remaining

That single export replaces all four current files and carries everything the
app needs to place an order in its bin and show the right next action + related
document. **This is the target.**

### Honest caveats before flipping the switch
1. **Field-label discovery is the only unknown.** The 1:1 data relationship is
   proven; what still needs confirming when building it is the exact UI labels
   for the Fulfilling-Transaction and Invoice join field groups (the
   `createdfrom`-based SuiteQL is too unstable on this connection to prototype
   the join, but the saved-search UI exposes these joins directly). Same
   validate-the-export loop we've used all along: Nima builds it, exports a test
   CSV, we confirm the columns carry correctly, then I add the single-file
   mapper and retire the other three.
2. **1:1 holds for OPEN orders today; multi-document is an accepted edge case.**
   Partial shipments (one SO → multiple IFs or invoices) can happen even though
   none exist among open orders right now. **Decision (Nima, 2026-07-09): do NOT
   engineer full multi-document tracking.** The grouped "Maximum" row shows the
   furthest IF/invoice, and those rare cases are reviewed **manually in-app +
   NetSuite** (where detail not present in any saved search is available anyway).
   The ONE requirement so this stays safe: the app must **flag** multi-document
   orders rather than silently hide them. Mechanism: add **Count of Item
   Fulfillments** and **Count of Invoices** columns to the consolidated search
   (standard summary type); the app raises a `MULTI_DOC` flag ("multiple
   documents — review in NetSuite") whenever either count > 1. Watch for the
   per-line link fan-out we already saw (an invoice counted once per line) — the
   count must be DISTINCT; validate it on the test export.
3. Until the consolidated search is built and validated, the **four current
   searches remain the source of truth** — see the freshness list below.

### Required exports the app currently expects (until consolidation lands)
The app now tracks each of these independently and flags which one is stale:

| Source (detected by columns, not filename) | Feeds | Stage(s) it drives |
|---|---|---|
| Warehouse Order Pipeline (SO-centric) | demand, qty, ATS, approval, location | On Hold · Open |
| Item Fulfilment (Picked/Shipped) | IF#, IF status, IF date | Picked · Shipped |
| Pending Orders (Packed) | IF-Packed-Status, days pending, invoice-for-IF | Packed |
| Invoiced Order Pending Status | INV#, shipping status, amount paid | Invoiced · Approved |

When the consolidated search lands, this list collapses to a single row.

---

## ✅ Join proven end-to-end 2026-07-09 — build checklist

The SO→IF and SO→Invoice joins were run live and return correct, current data
(via `PreviousTransactionLink`; sample below). Notably **Eleanor SO12117 → IF7280,
Picked, 7/8** — exactly the case the stale 4-search setup was getting wrong — so
the consolidated search fixes those on day one.

Sample (real):
```
SO12043 → IF7228 Packed 6/19   | INV11314 Open
SO12074 → IF7214 Shipped 6/11  | INV11277 Paid In Full
SO12117 → IF7280 Picked 7/8    | (no invoice yet)
SO12179 → IF7190 Packed 6/4    | INV11237 Paid In Full
```

### What's MISSING from today's export (the 12 columns you have now)
Everything below needs adding. Grouped by the join it comes through:

**A. Item Fulfillment** — add via the **Fulfilling Transaction** field group, each as *Maximum*:
- Fulfilling Transaction: **Document Number** → IF#
- Fulfilling Transaction: **Status** → Picked / Packed / Shipped  *(standard status — verified live)*
- Fulfilling Transaction: **Date** → the day it entered that status
- Fulfilling Transaction: **IF-Packed-Status** → the workflow field you already
  show in "Pending Orders" (Approved to Ship / FOB… / Pending Invoice / Waiting On
  Payment). Add it by that same label. *(Not `custbody_operational_status` — that
  field reads NULL live; pick the same one your Pending Orders search uses.)*

**B. Invoice** — add via the **Applying Transaction** / billing field group, each as *Maximum*:
- Invoice: **Number** → INV# (the number to print for the shipment)
- Invoice: **Status** → Open / Paid In Full  *(standard status — verified live)*
- Invoice: **Shipping Status** → Pending Payment / FOB Pending Approval / Approved
  For Shipping. Add by the same label your "Invoiced Order Pending Status" search uses.
- Invoice: **Amount Remaining** (or Amount Paid) → for the payment check

**C. Two SO-level date columns** the current export drops but the calendar/overdue
logic needs:
- **Ship Date** (target ship date)
- **Cancel Date** (ship-by-or-lose-it; critical for EDI chargebacks)

### Standard vs. custom
The IF **Status** and Invoice **Status** are *standard* NetSuite fields (proven
live). The two workflow fields (**IF-Packed-Status**, **Invoice Shipping Status**)
are the custom fields you already surface in the current searches — add them to
the consolidated search by the identical label. Their exact internal IDs aren't
needed to add columns in the UI, and I'll confirm they carry correctly the moment
you export a test CSV.

### Then (app side)
Once the test export exists, I add a single tolerant mapper for it (keyed by
column name, like every other mapper), point ingest at just that one file, and
retire `unpackedFulfillments` / `pendingOrders` / `invoicedPending` from
`REQUIRED_SOURCES` — the freshness panel then shows one source.

