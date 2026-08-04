// scripts/sync-warehouse-inventory.js — push stocked item-location quantities
// to the Naghedi-Warehouse app's Supabase (ns_item_location_qtys), replacing
// its manual "Warehouse Item View" CSV import.
//
//   npm run sync:warehouse-inventory
//
// The recurring sync (syncFromNetsuite) runs this same push every cycle; this
// is the manual/first-run entry point. Reads NetSuite (SuiteQL, read-only) and
// writes ONLY ns_item_location_qtys — never the warehouse app's own tables.
// See docs/warehouse-po-feed.md for the table DDL and the design.
import { pushWarehouseInventory, warehouseFeedConfigured } from '../src/ingest/warehouseFeed.js'

if (!warehouseFeedConfigured()) {
  console.error('✗ not configured — needs WAREHOUSE_SUPABASE_URL + WAREHOUSE_SUPABASE_KEY')
  console.error('  (or the VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY pair already in .env.local)')
  process.exit(1)
}

console.log('Pushing stocked item-location quantities → Naghedi-Warehouse Supabase …')
const r = await pushWarehouseInventory()

if (!r.ok) {
  console.error(`✗ push failed: ${r.error}`)
  if (r.pushed) console.error(`  (${r.pushed} rows had already upserted — the sweep did not run, stale rows remain until the next successful push)`)
  process.exit(1)
}

console.log(`✓ ${r.pushed} item-location rows (${r.skippedNoSku} keyless rows excluded, ${r.swept} stale rows swept)`)
console.log(`  batch stamp ${r.syncedAt}`)
