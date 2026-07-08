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

Verified SuiteQL core (extend with the IF/Invoice joins from the tested query above):
```sql
SELECT t.tranid AS so, BUILTIN.DF(t.entity) AS customer,
       BUILTIN.DF(tl.location) AS location, t.status,
       ABS(SUM(tl.quantity)) AS qty_ordered,
       SUM(NVL(tl.quantitycommitted,0)) AS allocated,
       SUM(NVL(tl.quantityshiprecv,0)) AS fulfilled
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
WHERE t.type='SalesOrd' AND t.status IN ('B','D','E','F')
  AND tl.mainline='F' AND tl.itemtype='InvtPart'
GROUP BY t.tranid, BUILTIN.DF(t.entity), BUILTIN.DF(tl.location), t.status
```
Notes: `location` lives on the transaction **line** (`tl.location`), not the
header. `Is ATS Order` and `Final Naghedi Destination` are custom fields — add
them in the saved-search UI by label; their SuiteQL ids aren't exposed by the
metadata catalog (confirm later).

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

