# Warehouse feed — `ns_open_po_lines` + `ns_item_location_qtys`

Work-Hub pushes two NetSuite mirrors into the Naghedi-Warehouse app's Supabase
on every sync cycle, replacing that app's manual CSV imports:

- **`ns_open_po_lines`** — every open PO item line (statuses Pending Receipt +
  Partially Received), replacing the "PO Warehouse View" CSV. Built 2026-08-03
  against the receiving-side spec; manual run via `npm run sync:warehouse-pos`.
- **`ns_item_location_qtys`** — every stocked item-location quantity,
  replacing the "Warehouse Item View" CSV (which fills the app's SKU catalog +
  per-location quantities). Built 2026-08-03; manual run via
  `npm run sync:warehouse-inventory`.

Code for both in `src/ingest/warehouseFeed.js`.

**`npm run check:warehouse-feed`** verifies the whole thing at any point: it
probes both tables and names the go-live step that's still missing (table not
created → not seeded → deploy not pushing), or confirms row counts + snapshot
age when live. Run it after each go-live step below.

## Ownership

**Work-Hub owns the two `ns_*` tables and writes nothing else in that project.**
The warehouse app reads them; its own tables (`purchase_orders`, `bins`,
`bin_skus`, `containers`, `sku_catalog`, `location_qtys`, `app_meta`, …) are
never touched by these feeds. The app's existing CSV imports can keep
full-wiping their own tables without colliding with anything.

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

create table if not exists ns_item_location_qtys (
  item_id       text        not null,  -- NetSuite item internal id
  location_id   text        not null,  -- NetSuite location internal id
  sku           text        not null,  -- NetSuite itemid verbatim (the app's SKU key)
  display_name  text,                  -- e.g. "Alhaja Pez Necklace | Gold"
  item_type     text,                  -- InvtPart etc — the reader owns catalog rules
  location_name text,                  -- location.fullname, FULL path ("Warehouse Bulk : Nordstrom")
  qty_available numeric     not null default 0,  -- on hand minus commitments
  qty_on_hand   numeric     not null default 0,  -- the physical count
  synced_at     timestamptz not null,  -- push batch stamp; max(synced_at) = feed freshness
  primary key (item_id, location_id)
);
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

## Inventory feed semantics (`ns_item_location_qtys`)

- **One row per (item, location) with a nonzero on-hand OR available qty** —
  source is NetSuite's `aggregateItemLocation` balance table, read live.
  Negative quantities are sent as-is (an oversold location is a fact, not
  noise); the reader clamps if it wants to.
- **Both qty measures ride along** because the old CSV pivot never said which
  one it carried: `qty_available` subtracts commitments, `qty_on_hand` is the
  physical count. The reader picks — for bin-fill the physical count is
  probably the honest one.
- **No SKU-shape or item-type filtering here.** The app's CSV parser already
  skips non-SKU rows by its own pattern; a feed that pre-filters would
  silently hide rows the app could see in its own export. `item_type` rides
  along so the reader can scope.
- **Location names are FULL paths**, same rule as the PO feed's destinations.
  The CSV's column headers were whatever the saved search pivoted — the reader
  maps names, never positions.
- Freshness/sweep discipline is identical to the PO feed: one batch stamp,
  sweep only after every upsert batch lands, truncated/empty pulls never
  replace the mirror. Its snapshot row is `warehouseInventoryFeed`.
- **The app-side reader is not built yet** (their repo, same split as the PO
  feed's `nsPoFeed.js`): it would fill the `wh_sku_catalog` /
  `wh_location_qtys` localStorage maps the way `parseCatalogCsv` does, with
  the CSV import kept as fallback.
