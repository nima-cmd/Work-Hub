// scripts/sync-warehouse-pos.js — push open PO lines to the Naghedi-Warehouse
// app's Supabase (ns_open_po_lines), replacing its manual PO CSV import.
//
//   npm run sync:warehouse-pos
//
// The recurring sync (syncFromNetsuite) runs this same push every cycle; this
// is the manual/first-run entry point. Reads NetSuite (SuiteQL, read-only) and
// writes ONLY ns_open_po_lines — never the warehouse app's own tables.
// See docs/warehouse-po-feed.md for the table DDL and the design.
import { pushWarehousePoLines, warehouseFeedConfigured } from '../src/ingest/warehouseFeed.js'

if (!warehouseFeedConfigured()) {
  console.error('✗ not configured — needs WAREHOUSE_SUPABASE_URL + WAREHOUSE_SUPABASE_KEY')
  console.error('  (or the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY pair already in .env.local)')
  process.exit(1)
}

console.log('Pushing open PO lines → Naghedi-Warehouse Supabase …')
const r = await pushWarehousePoLines()

if (!r.ok) {
  console.error(`✗ push failed: ${r.error}`)
  if (r.pushed) console.error(`  (${r.pushed} rows had already upserted — the sweep did not run, stale rows remain until the next successful push)`)
  process.exit(1)
}

console.log(`✓ ${r.pushed} item lines across ${r.poCount} open POs (${r.skippedNonItem} non-item lines excluded, ${r.swept} stale rows swept)`)
console.log(`  batch stamp ${r.syncedAt}`)
