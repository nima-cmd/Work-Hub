# Work Hub — Warehouse Order Pipeline Tracker

A single place where all incoming warehouse work lands so **nothing sits ignored**.
Aggregates NetSuite saved-search exports (and later Orderful EDI + Airtable) into one
aging-aware pipeline, and serves as the **task model that BitaQuest references** to
generate quests.

## The pipeline

Every order walks these stages. The tracker's job is to show *where each order is stuck
and for how long*:

```
Open ──► Picked ──► Packed ──► Invoiced ──► Approved for shipping ──► Shipped
(needs   (needs     (pending    (pending      (ready to go out)
 IF)      packing)   invoice)    payment)
```

## Project structure (kept modular on purpose)

```
src/
  ingest/
    csv.js            # dependency-free CSV parser (handles quotes, dup headers)
    savedSearches.js  # maps each NetSuite saved-search CSV → pipeline records
  model/
    stages.js         # canonical stage definitions + next-action per stage
    pipeline.js       # merges all sources into one Order per SO; aging + flags
scripts/
  analyze.js          # STEP 1 proof: read the 4 CSVs, print a "needs attention" report
```

## Roadmap

- **Step 1 ✅** validate the pipeline model against real CSV exports (`npm run analyze`).
- **Step 2 ✅** Neon (Postgres) + Express API + React/Vite UI with 3 switchable views
  (Dashboard / Kanban / Table), aging + ATS-aware alerts.
- **Step 3 (next):** PO-receiving import → inbound↔outbound allocation link; OC↔PO
  link as app source-of-truth; then Orderful EDI (API/webhooks) + Gmail/Slack triage.

## Run

```bash
# one-time: put your Neon connection string in .env.local (DATABASE_URL=...)

npm run migrate        # create/upgrade the database schema in Neon
npm run ingest         # load the latest saved-search CSV exports into the DB
npm run client:build   # build the React client
npm run server         # serve API + UI at http://localhost:3001

npm run dev            # OR: live-editing mode (Vite + API together)

npm run analyze        # CLI-only: print the attention list from CSVs (no DB)
```

Client lives in `client/` (React + Vite); API in `server/` (Express, reads Neon
via `src/db.js`); shared model in `src/model/`; ingest in `src/ingest/`.
