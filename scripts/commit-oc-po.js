// scripts/commit-oc-po.js — the ONLY thing that writes to oc_po_links.
// Matching is entirely manual (Nima, 2026-07-09): even an "unambiguous"
// suggestion from `npm run match:review` requires you to run this yourself.
//
// Usage:
//   node --env-file=.env.local scripts/commit-oc-po.js <OC#> <PO#> <item> <qty> [note]

import { upsertOcPoLink } from '../src/ingest/loadToDb.js'
import { pool } from '../src/db.js'

const [ocNumber, poNumber, item, qtyArg, ...noteParts] = process.argv.slice(2)

if (!ocNumber || !poNumber || !item || !qtyArg) {
  console.error('Usage: node --env-file=.env.local scripts/commit-oc-po.js <OC#> <PO#> <item> <qty> [note]')
  process.exit(1)
}

const allocatedQty = Number(qtyArg)
if (!Number.isFinite(allocatedQty) || allocatedQty <= 0) {
  console.error(`qty must be a positive number, got: ${qtyArg}`)
  process.exit(1)
}

await upsertOcPoLink({
  ocNumber, poNumber, item, allocatedQty,
  note: noteParts.join(' ') || 'manual commit',
})

console.log(`✅ committed ${ocNumber} -> ${poNumber} (${item}) qty ${allocatedQty}`)
await pool.end()
