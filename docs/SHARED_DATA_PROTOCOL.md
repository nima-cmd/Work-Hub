# Shared Data Protocol — Work-Hub ⇄ Warehouse app

Two independent apps share one Supabase project (`jvwpviepslikdaxkmtqx`):

- **Work-Hub** — this repo. Express server + React client. Pulls NetSuite over SuiteQL,
  owns **Neon** (its private store), and pushes read-only feed tables into the shared
  Supabase.
- **Warehouse** — `~/src/Naghedi-Warehouse`. Browser-only React app, no server. Maps
  racks/bins, stages containers, generates NetSuite Item Receipt / Transfer CSVs.

**The apps are NOT linked.** They never call each other's code or APIs. Their *only*
shared surface is the Supabase database, and this document is the contract that governs
it. If it isn't written here, don't assume the other app will honor it.

> Neon is Work-Hub's private store; the Warehouse app never touches it. Keeping
> Neon↔Supabase consistent is Work-Hub's job — the Warehouse app trusts only the
> Supabase copy.

This file is the **authoritative copy**. A copy lives at
`docs/SHARED_DATA_PROTOCOL.md` in the Warehouse repo; when they disagree, this one
wins for anything describing an `ns_*` table, because Work-Hub owns those and this repo
is where their schema is defined (`docs/warehouse-po-feed.md`).

---

## The five golden rules

1. **Single writer per table.** Every table has exactly **one owner** that may
   INSERT / UPDATE / DELETE / alter it. The other app treats it as **read-only**.
   No table ever has two writers.

2. **Never run a destructive whole-table operation on a table the other app reads.**
   No `TRUNCATE`, no `DELETE` without a tight `WHERE`, no drop-and-recreate. Writers
   update via **upsert on a stable key** and scope any delete to rows they own.

3. **Additive, backward-compatible schema only.** Never drop or rename a column the
   other app reads. New columns are added **nullable** (or with a default). A breaking
   change requires an out-of-band heads-up to the other app's owner *before* it ships —
   the apps cannot negotiate at runtime.

4. **Namespace by owner.** Work-Hub's tables are prefixed `ns_*`; its `app_meta` keys
   (if it ever needs any — today it has none) use an `ns:` prefix. Warehouse keys stay
   bare. Neither app writes a key or table it doesn't own.

5. **Feeds are published without ever serving a truncated snapshot.** See
   *Feed publishing* below for the mechanism actually in use, and the one limitation
   it does not cover.

---

## Ownership map (verified live 2026-08-04)

| Table / resource            | Owner (writes & deletes) | Other app |
|-----------------------------|--------------------------|-----------|
| `warehouses`, `racks`, `bins`, `bin_skus` | **Warehouse** | Work-Hub: never |
| `containers`                | **Warehouse**            | Work-Hub: never |
| `purchase_orders`           | **Warehouse** (its own CSV fallback) | Work-Hub: **never touch** |
| `sku_catalog`, `location_qtys`, `location_names` | **Warehouse** | Work-Hub: never |
| `app_meta` (bare keys)      | **Warehouse**            | Work-Hub: `ns:` keys only |
| `ns_open_po_lines`          | **Work-Hub**             | Warehouse: **read-only** |
| `ns_item_location_qtys`     | **Work-Hub**             | Warehouse: **read-only** |
| future `ns_*`               | **Work-Hub**             | Warehouse: **read-only** |
| Neon (everything)           | **Work-Hub**             | Warehouse: never |

Work-Hub writes **nothing** in this project outside `ns_*`. If a new shared need
appears, add a row here **first**, pick one owner, and prefix by owner. Never retrofit a
second writer onto an existing table.

---

## The one active hazard — read this

The Warehouse app's PO CSV import (`services/poImport.js → importPOsToSupabase`) does a
**full `DELETE` of `purchase_orders` then re-inserts**. That is the classic two-writer
landmine. It is safe **only because**:

- **Work-Hub owns `ns_open_po_lines`, not `purchase_orders`** — and must never write,
  read-modify, or delete `purchase_orders`.
- **The Warehouse app reads live PO data from `ns_open_po_lines`** and keeps
  `purchase_orders` purely as its **manual-CSV fallback**, which nothing else reads.

Do not point either app at the other's PO table.

---

## Feed status (live 2026-08-04)

Both feeds are populated and verified end-to-end:

| Table | Rows | Notes |
|-------|------|-------|
| `ns_open_po_lines` | 1,843 item lines / 86 open POs | 18 non-item lines excluded (17 fee lines + 1 tax line) |
| `ns_item_location_qtys` | 1,934 item-location rows | app-side reader **not built yet** |

`npm run check:warehouse-feed` (Work-Hub) reports both tables' row counts and snapshot
age, and names the missing step if either regresses.

⚠️ **Work-Hub's Render deploy does not yet carry `WAREHOUSE_SUPABASE_URL` / `_KEY`**, so
until those are set the feeds refresh only when a sync runs locally. A stale
`synced_at` means that, not a broken contract.

---

## `ns_open_po_lines` — the feed contract

One row per open PO **item line** (never aggregated by SKU). Primary key
`(po_id, line_seq)`. Full column semantics: `docs/warehouse-po-feed.md`.

