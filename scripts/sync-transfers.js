#!/usr/bin/env node
// npm run sync:transfers  [--dry-run]
//
// Pulls the transfer orders we track — Office and Consignment — and their fulfilments.
//
// ⚠️ 173 of 187 transfers are NOT this work (138 inbound to the warehouse, 33 to
// partner locations). See src/model/transferOrder.js for why the tracked set is a
// named list rather than an inferred rule.

import { pool } from '../src/db.js'
import { syncTransferOrders } from '../src/ingest/transferOrders.js'
import { TRACKED_DESTINATIONS } from '../src/model/transferOrder.js'

const dryRun = process.argv.includes('--dry-run')
const r = await syncTransferOrders({ dryRun })

console.log(`\n  Transfer orders${dryRun ? '  (DRY RUN — nothing written)' : ''}`)
console.log(`  ${'─'.repeat(72)}`)
if (!r.configured) {
  console.log('  NetSuite is not configured — nothing to do.\n')
  await pool.end()
  process.exit(2)
}
console.log(`  ${r.fetched} transfer order(s) in NetSuite · ${r.tracked} tracked (${TRACKED_DESTINATIONS.join(' · ')})`)
console.log(`  ${r.fulfillments} fulfilment(s) · ${r.withTracking} with a tracking number`)

if (r.untracked.length) {
  // ⚠️ Listed, not hidden. A destination appearing here that Nima wants tracked is a
  // one-line change; a destination nobody ever sees is freight going untracked.
  console.log('\n  Not tracked (say the word to include any of these):')
  for (const u of r.untracked) console.log(`    ${String(u.count).padStart(4)}  → ${u.destination}`)
}

if (!dryRun) {
  const { rows } = await pool.query(
    `SELECT t.to_number, t.destination, t.status, f.if_number, f.status AS if_status,
            array_length(f.tracking_numbers, 1) AS labels
       FROM transfer_order t
       LEFT JOIN fulfillments f ON f.so_number = t.to_number
      ORDER BY t.trandate DESC NULLS LAST, t.to_number DESC`)
  console.log('')
  for (const x of rows) {
    const shortStatus = String(x.status || '').replace('Transfer Order : ', '')
    console.log(`    ${String(x.to_number).padEnd(7)} → ${String(x.destination).padEnd(12)} ${String(x.if_number || '—').padEnd(8)} `
      + `${String(x.if_status || '—').padEnd(8)} ${x.labels ? x.labels + ' label(s)' : 'no label'}   ${shortStatus}`)
  }
  console.log(`\n  wrote ${r.written} row(s)`)
}
console.log('')
await pool.end()
