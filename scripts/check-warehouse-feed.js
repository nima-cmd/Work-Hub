// scripts/check-warehouse-feed.js — did the warehouse-feed go-live actually work?
//
//   npm run check:warehouse-feed
//
// Probes the two Work-Hub-owned tables in the Naghedi-Warehouse Supabase and
// names the go-live step that's still missing:
//   table 404      → the CREATE TABLE block in docs/warehouse-po-feed.md not run
//   table empty    → the seed script not run
//   rows but stale → nothing pushing on the deploy (Render WAREHOUSE_* vars)
//   rows and fresh → live end-to-end
import { checkWarehouseFeedTables } from '../src/ingest/warehouseFeed.js'
import { SYNC_STALE_HOURS } from '../src/model/syncHealth.js'

const r = await checkWarehouseFeedTables()
if (!r.configured) {
  console.error('✗ not configured — needs WAREHOUSE_SUPABASE_URL + WAREHOUSE_SUPABASE_KEY')
  console.error('  (or the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY pair already in .env.local)')
  process.exit(1)
}

const fmtAge = (h) =>
  h >= 24 ? `${Math.floor(h / 24)}d ${Math.round(h % 24)}h` : h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m`

let missing = 0, empty = 0, stale = 0, errors = 0
for (const t of r.tables) {
  if (t.status === 'missing') {
    missing++
    console.log(`✗ ${t.table} — table does not exist`)
  } else if (t.status === 'empty') {
    empty++
    console.log(`✗ ${t.table} — exists but has no rows (seed: ${t.seed})`)
  } else if (t.status === 'error') {
    errors++
    console.log(`✗ ${t.table} — probe failed: ${t.error}`)
  } else if (t.status === 'stale') {
    stale++
    console.log(`⚠ ${t.table} — ${t.rows} rows, but the newest snapshot is ${fmtAge(t.ageHours)} old`)
  } else {
    const late = t.status === 'warn' ? ' (later than the usual cycle — watch the next one)' : ''
    console.log(`✓ ${t.table} — ${t.rows} rows, snapshot ${fmtAge(t.ageHours)} old${late}`)
  }
}

console.log('')
if (missing) {
  console.log('Next step: run the combined CREATE TABLE block in docs/warehouse-po-feed.md')
  console.log('(Supabase SQL editor — the anon key cannot create tables), then seed:')
  console.log('  npm run sync:warehouse-pos && npm run sync:warehouse-inventory')
} else if (empty) {
  console.log('Next step: seed — npm run sync:warehouse-pos && npm run sync:warehouse-inventory')
} else if (stale) {
  console.log(`Rows landed once but nothing has pushed in over ${SYNC_STALE_HOURS}h. If that was the`)
  console.log('local seed, the deploy is not pushing — check the WAREHOUSE_* vars on Render.')
} else if (!errors) {
  console.log('Both feeds are live. The warehouse app reads ns_open_po_lines on load —')
  console.log('its Data Status pill should read "Open PO Lines (Work-Hub feed)".')
}
process.exit(missing || empty || stale || errors ? 1 : 0)
