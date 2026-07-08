// scripts/match-oc-po.js — empirical check: can we join OC SKUs to PO SKUs?
// Reads the two SKU search exports and tests several matching rules so we know
// the real join key before building the allocation matcher. Run:
//   node scripts/match-oc-po.js
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseCsv } from '../src/ingest/csv.js'

const DATA_DIR =
  process.env.DATA_DIR ||
  '/Users/nimaerfani/Library/CloudStorage/GoogleDrive-nima@naghedinyc.com/Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data'
const read = (f) => parseCsv(readFileSync(join(DATA_DIR, f), 'utf8'))

const oc = read('OCSKUSearchGame.csv')
const po = read('POSKUSearchGame.csv')

const ocItems = new Set(oc.map((r) => r.Item).filter(Boolean))
const poItems = new Set(po.map((r) => r.Item).filter(Boolean))

const stripSize = (s) => s.replace(/-\d+$/, '') // NS...-MYKONOS-365 -> NS...-MYKONOS
const swapPrefix = (s) =>
  s.startsWith('NS') ? 'SN' + s.slice(2) : s.startsWith('SN') ? 'NS' + s.slice(2) : s

const inter = (a, b) => [...a].filter((x) => b.has(x)).length

const ocStyleColor = new Set([...ocItems].map(stripSize))
const ocSwap = new Set([...ocStyleColor].map(swapPrefix))

console.log('OC lines:', oc.length, '| distinct OC items:', ocItems.size)
console.log('PO lines:', po.length, '| distinct PO items:', poItems.size)
console.log('')
console.log('exact item match:               ', inter(ocItems, poItems))
console.log('OC size-stripped ∩ PO:          ', inter(ocStyleColor, poItems))
console.log('OC size-stripped + NS→SN ∩ PO:  ', inter(ocSwap, poItems))
console.log('')
console.log('sample OC items:', [...ocItems].slice(0, 4))
console.log('sample PO items:', [...poItems].slice(0, 4))
console.log('')
const dests = [...new Set(po.map((r) => r['Final Naghedi Destination']).filter(Boolean))]
console.log('PO Final Naghedi Destinations:', dests.slice(0, 12))
const ocLocs = [...new Set(oc.map((r) => r.Location).filter(Boolean))]
console.log('OC Locations:', ocLocs.slice(0, 12))

// The real allocation match: OC demand line ↔ PO supply, keyed on
// item + (OC.Location == PO.Final Naghedi Destination).
const poByKey = new Map()
for (const r of po) {
  if (!r.Item) continue
  const key = r.Item + '@@' + (r['Final Naghedi Destination'] || '')
  if (!poByKey.has(key)) poByKey.set(key, [])
  poByKey.get(key).push(r)
}
let matched = 0
let unmatched = 0
const samples = []
for (const r of oc) {
  if (!r.Item) continue
  const pos = poByKey.get(r.Item + '@@' + (r.Location || ''))
  if (pos && pos.length) {
    matched++
    if (samples.length < 8) {
      const p = pos[0]
      samples.push(
        `  ${r.Item.padEnd(26)} @ ${(r.Location || '?').padEnd(28)} OC ${String(r.Quantity).padStart(3)} → ${p['Document Number']} remaining ${p['Quantity Remaining']} (ETA ${p['Expected Receipt Date'] || '—'})`,
      )
    }
  } else unmatched++
}
const pct = Math.round((100 * matched) / (matched + unmatched))
console.log('\n=== OC demand lines matched to a PO (item + destination) ===')
console.log(`matched: ${matched} | unmatched: ${unmatched}  (${pct}% of OC lines covered)`)
console.log(samples.join('\n'))
