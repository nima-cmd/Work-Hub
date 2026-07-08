// scripts/ingest.js — read the NetSuite saved-search CSV exports, build the
// unified pipeline, and load it into Neon. Run: `npm run ingest`.
//
// This is the CSV-export path (no live NetSuite API dependency). Re-run it each
// time you drop fresh exports; it upserts, so orders update in place.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseCsv } from '../src/ingest/csv.js'
import {
  fromOpenSalesOrders,
  fromUnpackedFulfillments,
  fromPendingOrders,
  fromInvoicedPending,
} from '../src/ingest/savedSearches.js'
import { buildPipeline } from '../src/model/pipeline.js'
import { deriveSource } from '../src/model/source.js'
import { loadOrders, loadFulfillments, loadInvoices, recordSnapshot } from '../src/ingest/loadToDb.js'
import { pool } from '../src/db.js'

const DATA_DIR =
  process.env.DATA_DIR ||
  '/Users/nimaerfani/Library/CloudStorage/GoogleDrive-nima@naghedinyc.com/Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data'

const read = (file) => parseCsv(readFileSync(join(DATA_DIR, file), 'utf8'))

const SOURCES = [
  ['WarehouseOpenSalesOrders.csv', fromOpenSalesOrders],
  ['Item Fulfilment unpacked.csv', fromUnpackedFulfillments],
  ['Pending Orders.csv', fromPendingOrders],
  ['invoiced order pending status.csv', fromInvoicedPending],
]

const records = []
for (const [file, fn] of SOURCES) {
  const mtime = statSync(join(DATA_DIR, file)).mtime
  const rows = fn(read(file))
  records.push(...rows)
  await recordSnapshot(file, rows.length, mtime)
  const exported = mtime.toISOString().slice(0, 16).replace('T', ' ')
  console.log(`  read ${String(rows.length).padStart(3)} rows from ${file}  (exported ${exported})`)
}

const orders = buildPipeline(records, { today: new Date() })

// Tag each order's channel (edi vs boutique) from the customer name.
for (const o of orders) o.source = deriveSource(o.customer)

const nOrders = await loadOrders(orders)
const nFul = await loadFulfillments(records)
const nInv = await loadInvoices(records)

console.log(`\n✅ Ingested: ${nOrders} orders · ${nFul} fulfillments · ${nInv} invoices`)
await pool.end()
