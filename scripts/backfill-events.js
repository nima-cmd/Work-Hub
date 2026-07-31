// scripts/backfill-events.js — populate the order-event ledger from history.
//
//   npm run backfill:events            report what WOULD be written (default)
//   npm run backfill:events -- --write actually write it
//   npm run backfill:events -- --write --sync   also write observed-quality events
//
// Dry by default on purpose: this writes into the ledger the Calendar and the
// order history read from, and a wrong run is tedious to unpick.
//
// Backfill mode writes only events carrying a REAL timestamp from the source data
// (an IF's ship date, an 856's transmission time). Transitions with no recorded
// date — PACKED, INVOICED, PAID — are skipped, because stamping them with today
// would invent a history that never happened. They start accruing honestly from
// the next sync. Pass --sync to override that and accept today's date for them;
// you almost never want this on a first run.
//
// Safe to re-run: one event per (type, document), ever.
import { deriveOrderEvents } from '../src/ingest/loadToDb.js'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const mode = argv.includes('--sync') ? 'sync' : 'backfill'

const before = await pool.query('SELECT count(*)::int n FROM order_events')

const res = await deriveOrderEvents({ mode, dryRun: !write })
const rows = Object.entries(res.byType).sort((a, b) => b[1] - a[1])

console.log(`\nLedger backfill — mode ${mode}${write ? '' : ' (DRY RUN, nothing written)'}`)
console.log(`  order_events before: ${before.rows[0].n}`)

if (!rows.length) {
  console.log('\n  Nothing to add — the ledger is already current.')
} else {
  const total = rows.reduce((s, [, n]) => s + n, 0)
  console.log(`\n  ${write ? 'Wrote' : 'Would write'} ${total} event(s):`)
  for (const [type, n] of rows) console.log(`    ${String(n).padStart(6)}  ${type}`)
}

if (mode === 'backfill') {
  console.log('\n  Skipped: PACKED / INVOICED / PAID — no real timestamp exists for these,')
  console.log('  so they are left to accrue from the next sync rather than dated today.')
}
if (!write) console.log('\n  Re-run with --write to commit.')

const after = await pool.query('SELECT count(*)::int n FROM order_events')
console.log(`  order_events after:  ${after.rows[0].n}\n`)

await pool.end()
