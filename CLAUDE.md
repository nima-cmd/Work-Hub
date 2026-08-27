# CLAUDE.md — Warehouse Order Pipeline Tracker

Orientation for anyone (human or agent) working in this repo.

## What this is

An internal tool that aggregates Naghedi's NetSuite warehouse work into one
aging-aware pipeline so **nothing sits ignored**. It also serves as the canonical
**task model** the BitaQuest game reads to generate quests.

## Stack

- **Client:** React 19 + Vite (`client/`)
- **API:** Express (`server/`), reads Postgres via `src/db.js`
- **DB:** **DigitalOcean Managed Postgres** (`workhub-db`, SFO3, PG 17) — `DATABASE_URL`.
  Neon is retired but PRESERVED as `DATABASE_URL_NEON` (see the cutover note below).
- **Shared model:** plain ES modules in `src/model/` and `src/ingest/`

## Run

```bash
npm test               # unit tests for the model (no DB)
npm run migrate        # apply db/schema.sql to Neon
npm run db:mirror      # clone Neon -> local Postgres (DEVELOP AGAINST THIS, see below)
npm run db:copy        # copy ANY Postgres -> any other, and PROVE it row-for-row
npm run dev:offline    # run the whole app on local Postgres, writes allowed (Neon down)
npm run ingest         # load NetSuite saved-search CSV exports into the DB
npm run server         # API + built UI at http://localhost:3001
npm run dev            # live-editing (Vite + API)
npm run analyze        # CLI attention list straight from CSVs (no DB)
npm run ups:rate       # what a big box costs on the WHOLESALE UPS account
npm run sync:ups-costs # harvest real UPS billed costs from ShipStation
npm run sync:warehouse-pos # push open PO lines to the Naghedi-Warehouse Supabase
npm run sync:warehouse-inventory # push item-location qtys to the same Supabase
npm run check:asn-cartons  # did every shipped carton get announced on an 856?
npm run check:warehouse-feed # is the warehouse-app feed live? names the missing go-live step
npm run check:counters     # does every counter still MEAN what it says? (partition + floor checks)
npm run fix:bol-sequence   # is bol_number_seq still ahead of every BOL ever minted?
npm run check:fields       # which columns are DERIVED, not observed? (is this column always another + N?)
npm run check:transfer     # Neon's 5 GB/month cap: used, projected, and BY WHICH process
npm run check:neon         # is the database answering, which one, and how close to the cap
npm run sync:tenders       # pull Nordstrom's Manhattan TMS "Tender Accepted" emails
npm run check:tenders      # does the accepted pickup date/carrier match our routing cards?
npm run check:slack        # is the Slack lane live? names the exact missing token/scopes
npm run sync:calendar      # shipped POs -> 3 Google calendars (EDI / Boutique / warehouse). DRY unless --write
npm run sync:prices        # NetSuite price list -> ns_item_price (Retail = the hang tag; Wholesale = the check)
                           #   the hourly cron runs the INCREMENTAL leg; this is the full backfill

```

## Where to develop — against the live database (since 2026-08-18)

**Just run the app.** `DATABASE_URL` is DigitalOcean and both localhost and the deploy
read it, so local work is immediately visible on the deploy and vice versa. There is no
transfer meter to dodge any more.

```bash
npm run dev            # Vite + API, against DigitalOcean
```

### The mirror: kept as an OFFLINE FALLBACK, no longer the default

`npm run db:mirror` existed for one reason — Neon's Free plan allowed **5 GB/month of
public network transfer and SUSPENDED the compute** when it ran out, and the measured
cause was *development*: 131 commits in two weeks, every verification loop reading Neon
over the public internet (`check:counters` alone was 5.3 MB a run against a 26 MB
database). **That reason is gone.** DigitalOcean does not meter managed-database transfer.

The mirror is still there and still useful for one thing: working when the network or the
database is not. `WORKHUB_DB=mirror` in `.env.local` (currently commented out) points
everything at the local clone; add `WORKHUB_OFFLINE=1` to permit writes.

