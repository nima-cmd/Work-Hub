# The Weaver mirror — what it is, and what NOT to assume

**Read this before touching anything named `weaver_*`.** Started 2026-08-20. This work
originates in a **separate repo** — `~/src/weaver` — which is documentation-only and holds
all the reasoning. Work-Hub is the host; it has the code but not the context. If a decision
here looks arbitrary, the why is in that repo, not this one.

## The one-paragraph version

**Weaver** is NAGHEDI's Airtable base (`app4dbJIctbXUrCxp`) where product data is authored:
a Product is silhouette × weave × colourway, and its **SKU is a computed formula**. It
feeds NetSuite (system of record for items), which feeds Shopify via Celigo. Shopify
cannot create an item NetSuite does not have, so the order is fixed: Weaver → NetSuite →
Shopify.

The round trip has two manual steps. Step 1 loads new items into NetSuite by hand. Step 2
runs a saved search and feeds the result back so Weaver knows what exists. **Step 2 is what
these tables automate.**

## Why any of this is in Postgres

Airtable cannot answer "how long has this been wrong?" — it stores a present, not a
history. Weaver also has a **structural blind spot**: when a weave code changes (`FK`→`EF`),
the Airtable record id stays put and the computed SKU moves underneath it. NetSuite keeps
the old SKU forever, and nothing in Weaver records that the old one ever existed. Its Back
Office mirror rows then strand — which is precisely what all 17 of Weaver's `MISMATCH` rows
are. Weaver cannot remember. Postgres can.

There is also a hard cap motive: Airtable's record ceiling is per-**workspace**, set by the
**owner's** plan, and this account belongs to no workspace — so the limit governing Weaver
is neither visible nor controllable from here. Adding history to Airtable is not an option.

## The tables

| table | key | what it is |
|---|---|---|
| `weaver_sync_run` | serial | one row per reconciliation run |
| `weaver_netsuite_item` | `internal_id` | NetSuite item state as observed |
| `weaver_sku_history` | `(internal_id, sku)` | every SKU NetSuite has called an item |
| `weaver_product` | `airtable_record_id` | Weaver's authoring side, 1,418 products |
| `weaver_product_sku_history` | `(record_id, sku)` | **every SKU a product has computed** — the drift record |
| `weaver_back_office` | `airtable_record_id` | Weaver's mirror of NetSuite, as observed |
| `weaver_divergence` | serial | one row per finding per run |

**Both snapshot tables key on a stable id, never on SKU.** SKUs move; that is the entire
problem. A SKU-keyed join reports one renamed style as both *missing* and *stale* — two
phantom findings from one real change.

`raw JSONB` is kept on every snapshot row deliberately: findings can be re-derived without
re-fetching from NetSuite or Airtable.

## Commands

```bash
npm run check:weaver          # read-only. Writes NOTHING, anywhere. Keep it that way.
npm run weaver:sync           # reconcile AND record. Writes Postgres only.
npm run weaver:sync -- --dry  # reconcile, report, write nothing
npm run weaver:sync -- --all  # don't truncate the finding lists
```

`check:weaver` and `weaver:sync` are deliberately **two scripts**. `check-weaver.js`
promises "no writes to NetSuite, Airtable or Postgres" and that promise is worth more than
the duplication.

**Neither ever writes to NetSuite or Airtable.** Nothing in this domain does. If you find
yourself adding a write to either, stop — Weaver is the source of truth and the standing
instruction from Nima is that nothing outside it modifies it.

## The UI

**Weaver tab** in the nav (between Catalogue and Tasks) → `client/src/views/Weaver.jsx`,
fed by `GET /api/weaver` → `getWeaver()` in `server/queries.js`.

Built on the same principle as `views/Health.jsx`, which exists so that nobody needs a
terminal to see what a `npm run check:*` would tell them. The person who has to fix a UPC
collision is not the person with a shell.

**It is read-only on purpose — there is no "sync now" button.** A sync writes; a write
should not be one stray click away from a page people browse.

The column that justifies the whole page is **`seen`** — how long each finding has been
present, as `12d · 9 runs`. Every other number is available in Weaver somewhere. That one
is not, because Airtable stores a present, not a history.

The verdict count **must match `weaver-sync.js`'s exit code** or the page and the CLI
disagree about the same data. Stranded SKUs are listed but not counted, exactly as the CLI
treats them. If you change one, change the other.

## Traps

**`weaver_sync_run.ok` is not run health.** `ok = false` with `error IS NULL` means *the run
succeeded and found divergence*. A failed run populates `error`. **A cron must check
`error`, not `ok`.** Worth splitting into two columns; not done yet.

**Exit code 1 is normal.** It means "divergence needs a human", not failure. 2 means it
could not run.

**`weaver_product.duplicate_count = -1` means "never checked", not "no duplicates."** It is
a rollup that found no tracker record and computed `0 − 1`. Two real duplicate products
were found this way.

**`Products.SKU` sometimes contains prose.** The formula emits guidance
("Select a Color.", "Enter vendor SKU for third party item.") when links are missing.
`weaver_product_sku_history` filters these out; 9 of 1,418 were prose on the first run. Do
not remove that filter.

**Airtable REST `pageSize` caps at 100, not 2000.** 2000 is the MCP tool's limit. Confusing
them produces a silent short read. 4,099 rows is ~41 requests; the rate limit is 5 req/sec
per base and the pager paces at ~4.5.

