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
npm run ingest         # load NetSuite saved-search CSV exports into the DB
npm run server         # API + built UI at http://localhost:3001
npm run dev            # live-editing (Vite + API)
npm run analyze        # CLI attention list straight from CSVs (no DB)
```

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
- **IF ↔ Invoice** is derived via the shared SO (no manual entry).
- **OC ↔ PO** has no native NetSuite link — the app will own that mapping
  (`oc_po_links` table).
- **Natural keys** (SO#, IF#, INV#, PO#) are primary keys so re-imports upsert.

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
server/queries.js        read orders (+fulfillments), re-apply flags
server/index.js          Express API + serves built client
client/src/views/        Dashboard · Kanban · TableView · Calendar
scripts/                 analyze / migrate / ingest entry points
docs/                    NetSuite saved-search design + document-linking strategy
```

## Open threads (need Nima's input)

- The two OC↔PO custom-field names in NetSuite (to ingest existing links).
- A PO-receiving saved-search export (spec in `docs/`) → unlocks the inbound↔
  outbound allocation link and the real-stall detector.
- Which UI view to keep as default (all four work today).