⚠️ **`db:mirror` now reads `DATABASE_URL_NEON`** and Neon is suspended until 2026-09-01,
so it cannot re-clone before then. The clone on disk is frozen at 2026-08-17 09:52 PDT.
⚠️ **One way only, on purpose** — the app owns data (BOL numbers that must never be
reused, custody scans, tasks), so two writable copies would mean conflict resolution on
exactly the records that must not diverge.
⚠️ **App-owned writes made against the mirror exist NOWHERE ELSE**, and `db:mirror` DROPS
its target. It refuses when local holds app-owned rows newer than the clone stamp.

### The transfer meter is now attribution, not a budget

`npm run check:transfer` still reports month-to-date, daily rate and the split by source
(`deploy` / `cron` / `local`) — worth keeping, because a rising number means the app got
chattier and DO is **one vCPU**. But it no longer measures against a cap, and it says so.
⚠️ The cap language, the percentage, the verdict and the projection-vs-cap are all gated
on the target actually being Neon — see the cutover note below for why that gate exists.

⚠️ **`npm run migrate` follows `WORKHUB_DB` too.** It refuses to run against the mirror
unless you pass `--mirror`. It announces which database it is altering, by name.

## ✅ The DigitalOcean cutover (2026-08-18)

The app runs on **DigitalOcean Managed Postgres** — `workhub-db`, SFO3, PostgreSQL 17,
1 GiB Basic ($13.00 node + $2.15 storage). Both localhost and the Render deploy point at
it. **DO does not meter managed-database transfer at all**, so the 5 GB cap that suspended
Neon simply does not exist here.

- **SFO3 because Render is in `gcp-us-west1`** (found with `dig` on the deploy's origin
  CNAME). Transfer is free but LATENCY IS NOT, and the deploy makes ~157k queries/day.
- **TLS:** DO signs each cluster with a private per-project CA. Locally that means
  `sslmode=verify-full&sslrootcert=~/.config/workhub/do-ca-certificate.crt` (works for
  node-pg AND psql). ⚠️ **Render has no such file**, so its `DATABASE_URL` uses
  `?uselibpqcompat=true&sslmode=require`. The CA is committed (`db/do-ca-certificate.crt`)
  and `src/db.js` applies it to any DigitalOcean host in code, so no env change is needed.

  ⚠️ **THIS SECTION USED TO CLAIM "the deploy verifies … proven by tampering", AND THAT WAS
  FALSE FOR EVERY DEPLOY** (corrected 2026-08-24). The tampering proof was run LOCALLY,
  where the URL's own `sslrootcert` did the verifying. **pg lets the connection string
  override the `ssl` option**: `sslmode` becomes pg's own `config.ssl` and wins, and under
  libpq semantics `uselibpqcompat=true&sslmode=require` means *encrypt, do not verify*.
  Re-tested by tampering against Render's exact URL form: **a bogus CA still connected.**
  The committed certificate had never been in force on a deploy.

  It is now. `prepareConnectionString` (src/model/connectionString.js) strips `sslmode`,
  `sslrootcert` and `uselibpqcompat` whenever we are supplying the CA ourselves, so our
  object is the only authority — and tampering in that configuration is refused. ⚠️ The
  params are stripped ONLY when the committed CA was readable; with nothing to fall back
  on, removing `sslmode` would drop to plaintext against a server that demands TLS, trading
  a verification failure for an outage.

  ⚠️ The same mechanism also took the first DigitalOcean deploy down twice: the laptop's
  `sslrootcert` path threw ENOENT from inside pg's PARSER on every connection, and once
  that was stripped, the surviving `sslmode=require` verified against the system CA store
  and reported `self-signed certificate in certificate chain`.
- **Rollback:** uncomment `WORKHUB_DB=mirror` in `.env.local`. The mirror is untouched.

⚠️ **`DATABASE_URL_NEON` MUST BE KEPT.** Neon holds the only copy of the app-owned rows
written to the deploy after the mirror was cloned 2026-08-17 09:52 PDT — five orders'
`DEPARTURE_CONFIRMED` among them. Reconciling is insert-only and a separate job once
Neon's transfer resets 2026-09-01. Nothing in the migration touched Neon.

⚠️ **An endpoint name must resolve to a NAMED database, never to "whichever one is in use."**
`db:copy`'s `neon` endpoint and `db-mirror.js` both read `DATABASE_URL`; once that meant DO,
`--from=neon` would have read DO while saying Neon, and the never-target-Neon guard would
have stopped recognising Neon at all. They read `DATABASE_URL_NEON` now.