| Column | Meaning |
|--------|---------|
| `po_id` | NetSuite PO internal id — Item Receipt "Created From" |
| `line_seq` | raw NetSuite line-sequence number (part of the key; **not** the Order Line) |
| `po_number` | tranid **with the `PO` prefix**, e.g. `PO1760` |
| `vendor`, `status`, `expected_receipt`, `header_memo` | PO header fields |
| `final_destination` | Final Naghedi Destination — full location path, or **NULL** when undecided in NetSuite (never guessed) |
| `po_location` | line location, falling back to the PO header's — fallback destination |
| `item_line_position` | position among **item lines only** = the Item Receipt "Order Line" |
| `item_type` | NetSuite itemtype — for renumber audits |
| `item_id`, `sku` | item internal id; `sku` is the NetSuite itemid verbatim |
| `line_memo`, `unit_rate` | line detail |
| `qty_ordered`, `qty_received` | remaining = ordered − received |
| `line_closed` | **manually**-closed line — never receive against it |
| `synced_at` | push batch stamp; `max(synced_at)` = feed freshness |

Guarantees Work-Hub honors:

- **Duplicate SKUs across lines are never collapsed.** Live today: PO1775 (131 lines /
  116 distinct SKUs) and PO1326 (82 / 81). The reader is expected to flag those POs for
  manual receipt rather than merge them.
- **Fully-received lines are included** (with `qty_received`), because
  `item_line_position` must count them. The reader drops `ordered − received <= 0` lines
  from Receive=F placeholders.
- **`line_closed` is distinct from fully-received** — it means a human closed the line in
  NetSuite. Both should drop out of receipt placeholders, for different reasons.
- **`final_destination` is NULL, never guessed**, when blank in NetSuite (20 of 86 POs
  today). NULL means "route not decided".

### Two corrections against the Warehouse repo's copy of this doc

Its column table was written from the design discussion, not the shipped table. The
live names are the ones above — specifically `po_id` (not `po_internal_id`), `item_id`
(not `item_internal_id`), `final_destination` (not `destination_location`), and
`po_location` (not `location`).

1. **There is no `batch_id` column** and none is planned. Do not code against it;
   freshness and snapshot identity both come from `synced_at`.
2. **`po_number` carries the `PO` prefix** (`PO1760`), not a bare number. This is
   already safe on the Warehouse side — `poImport.js:172` normalizes a bare all-digit
   CSV number by prepending `PO`, so the CSV and feed paths converge on the same key.
   Nothing needs changing; do not "fix" it into a mismatch.

### Feed publishing — what's actually implemented

Work-Hub writes over PostgREST from a Node client, which has **no multi-statement
transaction**, so the doc's "transactional DELETE-then-INSERT swap" is not available and
would violate rule 2 anyway. The implemented mechanism is **upsert-then-sweep**:

1. Stamp one `synced_at` for the batch.
2. Upsert every row of the new snapshot.
3. **Only after every batch succeeds**, delete rows with `synced_at < stamp` — a tight
   `WHERE`, scoped to rows Work-Hub owns.

A truncated pull, an empty pull, or any failed batch **aborts before the sweep**, so the
table always continues to serve the last complete snapshot. This is deliberate: an
unattended feed must never be able to empty a table the other app depends on.

⚠️ **The limitation, stated honestly:** this guarantees the reader never sees an *empty
or truncated* table, but **not** that it never sees a *mixed* one. A read landing
mid-push can observe new rows alongside not-yet-swept old rows. With ~1,800 rows the
window is short, and stale rows are only ones dropping out of scope — but it is real.
If it ever matters, the fix is for the reader to filter to `max(synced_at)` rather than
for the writer to change strategy. **Neither side should change this unilaterally.**

---

## Each app's obligations

### Warehouse app must
- Treat every `ns_*` table as **read-only** — never INSERT/UPDATE/DELETE/alter.
- Keep its full-replace strictly on `purchase_orders`.
- Only write its own bare `app_meta` keys; never an `ns:` key.
- Degrade gracefully when a feed is empty or missing (fall back to manual CSV — already
  wired for PO data) and surface `synced_at` freshness to the user.

### Work-Hub must
- Only write `ns_*` tables (and Neon). **Never** write, update, delete, or alter
  `warehouses`, `racks`, `bins`, `bin_skus`, `containers`, `purchase_orders`,
  `sku_catalog`, `location_qtys`, `location_names`, or the Warehouse's `app_meta` keys.
- Publish feeds by upsert-then-sweep, aborting before the sweep on any incomplete pull.
- Keep schema changes additive; give a heads-up before anything breaking.

---

## Enforcement — and why phase 2 cannot be done unilaterally

Today **RLS is disabled** on both `ns_*` tables and the protocol is convention only.
That was a deliberate choice, not an oversight: **both apps authenticate with the same
`sb_publishable_…` key.** Work-Hub has no service/secret key. So enabling RLS or
per-role GRANTs without first re-keying Work-Hub breaks *both* halves, and breaks them
**silently** — Work-Hub's push soft-fails into a warning, and the Warehouse app's
`select` returns `[]` and falls through to its stale CSV. Nothing errors visibly.

The correct phase-2 sequence, in this order:

1. Mint a **secret** Supabase key; give it to Work-Hub only
   (`WAREHOUSE_SUPABASE_KEY` in `.env.local` **and** Render).
2. Verify the push still succeeds on that key alone.
3. *Then* enable RLS on `ns_*` with `SELECT` for the publishable role and write access
   for the secret role only.

**Neither app should enable RLS, add policies, or create roles on its own.** Steps 1–2
are Work-Hub's; step 3 affects both.

---

## Changing the contract

Since the apps can't negotiate at runtime: propose the change here, get the other side's
ack, ship the **additive** DB change, then update whichever app reads or writes it.
Never repurpose or drop a shared column before both apps have moved off it.
