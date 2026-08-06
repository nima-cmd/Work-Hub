#!/usr/bin/env node
// npm run check:tenders
//
// Does what Nordstrom ACCEPTED match what our routing shipments say?
//
// We submit a routing request with a ship date we chose; the TMS answers with the date
// the truck will actually come. Those two are not the same thing, and only ours is on
// the board — `routing_shipment.ship_date` is the EDI ship-date basis feeding
// shipDateAdvice, so a stale one dates a departure that has not happened.
//
// Exits 1 when a LIVE tender disagrees with us, 0 when everything reconciles.
//
// ⚠️ Reports differences only. It never writes to routing_shipment: ship_date, carrier
// and routing_request_number are Nima's hand entry, and the register already taught us
// that quietly overwriting a hand-set field destroys the surface's most useful
// statement (see docs + src/model/custody.js). Applying a tender is a click, not a cron.

import { pool } from '../src/db.js'
import { reconcileAll } from '../src/ingest/manhattanTender.js'
import { summarizeTenderDiffs, TENDER_DIFF, SRR_PAIRING } from '../src/model/manhattanTender.js'

const results = await reconcileAll({ limit: 50 })
const live = results.filter((r) => !r.report.outOfScope)
const historical = results.filter((r) => r.report.outOfScope)

console.log('\n  Manhattan tender vs our routing shipments')
console.log(`  ${'─'.repeat(72)}`)

if (!results.length) {
  console.log('  no tenders ingested — run `npm run sync:tenders` first\n')
  await pool.end()
  process.exit(0)
}

const LABEL = {
  [TENDER_DIFF.PICKUP_DATE]: 'pickup date',
  [TENDER_DIFF.CARRIER]: 'carrier',
  [TENDER_DIFF.SRR]: 'SRR',
  [TENDER_DIFF.NO_SHIPMENT]: 'no routing shipment',
  [TENDER_DIFF.CARTONS]: 'cartons',
}

let bad = 0
for (const { tender, report } of live) {
  const pickup = report.pickupYmd || '—'
  console.log(`\n  ${tender.shipmentId} · pickup ${pickup} · ${tender.carrier || 'no carrier'}`)
  console.log(`      ${report.matched}/${report.stops} DC(s) matched · ` +
    `cartons ${report.ourCartons} ours / ${report.theirCartons ?? '?'} theirs ` +
    `${report.cartonsAgree === true ? '✓ reconciled' : report.cartonsAgree === false ? '✗ DISAGREE' : '(partial — not checked)'}`)

  if (report.srrPairing === SRR_PAIRING.COUNT_MISMATCH) {
    console.log('      ⚠️  SRR/DC counts disagreed on this tender — no SRR was paired')
  }

  if (!report.diffs.length) {
    console.log('      ✓ nothing to change')
    continue
  }
  bad++
  // Grouped by fact, never lumped into one "N problems" number.
  const groups = new Map()
  for (const d of report.diffs) {
    if (!groups.has(d.kind)) groups.set(d.kind, [])
    groups.get(d.kind).push(d)
  }
  for (const [kind, ds] of groups) {
    console.log(`      ${ds.length}× ${LABEL[kind]}`)
    for (const d of ds.slice(0, 10)) console.log(`          ${d.detail}`)
    if (ds.length > 10) console.log(`          … and ${ds.length - 10} more`)
  }
}

if (historical.length) {
  // Named, not hidden — a silent cap reads as "covered everything".
  console.log(`\n  ${historical.length} historical tender(s) skipped — no routing shipment ` +
    `still holds their POs:\n      ${historical.map((h) => h.tender.shipmentId).join(', ')}`)
}

const s = summarizeTenderDiffs(results.map((r) => r.report))
console.log(`\n  ${'─'.repeat(72)}`)
console.log(`  ${s.tenders} tender(s) · ${live.length} live · ${s.outOfScope} historical`)
console.log(`  pickup-date ${s.pickupDate} · carrier ${s.carrier} · SRR ${s.srr} · ` +
  `unmatched DC ${s.noShipment} · carton ${s.cartons}`)
console.log(bad
  ? `  ✗ ${bad} live tender(s) disagree with the board\n`
  : '  ✓ every live tender agrees with our routing shipments\n')

await pool.end()
process.exit(bad ? 1 : 0)