⚠️ **`DB_TARGET` is DERIVED FROM THE CONNECTION** (`hostKind(url)`), not assumed. It used to
be `useMirror ? 'mirror' : 'neon'`, so on the cutover `check:neon` reported **"✓ UP NEON ·
320 orders"** while talking to DigitalOcean, `check:transfer` headlined **"NEON TRANSFER …
158% of the cap"** against a target with no cap, and `migrate` announced it was altering
NEON. Three green-looking checks naming the wrong database — the `fieldAssumptions` bug
class aimed at the one number that says whether the app is alive.

## `npm run db:copy` — the migration tool, not the mirror

`db:mirror` is hardcoded Neon → local and **DROPS its target**, which is right for a
disposable read replica. `db:copy` is for moving to a database we intend to **KEEP**
(DigitalOcean Managed Postgres does not meter database transfer at all):

```bash
npm run db:copy -- --from=mirror --to=do          # named endpoints, resolved from .env.local
npm run db:copy -- --from=mirror --to=do --dry    # size the job, write nothing
npm run db:copy -- --from=neon --to=do --truncate # discard what the target holds first
npm run db:copy -- --from=mirror --to=do --verify-only   # re-prove a copy that already ran
```

Endpoints: `neon` (`DATABASE_URL`) · `local`/`mirror` (`DATABASE_URL_LOCAL`) · `do`
(`DATABASE_URL_DO`) · or a full `postgres://` url.

- ⚠️ **The TARGET may never be Neon, and there is no override flag.** This script empties
  its target, and Neon holds the only copy of the app-owned rows written after the
  mirror was cloned (2026-08-17 16:52). Reconciling those is insert-only, and a
  different tool.
- ⚠️ **It never copies onto data.** `ON CONFLICT DO NOTHING` over a populated target
  merges two databases row by row and the winner is arbitrary. It refuses unless
  `--truncate`, then empties every table so the **source is the only authority** —
  including the 4 rows `db/schema.sql` seeds itself.
- **It verifies, and a count is not a comparison.** Row counts *and* an md5 over every
  shared column, computed identically both sides (`TimeZone=UTC`, `DateStyle=ISO`, or
  a timestamptz hashes differently in two zones). A mismatch **names the column**.
  `--counts-only` skips the content hash and *says so in the summary line*.
  Non-zero exit + "DO NOT point the app at this target" when unproven.
### ⚠️ The connection ceiling replaces the transfer ceiling

DO meters **no** transfer for managed databases (verified in their docs) — but the 1 GiB
plan allows **22 backend connections**, and `new Pool()` with no `max` is node-pg's
default of **10 per process**. Deploy + dev server + one script = 30 against 22. Neon
never surfaced this because its limit was transfer.

