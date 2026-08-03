# Warehouse PO feed — `ns_open_po_lines`

Work-Hub pushes every **open PO item line** (statuses Pending Receipt +
Partially Received) into the Naghedi-Warehouse app's Supabase on every sync
cycle, replacing that app's manual "PO Warehouse View" CSV import. Built
2026-08-03 against the receiving-side spec; code in
`src/ingest/warehouseFeed.js`, manual run via `npm run sync:warehouse-pos`.

## Ownership

**Work-Hub owns `ns_open_po_lines` and writes nothing else in that project.**
The warehouse app reads it; its own tables (`purchase_orders`, `bins`,
`bin_skus`, `containers`, `sku_catalog`, `location_qtys`, `app_meta`, …) are
never touched by this feed. The app's existing CSV import can keep full-wiping
its own `purchase_orders` without colliding with anything.

## One-time setup (Supabase SQL editor)

Run this in the warehouse project (`jvwpviepslikdaxkmtqx`) → SQL editor:

```sql
create table if not exists ns_open_po_lines (
  po_id              text        not null,  -- NetSuite PO internal id ("Created From")
  line_seq           int         not null,  -- raw NetSuite line-sequence number
  po_number          text        not null,  -- tranid, e.g. PO1760
  vendor             text,
  status             text,                  -- bare status: "Pending Receipt" | "Partially Received"
  expected_receipt   date,
  header_memo        text,                  -- PO-level memo (e.g. "FALL BOUTIQUE BUY")
  final_destination  text,                  -- Final Naghedi Destination, FULL path or NULL — never guessed
  po_location        text,                  -- line location, falling back to the PO header's (full path)
  item_line_position int         not null,  -- position among ITEM lines only = Item Receipt "Order Line"
  item_type          text,                  -- NetSuite itemtype (InvtPart today) — for renumber audits
  item_id            text        not null,  -- item internal id
  sku                text        not null,  -- NetSuite itemid verbatim, e.g. SN04023LD-CASHMERE
  line_memo          text,
  qty_ordered        int         not null default 0,
  qty_received       int         not null default 0,  -- remaining = ordered - received; drop 0-left lines from Receive=F placeholders
  line_closed        boolean     not null default false, -- manually-closed line: never receive against it
  unit_rate          numeric,
  synced_at          timestamptz not null,  -- push batch stamp; max(synced_at) = feed freshness
  primary key (po_id, line_seq)
);
-- Matches the project's other tables: the app writes with the anon key, so
-- RLS stays off. (Tables created via the SQL editor default to RLS disabled.)
```

## Semantics the reader can rely on

- **One row per PO item line — never collapsed by SKU.** A PO carrying the
  same SKU on two lines yields two rows (the app flags those POs for manual
  receipt; the feed must not hide them).
- **`item_line_position` is the Item Receipt "Order Line" value**: a running
  counter over item lines in line-sequence order. Non-item lines are excluded
  from the table but still shift `line_seq` — live today, 17 open POs carry a
  "dye webbing fee"/"sample charge" expense line at raw seq 1, so on those POs
  `line_seq` runs 2..N while `item_line_position` runs 1..N-1. The auto-added
  tax line (one PO in scope) has no itemid and is excluded the same way.
  `line_seq` + `item_type` ride along so the consumer can renumber and audit.
- **Fully-received lines are included** (with `qty_received`), because position
  numbering must count them; the reader drops `ordered - received <= 0` lines
  from Receive=F placeholder rows, exactly as it did with the CSV.
- **`final_destination` is NULL when blank in NetSuite** (20 of 86 open POs at
  build time) — the reader should treat NULL as "route not decided", never
  default it. Both location fields are FULL paths ("Warehouse Bulk : Shopbop");
  the leaf form silently mismatches NetSuite CSV imports.
- **Freshness = `max(synced_at)`.** Every push stamps all rows with one batch
  time, then sweeps rows with older stamps. A mid-push failure leaves the
  previous complete snapshot in place (plus some fresher rows) — the table is
  never empty and never a partial replacement. Scope: a PO that closes or
  becomes Pending Bill (fully received) disappears on the next push.

## Config

`WAREHOUSE_SUPABASE_URL` + `WAREHOUSE_SUPABASE_KEY` (canonical, declared in
`render.yaml`), falling back to the `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`
pair already in `.env.local`. Unset = the push skips silently, like every other
integration — the `warehousePoFeed` row in `import_snapshots` is the freshness
record on the Work-Hub side.

## Phase 2 (not built)

Inventory (`sku_catalog`/`location_qtys`) could be fed the same way, but those
tables are the app's NetSuite mirror for bin-fill and packing-slip validation,
their import is delete-and-replace from the browser, and Work-Hub does not
ingest inventory yet — roadmap item 5 is the prerequisite. Deliberately out of
scope here.
