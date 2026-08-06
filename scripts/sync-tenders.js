#!/usr/bin/env node
// npm run sync:tenders  [--dry-run] [--max=N]
//
// Pulls Nordstrom's Manhattan Active TMS "Tender Accepted" emails and persists them.
// That email is the only place the ACCEPTED pickup datetime, the carrier, and the
// per-DC SRR exist — our own routing_shipment rows carry the date we ASKED for.
//
// Read-only against Gmail; the only writes are tms_tender / tms_tender_stop. It never
// touches routing_shipment — those fields are hand-entered by Nima, and the tender is
// evidence, not an overwrite. `npm run check:tenders` reports where they disagree.

import { pool } from '../src/db.js'
import { syncTenders } from '../src/ingest/manhattanTender.js'
import { SRR_PAIRING } from '../src/model/manhattanTender.js'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const max = Number((argv.find((a) => a.startsWith('--max=')) || '').split('=')[1]) || 100

const r = await syncTenders({ max, dryRun })

console.log(`\n  Manhattan tenders${dryRun ? '  (DRY RUN — nothing written)' : ''}`)
console.log(`  ${'─'.repeat(72)}`)
console.log(`  ${r.fetched} email(s) matched · ${r.parsed} parsed · ${r.shipments} distinct shipment(s)`)
if (r.parsed > r.shipments) {
  console.log(`  ⚠️  ${r.parsed - r.shipments} re-sent tender(s) collapsed onto their shipment id`)
}
console.log('')

for (const t of r.tenders) {
  const pickup = t.pickupAt ? t.pickupAt.toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—'
  console.log(`  ${t.shipmentId}  pickup ${pickup}  (${t.pickupRaw || 'unparsed'})`)
  console.log(`      carrier ${t.carrier || '—'} · ${t.totalCartons ?? '?'} cartons · ` +
    `${t.totalWeightLb ?? '?'} lb · ${t.stops.length} DC(s) from ${t.spoCount} SPO(s)`)
  if (t.srrPairing === SRR_PAIRING.COUNT_MISMATCH) {
    console.log(`      ⚠️  ${t.srrCount} SRR(s) against ${t.stops.length} DC(s) — NOT paired. ` +
      `An SRR on the wrong DC is worse than none.`)
  } else if (t.srrPairing === SRR_PAIRING.NO_SRR) {
    console.log('      ⚠️  no SRR list on this tender')
  } else {
    console.log(`      SRR: ${t.stops.map((s) => `${s.dc}→${(s.srr || '').slice(-3)}`).join(' · ')}`)
  }
}

if (!dryRun) console.log(`\n  wrote ${r.shipments} tender(s), ${r.stops} stop(s)\n`)
await pool.end()
