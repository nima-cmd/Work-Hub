// scripts/analyze.js
// STEP 1 proof — read the four NetSuite saved-search exports, merge them into
// the unified order pipeline, and print an aging-aware "needs attention"
// report. No database yet: this validates the model against real data before
// we commit it to Neon and build the UI.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseCsv } from '../src/ingest/csv.js'
import {
  fromOpenSalesOrders,
  fromUnpackedFulfillments,
  fromPendingOrders,
  fromInvoicedPending,
} from '../src/ingest/savedSearches.js'
import { buildPipeline } from '../src/model/pipeline.js'
import { STAGE_LABEL, STAGE_RANK, NEXT_ACTION } from '../src/model/stages.js'

const DATA_DIR =
  process.env.DATA_DIR ||
  '/Users/nimaerfani/Library/CloudStorage/GoogleDrive-nima@naghedinyc.com/Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data'

const read = (file) => parseCsv(readFileSync(join(DATA_DIR, file), 'utf8'))

const records = [
  ...fromOpenSalesOrders(read('WarehouseOpenSalesOrders.csv')),
  ...fromUnpackedFulfillments(read('Item Fulfilment unpacked.csv')),
  ...fromPendingOrders(read('Pending Orders.csv')),
  ...fromInvoicedPending(read('invoiced order pending status.csv')),
]

const orders = buildPipeline(records, { today: new Date() })

// ── Summary by stage ────────────────────────────────────────────────────────
const byStage = {}
for (const o of orders) byStage[o.stage] = (byStage[o.stage] || 0) + 1

console.log('\n=== PIPELINE SUMMARY ===')
console.log(`${orders.length} distinct orders  (from ${records.length} source rows)\n`)
Object.keys(STAGE_LABEL)
  .sort((a, b) => STAGE_RANK[a] - STAGE_RANK[b])
  .forEach((s) => {
    if (byStage[s]) console.log(`  ${String(byStage[s]).padStart(3)}  ${STAGE_LABEL[s]}`)
  })

// ATS-aware shortage split: stock exceptions vs. normal presold-awaiting-PO
const stockShort = orders.filter((o) => o.flags.some((f) => f.key === 'STOCK_SHORT'))
const awaitingPo = orders.filter((o) => o.flags.some((f) => f.key === 'AWAITING_PO'))
console.log(
  `\n  ${stockShort.length} ATS stock-short (exception · inquire)   ` +
    `${awaitingPo.length} non-ATS short (normal · awaiting PO)`,
)

// ── Needs attention (highest severity + longest waiting first) ───────────────
const flagged = orders
  .map((o) => ({
    o,
    sev: o.flags.reduce((m, f) => Math.max(m, f.severity), 0),
    days: o.daysPending ?? 0,
  }))
  .filter((x) => x.sev > 0)
  .sort((a, b) => b.sev - a.sev || b.days - a.days)

console.log('\n=== ⚠  NEEDS ATTENTION ===')
if (flagged.length === 0) console.log('  (nothing flagged)')
for (const { o } of flagged) {
  const ifs = o.fulfillments.map((f) => f.ifNumber).filter(Boolean).join(',')
  const flagText = o.flags.map((f) => f.label).join(' · ')
  const so = o.soNumber.padEnd(9)
  const who = (o.customer || '').slice(0, 30).padEnd(30)
  console.log(`  ${so} ${who} → ${NEXT_ACTION[o.stage]}${ifs ? `  [${ifs}]` : ''}`)
  console.log(`            ${flagText}`)
}
console.log('')