**The Airtable PAT must name Weaver explicitly.** Weaver lives under "Bases shared with
me", not in a workspace, so grants scoped to "all current and future bases in all
workspaces" **do not include it**. This bites every new integration.

**Our SuiteQL filter is a superset of saved search 2419.** So "missing from Weaver" rows
that are inactive, `Internal`, or flagged `Ignore in Airtable` are *expected* omissions —
the mirror is right to skip them. The scripts split benign from actionable; keep that split
or the signal drowns (127 benign vs 5 real on the first run).

## What the first runs found

Run #1 on DigitalOcean, 2026-08-20: 4,231 NetSuite items · 4,099 Back Office rows ·
1,418 Weaver products · 149 findings.

- **5 actionable missing** from the mirror (plus 127 correctly-omitted).
- **17 MISMATCH**, all of them style-number drift. 16 are historical residue and already
  inactive; only `SN03014BC-COCOA` describes a live item.
- **18 stranded SKUs** — active in NetSuite with no Weaver product at all. Includes
  `NS47300FK-BIARRITZ` (independently confirming the MISMATCH diagnosis from a different
  code path) and three *recent* items, `SN1301{1,2,3}BD-MYKONOS` (internal ids 87064-66),
  which NetSuite has and Weaver does not know about.

## State of the working tree (2026-08-20)

Uncommitted, deliberately: `db/schema.sql`, `package.json` and `CLAUDE.md` mix this work
with in-flight order-lane changes (`orders.oc_number`, `src/model/orderLane.js`), so the
commit boundary is Nima's to draw. The Weaver files are:

```
new    docs/weaver-mirror.md          this file
new    scripts/weaver-sync.js         reconcile + record
new    scripts/check-weaver.js        read-only sibling
new    src/ingest/weaverBackOffice.js NetSuite + Airtable fetch, reconcile
new    client/src/views/Weaver.jsx    the UI
new    src/ingest/shopifyStorefront.js Shopify read + compare (no credentials)
mod    db/schema.sql                  7 weaver_* tables appended at the end
mod    package.json                   adds weaver:sync
mod    CLAUDE.md                      pointer to this doc
mod    server/queries.js              getWeaver() appended at the end
mod    server/index.js               GET /api/weaver
mod    client/src/api.js              fetchWeaver()
mod    client/src/App.jsx             Weaver tab
mod    client/src/styles.css          .wv* rules appended at the end
mod    .claude/launch.json            adds tracker-mirror (dev against the clone)
```

Everything additive sits at the **end** of the file it was appended to, so a merge
conflict with the order-lane work is unlikely.

## Known gap

`weaver_product_sku_history` only detects drift **from run 2 onward** — it cannot
retroactively know what a SKU used to be. Existing drift is caught instead by the
`stranded_sku` finding, which is answerable on the first run. Both are needed.

## Shopify (built 2026-08-20)

**Weaver's Shopify diff has never worked.** `Shopify Product Diff` and `Metafields Diff`
compare a field **to itself** on every branch, so they are permanently empty — a blank
diff there is not evidence of agreement. No field in Weaver holds Shopify's real state, so
it cannot be repaired in Airtable. It lives here now.

`src/ingest/shopifyStorefront.js` reads the **public storefront** `/products.json` — **no
token**. That covers 8 of the 11 keys Weaver's own comparison key lists. Status, category,
theme_template and every metafield need the Admin API.

Three checks, and only two of them are alerts:

| check | first run | is it actionable? |
|---|---|---|
| `shopify_drift` | **21** | **Yes.** Shopify disagrees with a field Weaver *computes*, so Shopify was edited directly or an upload never landed. |
| `shopify_orphan` | 0 (+9 expected) | Yes when non-zero. The 9 are gift cards and `Internal` — Shopify-only by design. |
| not on the storefront | 708 | **No.** Not persisted as findings. |

**Why 708 is not an alert.** Weaver holds 1,418 products; the storefront lists ~294.
Listing something is a merchandising decision and `For Shopify` marks *eligibility*, not
intent to publish now — so most of those 708 are ordinary unpublishing. Writing 708 rows
per run would bloat `weaver_divergence` and bury the ~30 findings that matter. The count
lives on `weaver_sync_run.shopify_missing` so the trend stays visible.

### Two matching traps, both of which bit

**Shopify variants carry SIZED SKUs; Weaver products are parent-level.** Comparing
sku-to-sku reported **666 orphans and 901 missing** — every sized style counted twice, once
in each direction. Match on the base too (strip at the **last** dash; the suffix is not
always numeric). Fixed: 666 → 9.

**One drift row per product, not per variant.** An 11-size shoe otherwise reports the same
title mismatch eleven times.

### Storefront caveats

- **Published products only.** Right for "is it live?", useless for telling draft from
  archived from deleted.
- The pager ends on a short page — there is no cursor and no total. `fetchShopifyProducts`
  **throws** past `maxPages` rather than returning a short list, because a silent
  truncation would report every unlisted product as missing.

## Not started

**Metafields.** Weaver's `Shopify Product Diff` and
`Metafields Diff` formulas compare a field *to itself* on every branch, so they are
permanently empty — a blank diff is not evidence of agreement. There is no field in Weaver
holding Shopify's actual state, so it cannot be fixed in Airtable; it belongs here.

All 25 keys in Weaver's `Metafields Diff` need the **Admin API** and a custom app token
that has not been requested yet. `SHOPIFY_STOREFRONT` overrides the storefront origin if
the domain ever changes; no other Shopify env var is used.