`src/model/poolLimits.js` sets the budget explicitly: **deploy 8 · everything else 4**
(worst case 16, leaving 6 for DO's own maintenance). Override with `WORKHUB_POOL_MAX`
on a bigger plan — a junk value is ignored, because `max: NaN` is an UNBOUNDED pool.
`explainDbError` now names exhaustion (`53300` / "too many clients" / a connect timeout),
which otherwise reads as a broken app rather than a capacity limit. Use DO's **PgBouncer**
pool for the deploy and this stops mattering.

- Same three lessons as the mirror: values round-trip through **TEXT** (node-pg
  re-serialises a parsed jsonb as an array literal), every value is cast back to the
  **target's** declared type, and **sequences are advanced past the copied ids** or the
  target is read-only in practice.

⚠️ **"Sequences advanced" MEANT COLUMN-OWNED SEQUENCES ONLY, and that cost a real
outage.** Both copy tools discover sequences with `pg_get_serial_sequence()`, which
never returns a sequence made by a bare `CREATE SEQUENCE` — it only knows the ones a
SERIAL/IDENTITY column owns. `bol_number_seq` is the **only standalone sequence in
this database (1 of 16)** and it governs the one number in the whole app that MUST
NEVER BE REUSED. The cutover left it at 1731240 while `bol_registry` already held
NB1731267, so BOL generation died on `bol_registry_pkey` — 27 collisions deep — and
stayed broken from 08-12 to **08-21**, when Nima tried to make a BOL. Both scripts now
**carry standalone sequences from the source** (there is no `MAX(column)` to chase,
because nothing declares which column consumes one), and `check:counters` fails loudly
if the sequence ever falls behind the registry again. ⚠️ The duplicate-key error was
the never-reuse guarantee WORKING; the bug was upstream of it.

## Working with Neon suspended (offline mode)

Neon ran out of transfer on **2026-08-17** — the cron was burning 7.7 GB/month on its
own (54 runs/day x 4.6 MB; now hourly). The compute suspends until the reset.

**Nothing falls back to CSV.** Every ingest reads its own API over HTTPS and has no
Neon dependency — only the WRITE lands in Postgres. Point that at local and it all
works. Verified 2026-08-17 against the mirror:

| sync | source | result |
|---|---|---|
| NetSuite | SuiteQL/REST | 270 orders · 192 fulfilments · 1,175 invoices |
| Gmail | Gmail API | 9 fetched, 9 upserted |
| Orderful | Orderful API | 4,013 fetched, 4,013 upserted |
| Macy's routing | Gmail | 100 parsed, 13 live |
| Manhattan tenders | Gmail | 6 parsed, 5 shipments |
| ShipStation | ShipStation API | read-only harvest OK |

```bash
npm run dev:offline    # WORKHUB_DB=mirror WORKHUB_OFFLINE=1 — writes permitted
```

The CSV path is the fallback for **NetSuite** being down, not for Neon.

⚠️ **App-owned writes made offline exist NOWHERE ELSE.** `npm run db:mirror` DROPS the
database, so it now refuses when local holds app-owned rows newer than the clone stamp
(`APP_OWNED_TABLES` in `src/db.js` — custody scans, BOL numbers, filing events, tasks,
notes). `--force` discards them deliberately. Those records still have to reach Neon
before re-cloning; there is no automatic reconciliation and deliberately never has been.

⚠️ **It is stale by definition.** The server prints its target at startup and Health
shows a red banner with the clone's age. Never report a mirror number as live — that
is `src/model/fieldAssumptions.js`'s whole bug class applied to the entire app.

## Data flow

```
NetSuite saved searches ──(manual CSV export)──▶ src/ingest ──▶ src/model
   (Drive Data folder)                              (parse)     (pipeline+flags)
                                                                     │
                                                          scripts/ingest.js
                                                                     ▼
                                                              Neon (Postgres)
                                                                     │
                                                    server/queries.js (re-flags)
                                                                     ▼
                                                        Express /api/orders ──▶ React UI
```

## Key decisions (don't relearn these the hard way)

- **CSV export, NOT the live NetSuite API.** The NetSuite MCP connection works
  but is unstable; it's for design/verification only. The app ingests CSV
  exports. Swap to a live API later only when a stable one exists — the model is
  built so that swap won't touch the logic.
- **ATS vs non-ATS shortage:** ATS short = real stock exception (act now);
  non-ATS short = normal (presold, awaiting its PO). See `src/model/pipeline.js`.
- **EDI = ShopBop, Nordstrom, Bloomingdale's** (`src/model/source.js`).
- **Two UPS accounts, and they are NOT interchangeable.** Boutique/wholesale
  freight bills to **C6J610** ("Big Box"); **18GE01** ("Small") is ecom and is the
  API *primary*, so anything that doesn't name an account gets the wrong one. The
  tracking numbers prove it (`1Z**C6J610**…`). `src/model/upsRates.js` refuses to
  present an 18GE01 figure as wholesale — never loosen that.
- **IF ↔ Invoice** is derived via the shared SO (no manual entry).
- **OC ↔ PO** has no native NetSuite link — the app will own that mapping
  (`oc_po_links` table).
- **Natural keys** (SO#, IF#, INV#, PO#) are primary keys so re-imports upsert.
- **Every counter bug here has been one of five shapes** — unreachable branch ·
  counts something other than its label · keyed on a hand-set/display field where
  an objective one exists · a comment describing a mechanism no code implements ·
  **a field that is pure arithmetic on another field** (`transaction.shipdate` was
  `trandate + 28` on 1,234 of 1,254 SOs and drove 51 flags). `npm run check:counters`
  mechanically catches the first two and the fifth; shapes 3 and 4 still need a human
  to check a field's provenance — so when a number looks calm, ask what it is keyed
  on before believing it. `npm run check:fields` is the fifth shape's full report,
  and `src/model/fieldAssumptions.js` is the register of every one found so far —
  what we assumed, what it actually was, what it cost, and how it was caught. It is
  on **Health**; read it when a number looks wrong. ⚠️ 9 of 15 entries are shapes no
  script can catch.
- **A default is not an answer.** `routing_shipment.ship_direct DEFAULT false` +
  `merge_center DEFAULT 'CA'` made every routing card assert "via the Santa Fe
  Springs merge center" — a claim nobody made, which the BOL then printed. When a
  column can be unknown, let it be NULL and say so.

## Layout

```
db/schema.sql            canonical Postgres schema
src/db.js                Neon connection pool
src/ingest/csv.js        dependency-free CSV parser
src/ingest/savedSearches.js  per-search column mappers (tolerant of changes)
src/ingest/loadToDb.js   upserts into Postgres
src/model/stages.js      pipeline stages + next-action per stage
src/model/pipeline.js    merge sources → order; aging + ATS-aware flags
src/model/source.js      EDI vs boutique classification
src/model/upsRates.js    UPS wholesale rates + the never-mislabel-the-account rule
src/model/fieldAssumptions.js  the REGISTER of fields that didn't mean what we thought
src/model/arithmeticFields.js  is this column always another column + N? (shape 5)
src/ingest/arithmeticSweep.js  points that rule at every date/number column in Neon
src/model/asnCartonCheck.js  every shipped carton vs every SSCC on a delivered 856
src/ingest/asnCartonSync.js  runs that check + persists it (the CLI and the cron share it)
src/ingest/orderfulAsn.js    pull carton SSCCs + PO refs out of an 856 body
src/ingest/shipstationCosts.js  harvest what UPS actually billed (read-only)
src/ingest/warehouseFeed.js  open PO lines + item-location qtys → the Naghedi-Warehouse app's Supabase (docs/warehouse-po-feed.md; shared-DB rules in docs/SHARED_DATA_PROTOCOL.md)
src/ingest/shipstationRates.js  live V2 quotes, per UPS account
src/model/manhattanTender.js  parse Nordstrom's TMS tender email; SRR's grain is the DC
src/model/shipmentCalendar.js  a shipment as a shareable calendar entry (the event TEXT)
src/model/shipmentCalendarPlan.js  which calendar, what changed — the sync's rules, pure
src/model/heldShipment.js  a shipment still on our floor; dated TODAY because ship_date is fabricated
src/model/itemPrice.js     which price level means what; a price of 0 is NOT a price
src/ingest/netsuiteItemPrices.js  the `pricing` sublist (item.baseprice is EMPTY) + item display names
src/ingest/googleCalendarWrite.js  the WRITE half of Google Calendar (googleCalendar.js reads)
src/ingest/shipmentCalendarSync.js  plan + publish; candidates are an INPUT (src never imports server)
src/ingest/shipmentCalendarCron.js  the hourly leg: held always, shipped only what CHANGED
src/ingest/manhattanTender.js pull + persist tenders; reconcile vs routing_shipment
src/model/slackCatchUp.js  Slack as a catch-up lane; lanes are addressing FACTS, never a score
src/ingest/slack.js       reads the 7 chosen channels + all DMs (needs a USER token, xoxp-)
server/queries.js        read orders (+fulfillments), re-apply flags
server/index.js          Express API + serves built client
client/src/views/        Dashboard · Kanban · TableView · Calendar
scripts/                 analyze / migrate / ingest / sync / rate entry points
scripts/db-mirror.js     clone Neon -> local Postgres (why: the 5 GB transfer cap)
scripts/db-copy.js       copy any Postgres -> any other + verify (the DigitalOcean move)
src/model/dbCopyPlan.js  db:copy's guards, column plan and verification, as pure rules
docs/                    NetSuite saved-search design + document-linking strategy
```

## Open threads (need Nima's input)

- The two OC↔PO custom-field names in NetSuite (to ingest existing links).
- A PO-receiving saved-search export (spec in `docs/`) → unlocks the inbound↔
  outbound allocation link and the real-stall detector.
- Which UI view to keep as default (all four work today).
