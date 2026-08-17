# CLAUDE.md — Warehouse Order Pipeline Tracker

Orientation for anyone (human or agent) working in this repo.

## What this is

An internal tool that aggregates Naghedi's NetSuite warehouse work into one
aging-aware pipeline so **nothing sits ignored**. It also serves as the canonical
**task model** the BitaQuest game reads to generate quests.

## Stack

- **Client:** React 19 + Vite (`client/`)
- **API:** Express (`server/`), reads Postgres via `src/db.js`
- **DB:** Neon (Postgres) — connection string in `.env.local` (git-ignored)
- **Shared model:** plain ES modules in `src/model/` and `src/ingest/`

## Run

```bash
npm test               # unit tests for the model (no DB)
npm run migrate        # apply db/schema.sql to Neon
npm run db:mirror      # clone Neon -> local Postgres (DEVELOP AGAINST THIS, see below)
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
npm run check:fields       # which columns are DERIVED, not observed? (is this column always another + N?)
npm run check:transfer     # Neon's 5 GB/month cap: used, projected, and BY WHICH process
npm run sync:tenders       # pull Nordstrom's Manhattan TMS "Tender Accepted" emails
npm run check:tenders      # does the accepted pickup date/carrier match our routing cards?
npm run check:slack        # is the Slack lane live? names the exact missing token/scopes

```

## ⚠️ Develop against the local mirror, not Neon

Neon's Free plan allows **5 GB/month of public network transfer and SUSPENDS the
compute when it runs out** — not throttled, stopped, until the next billing period.
On 2026-08-14 we hit 84% by the 14th, and the measured cause was **development, not
the app**: 131 commits in two weeks, and every verification loop reads Neon over the
public internet (`check:counters` is 5.3 MB a run; a page load touching every surface
is 3.3 MB; the whole database is 26 MB).

```bash
npm run db:mirror      # one 29 MB read, clones all 49 tables into local Postgres
```

Then `WORKHUB_DB=mirror` in `.env.local` points everything — dev server, tests,
checks, scripts — at the clone. Comment it out to read Neon.

**One way only, on purpose.** Neon → local, replacing the local copy each time. The
app owns some of its data (BOL numbers that must never be reused, custody scans,
tasks), so two writable copies would mean conflict resolution on exactly the records
that must not diverge. The mirror is a disposable read replica for development.

**Monitoring it.** `npm run check:transfer` reports month-to-date, the daily rate, a
month-end projection and the split by source (`deploy` / `cron` / `local`) — the
projection is the signal, not the percentage, because 84% on the 14th suspends the
database and 84% on the 30th lands fine. Also on Health. ⚠️ It is an ESTIMATE and a
lower bound (row bytes, no TLS or wire framing); Neon's console is the authority, and
`--used=4.2GB` anchors the projection to their real figure.

⚠️ **`npm run migrate` follows `WORKHUB_DB` too.** It refuses to run against the mirror
unless you pass `--mirror`; use `WORKHUB_DB=neon npm run migrate` for the real one.
This already bit once — `transfer_log` was created on the clone while Neon, the
database that needed it, silently never got it.

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
src/ingest/manhattanTender.js pull + persist tenders; reconcile vs routing_shipment
src/model/slackCatchUp.js  Slack as a catch-up lane; lanes are addressing FACTS, never a score
src/ingest/slack.js       reads the 7 chosen channels + all DMs (needs a USER token, xoxp-)
server/queries.js        read orders (+fulfillments), re-apply flags
server/index.js          Express API + serves built client
client/src/views/        Dashboard · Kanban · TableView · Calendar
scripts/                 analyze / migrate / ingest / sync / rate entry points
scripts/db-mirror.js     clone Neon -> local Postgres (why: the 5 GB transfer cap)
docs/                    NetSuite saved-search design + document-linking strategy
```

## Open threads (need Nima's input)

- The two OC↔PO custom-field names in NetSuite (to ingest existing links).
- A PO-receiving saved-search export (spec in `docs/`) → unlocks the inbound↔
  outbound allocation link and the real-stall detector.
- Which UI view to keep as default (all four work today).
