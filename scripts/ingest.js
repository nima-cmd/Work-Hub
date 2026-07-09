// scripts/ingest.js — read the NetSuite saved-search CSV exports, build the
// unified pipeline, and load it into Neon. Run: `npm run ingest`.
//
// This is the CSV-export path (no live NetSuite API dependency). Re-run it each
// time you drop fresh exports; it upserts, so orders update in place.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { existsSync } from 'node:fs'

import { parseCsv } from '../src/ingest/csv.js'
import { fromOpenSalesOrders, fromFulfillmentPipeline } from '../src/ingest/savedSearches.js'
import { buildPipeline } from '../src/model/pipeline.js'
import { deriveSource } from '../src/model/source.js'
import { loadOrders, loadFulfillments, loadInvoices, recordSnapshot, pruneOrders } from '../src/ingest/loadToDb.js'
import { pool, withTransaction } from '../src/db.js'

const DATA_DIR =
  process.env.DATA_DIR ||
  '/Users/nimaerfani/Library/CloudStorage/GoogleDrive-nima@naghedinyc.com/Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data'

const read = (file) => parseCsv(readFileSync(join(DATA_DIR, file), 'utf8'))

// [filename, source-type key, mapper]. The app now runs on two consolidated
// searches. Snapshots are recorded under the source-type key (not the filename)
// so a renamed export can't create a phantom "stale forever" entry. Filenames
// change as the searches are iterated — a missing one is skipped with a warning
// rather than crashing the whole ingest.
const SOURCES = [
  ['WarehouseOrderPipelinev2.csv', 'openSalesOrders', fromOpenSalesOrders],
  ['WarehouseFulfillmentPipeline.csv', 'fulfillmentPipeline', fromFulfillmentPipeline],
]

// Read + parse all CSVs first (pure, no DB) so the transaction below only
// wraps the writes and stays short.
const records = []
const snapshots = []
for (const [file, key, fn] of SOURCES) {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) {
    console.log(`  ⚠ skipped ${file} — not found (rename or export it, then re-run)`)
    continue
  }
  const mtime = statSync(path).mtime
  const rows = fn(read(file))
  records.push(...rows)
  snapshots.push([key, rows.length, mtime])
  const exported = mtime.toISOString().slice(0, 16).replace('T', ' ')
  console.log(`  read ${String(rows.length).padStart(3)} rows from ${file}  (exported ${exported})`)
}

const orders = buildPipeline(records, { today: new Date() })

// Tag each order's channel (edi vs boutique); location is the authoritative signal.
for (const o of orders) o.source = deriveSource(o.customer, o.location)

// The order-pipeline export is the master list of open orders. Only prune when
// it was actually part of this run (skip if it was missing/skipped above).
const hasMaster = snapshots.some(([key]) => key === 'openSalesOrders')

// All writes in ONE transaction — a crash partway (e.g. a bad row) rolls the
// whole import back rather than stranding orders at a half-updated stage.
const { nOrders, nFul, nInv, nPruned } = await withTransaction(async (db) => {
  for (const [key, count, mtime] of snapshots) await recordSnapshot(key, count, mtime, db)
  const nOrders = await loadOrders(orders, db)
  const nFul = await loadFulfillments(records, db)
  const nInv = await loadInvoices(records, db)
  const nPruned = hasMaster ? await pruneOrders(orders.map((o) => o.soNumber), db) : 0
  return { nOrders, nFul, nInv, nPruned }
})

console.log(`\n✅ Ingested: ${nOrders} orders · ${nFul} fulfillments · ${nInv} invoices`)
if (nPruned) console.log(`   pruned ${nPruned} order(s) no longer in the open pipeline`)
await pool.end()
