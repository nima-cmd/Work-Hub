// Correct IF_CREATED events that were dated from the wrong column.
//
// `fulfillments.if_date` is the IF's transaction date, and NetSuite REWRITES it to the
// ship date when the IF ships — measured: if_date = actual_ship_date on all 205 shipped
// fulfilments. IF_CREATED was derived from it, so the FIRST event on an order's
// timeline claimed the fulfilment was made the day it left. 83 of 281 were wrong.
//
// The sync now derives IF_CREATED from NetSuite's own `createddate` (a real timestamp:
// IF7240 created 2026-06-22 12:18 against a trandate of 2026-07-10). But eventKey
// dedupe deliberately excludes occurred_at, so a re-sync will never re-date the rows
// that already exist. This corrects them once, explicitly.
//
// ⚠️ THIS IS NOT A GUESS BEING WRITTEN AS A FACT. The honest-timestamp rule in
// orderEvents.js forbids inventing a date; this does the opposite — it replaces a date
// derived from the wrong column with the one NetSuite records. It only ever touches a
// row where a real `if_created_at` exists, and it never invents one.
//
// ⚠️ The 122 events that were already correct were right by ACCIDENT OF SYNC ORDER —
// captured before NetSuite rewrote the column. They are corrected too where createddate
// disagrees, because "right for the wrong reason" is not a state worth preserving.
//
// Usage:
//   node --env-file=.env.local scripts/backfill-if-created.js          # dry run
//   node --env-file=.env.local scripts/backfill-if-created.js --apply

import { pool, DB_TARGET } from '../src/db.js'

const apply = process.argv.includes('--apply')

const SELECT = `
  SELECT e.id, e.doc_number AS if_number,
         e.occurred_at AS was,
         f.if_created_at AS should_be,
         f.if_date, f.actual_ship_date,
         (e.occurred_at::date = f.actual_ship_date) AS was_the_ship_date
    FROM order_events e
    JOIN fulfillments f ON f.if_number = e.doc_number
   WHERE e.event_type = 'IF_CREATED'
     AND f.if_created_at IS NOT NULL
     AND e.occurred_at <> f.if_created_at
   ORDER BY e.occurred_at DESC`

const rows = (await pool.query(SELECT)).rows

console.log(`Database: ${DB_TARGET}`)
console.log(`IF_CREATED events whose date disagrees with NetSuite's createddate: ${rows.length}`)
if (!rows.length) {
  console.log('Nothing to correct.')
  process.exit(0)
}

const wasShipDate = rows.filter((r) => r.was_the_ship_date)
console.log(`  ...of which were dated with the SHIP day: ${wasShipDate.length}`)

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—')
const drift = (r) => Math.round((new Date(day(r.was)) - new Date(day(r.should_be))) / 86_400_000)
const sorted = [...rows].sort((a, b) => drift(b) - drift(a))
console.log('\nWorst drift (event date vs real creation date):')
for (const r of sorted.slice(0, 8)) {
  console.log(`  ${r.if_number}  said ${day(r.was)}  actually ${day(r.should_be)}  ` +
    `${drift(r)}d late${r.was_the_ship_date ? '  (it was the ship date)' : ''}`)
}

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to correct ${rows.length} events.`)
  process.exit(0)
}

// One statement, so a partial correction cannot leave the ledger half-right.
const res = await pool.query(`
  UPDATE order_events e
     SET occurred_at = f.if_created_at
    FROM fulfillments f
   WHERE f.if_number = e.doc_number
     AND e.event_type = 'IF_CREATED'
     AND f.if_created_at IS NOT NULL
     AND e.occurred_at <> f.if_created_at`)

console.log(`\nCorrected ${res.rowCount} IF_CREATED events.`)

const left = (await pool.query(SELECT)).rows.length
console.log(left === 0
  ? 'Verified: every IF_CREATED event with a known creation date now matches it.'
  : `⚠️ ${left} still disagree — investigate before trusting the timeline.`)
process.exit(0)
