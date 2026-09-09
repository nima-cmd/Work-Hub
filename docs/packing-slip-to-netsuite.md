# Packing slip → NetSuite: the rules, and what each one cost

Reference for porting the container import into Work-Hub. Everything here was
learned in Naghedi-Warehouse over months of failed imports; the point of writing it
down is that none of it is obvious from reading the CSV format.

⚠️ **Naghedi-Warehouse is not modified by this work.** It has its own session. This
document is the handoff — read it there before changing anything, and see
[The carton double-count](#the-carton-double-count) which that repo still has.

---

## The two documents, and why one slip makes both

| Output | Needs | Does NOT need |
|---|---|---|
| **Item Receipt CSV** | PO, SKU, total units, order line | which carton anything was in |
| **Inventory Transfer CSV** | PO, SKU, total units, from/to location | which carton anything was in |
| **The warehouse app's bin map** | PO → carton N → SKUs and quantities | order lines, locations |

Nima, 2026-09-09: *"We dont care what units are in a box in our import file but the
app does need to know what po whta units are in what box."*

So `parseRawFactorySlip` emits both `skuTotals[]` and `cartons{}` from one pass.
Collapsing either into the other loses something real.

---

## Reading the slip

### Units come from PACK/CTN × carton count — never from the QUTY total

A slip's last row is a **grand total**: carton count in `CTNS`, unit total in
`QUTY`, no style. Merged cells are filled downward, so that row inherits the style
above it and looks like a real line.

- Reading units from `QUTY` doubles every container.
- Reading `PACK/CTN` × carton count cannot, because the totals row leaves
  `PACK/CTN` empty.

⚠️ In the original that was **luck, not a guard** — see below.

### A carton range is cartons, not a quantity

`CTNS NO.` of `3-6` with `PACK/CTN` 11 means **four cartons of eleven** — 44 units
and four separate places to look on the floor.

### A continuation row belongs to the carton above it

A mixed carton lists its second SKU on a row with **no `CTNS NO.`**. Carton 11 of
the air slip holds 6 Bluff + 6 Canyon that way.

### Rows that are not product

| Condition | Why |
|---|---|
| PO matches `/cancel/i` | cancelled production never arrives |
| style is `paper` | packing material |
| style is purely numeric (`79.85`) | customs/weight footer leaking into the style column |
| style empty but a quantity present | surfaced in `skipped[]`, never dropped silently |

### The carton double-count

⚠️ **Naghedi-Warehouse reports 110 cartons for a 55-carton container, and 22 for an
11-carton air shipment.** Measured 2026-09-09 on
`55 Container 2026.9.7` and `11 Air 1820 1777`.

The totals row inherits a style through fill-down, so its own carton count is added
to the sum of the parts. Units escape because quantity comes from `PACK/CTN`, which
that row leaves empty — the same protection was never applied to the carton tally.

**Its box CONTENTS are correct** (built from `CTNS NO.` ranges, guarded by
`perCartonQty > 0`), so only the summary figure is wrong. Work-Hub's port requires
`PACK/CTN` before counting *anything*, which fixes both together.

---

## The Item Receipt CSV

```
External ID, Created From, Date, Memo, Item, Order Line, Quantity, Receive, To Location
```

| Field | Value |
|---|---|
| External ID | `EXT-IR-<containerLabel><poDigits>` |
| Created From | `Purchase Order #PO1705` — the **full display name**, which is what the import resolves by Name |
| To Location | `China` |

### ⚠️ Receive = F rows are mandatory, not optional

Emit `Receive = T` for what shipped **and `Receive = F` for every other still-open
line on that PO**.

**Without the F rows NetSuite auto-receives all remaining open lines** — pulling in
units from future shipments. This is the single most expensive lesson in the file.

### ⚠️ But exclude already-fully-received lines from the F rows

A closed line has nothing left to match, and the import fails with:

> `Unable to find a matching line for sublist expense`

Safe to skip, because a closed line has no remaining balance to protect from
auto-receiving.

### ⚠️ Sort T and F together, ascending by order line

**NetSuite's Standard Item Receipt form anchors the receipt on the first CSV row it
sees.** Line 1 must come first when it is still open. Not two blocks — one sorted
sequence.

### The four guards, and what each catches

| Guard | Condition | Action |
|---|---|---|
| **Unknown PO** | PO absent from the open-PO data | skip all its rows, flag. Usually already fully received/closed — no order lines and no `Created From` to build from |
| **Unmatched line** | shipped SKU with no open line on that PO | leave off the file, flag. Already received, wrong PO, or a size never ordered |
| **Over-receive** | shipped > **remaining** (ordered − already received) | flag. ⚠️ Compare against *remaining*, not gross ordered, or partially-received POs slip through |
| **Duplicate SKU** | one SKU on two lines of a PO | flag for manual handling. Line data keyed `PO+SKU` cannot represent both, and neither `Order Line` nor match-by-item can reliably pick |

`overReceives` being non-empty should **block** the export until resolved.

---

## The Inventory Transfer CSV

```
External ID, Memo, Date, From Location, To Location, PO #, Style Number, Color, Item, Quantity, Purchase Order
```

- External ID `EXT-<containerLabel><poDigits>` — the Item Receipt's key minus `IR-`
- **Import AFTER the Item Receipt.** You cannot transfer units you have not received
- One transfer per PO: China → the PO's **Final Naghedi Destination**
- Skip the PO+SKU lines the receipt could not receive — held for physical inspection
- ⚠️ A PO with a blank Final Destination falls back to the receiving location or
  `Warehouse`, which is the **wrong destination** — flag it so it is filled in
  before anything ships

---

## What Work-Hub adds

### PO line data comes from NetSuite, not localStorage

The floor app reads PO location, vendor, order lines and remaining quantities from
`localStorage`, populated when someone manually imports a "PO Warehouse View CSV".

Work-Hub has all of it live — `warehousePoLineSql()` already returns:

```
vendor · status · duedate · final_destination · po_location
sku · qty_ordered · qty_received · line_seq · rate
```

`final_destination` is `custbody_acs_final_destination` — exactly what the Transfer
needs. So a manual step disappears and the guards get fresher inputs.

### SKU validation against the live catalogue

The floor app validates against `sku_catalog`, a manual-CSV mirror that goes stale.
Work-Hub has `weaver_netsuite_item` — 4,276 rows, synced live. Same staleness that
made the `SN03014LD-MOCHA` hang tag fail.

### Post-import verification

Nima, 2026-09-09: *"with this in the app we can check if we over-received if the
import did anything weird or if it didn't do what we expected."*

Only Work-Hub can do this, because it holds both sides:

| Check | Expected | Actual |
|---|---|---|
| Did every line receive? | slip's `skuTotals` | the Item Receipt's lines in NetSuite |
| Over-received? | slip quantity | `qty_received` vs `qty_ordered` |
| Did the transfer happen? | one per PO | `EXT-<label><po>` exists |
| Received but never transferred | — | IR exists, TO does not ⚠️ |

The External IDs are **deterministic**, so the pairing needs no stored link:

```
EXT-IR-321 carton 2026.7.101706  →  IR1869
EXT-321 carton 2026.7.101706     →  TO200
```

Verified live: 134 such records already exist, and the `IR`/`TO` pairs line up
across every container.

⚠️ **Two records do not follow the pattern** — `EXT-po1747 Preorder Item` and
`EXT-PO1616Transfer`, both hand-made. So a missing key means *"no generated pair
found"*, never *"nothing happened"*.

---

## Provenance

Derived from Bita's standalone script, then built into Naghedi-Warehouse. Before
porting, both were run against `55 Container 2026.9.7` and `11 Air 1820 1777`:
**every PO+SKU quantity identical** — 44 rows / 1,439 units and 4 rows / 150 units,
zero differences. Two independent implementations agreeing on unseen files is why
the port is a lift rather than a rewrite.

Both slips and both reference CSVs are committed as fixtures in
`test/fixtures/packing-slips/`.
