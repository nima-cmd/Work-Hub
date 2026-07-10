// scripts/match-review.js — read-only report of what the OC↔PO matcher would
// suggest right now, straight from the current DB state. Never writes
// anything (matching stays entirely manual, per Nima 2026-07-09). Run:
//   npm run match:review

import { fetchOrderConfirmations, fetchPurchaseOrders, fetchOcPoLinks } from '../src/ingest/loadToDb.js'
import { computeOcPoMatches } from '../src/model/ocPoMatch.js'
import { pool } from '../src/db.js'

const ocs = await fetchOrderConfirmations()
const pos = await fetchPurchaseOrders()
const links = await fetchOcPoLinks()
const { suggestedMatches, candidates } = computeOcPoMatches({ ocs, pos, links })

console.log(`\n=== Suggested matches (${suggestedMatches.length}) — unambiguous 1:1, fully covered ===`)
console.log('Nothing here is committed. To commit one:')
console.log('  node --env-file=.env.local scripts/commit-oc-po.js <OC#> <PO#> <item> <qty>\n')
for (const m of suggestedMatches) {
  console.log(`  ${m.ocNumber.padEnd(8)} -> ${m.poNumber.padEnd(8)} ${m.item.padEnd(26)} qty ${m.allocatedQty}`)
}

console.log(`\n=== Needs a decision (${candidates.length}) ===`)
for (const c of candidates) {
  const ocList = c.ocs.map((o) => `${o.ocNumber}:${o.remaining}`).join(', ')
  const poList = c.pos.map((p) => `${p.poNumber}:${p.remaining}`).join(', ')
  console.log(`  [${c.reason}] ${c.item} @ ${c.location}`)
  console.log(`      OCs: ${ocList}`)
  console.log(`      POs: ${poList}`)
}

await pool.end()
