#!/usr/bin/env node
// npm run sync:routing            — sweep the mailbox and apply what is unambiguous
// npm run sync:routing -- --dry   — show what it WOULD do, write nothing
// npm run sync:routing -- --days=7
//
// Pulls the Macy's/Bloomingdale's routing notifications and applies each one to the
// routing board on a DUAL EXACT MATCH of project AND shipment number. Anything else
// is printed for a human. See src/model/macysRouting.js for every rule.

import { pool } from '../src/db.js'
import { syncMacysRouting } from '../src/ingest/macysRouting.js'
import { summarizeRoutingMisses, MISS } from '../src/model/macysRouting.js'

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const dryRun = process.argv.includes('--dry')
const sinceDays = arg('days') ? Number(arg('days')) : null

const r = await syncMacysRouting({ dryRun, sinceDays })

console.log(`\n  Macy's routing notifications${dryRun ? '  (DRY RUN — nothing written)' : ''}`)
console.log(`  ${'─'.repeat(72)}`)
console.log(`  ${r.fetched} email(s) read · ${r.notifications} authorization(s) ` +
  `· ${r.live} live · ${r.historical} historical`)

if (r.checksumFailed.length) {
  console.log(`  ⚠️  ${r.checksumFailed.length} notification(s) whose stop list does not account for ` +
    `every project in their subject: ${r.checksumFailed.join(', ')}`)
}

const LABEL = {
  [MISS.NO_MATCH]: 'matches no card',
  [MISS.PROJECT_ONLY]: '⚠️  project matched, shipment did not',
  [MISS.SHIPMENT_ONLY]: '⚠️  shipment matched, project did not',
  [MISS.UNPAIRED]: '⚠️  block counts disagreed — paired nothing',
  [MISS.AUTH_CONFLICT]: '⚠️  already authorized with a different number',
  [MISS.DC_DISAGREES]: '⚠️  applied, but the consignee names another DC',
  [MISS.SHIP_DATE_HELD]: 'settled card keeps its ship date',
}

for (const { notification: n, plan } of r.reports) {
  if (plan.outOfScope) continue
  console.log(`\n  ${n.authNumber} · pickup ${n.pickupDate} · ${n.carrier} (${n.scac})` +
    (n.receivedAt ? ` · received ${n.receivedAt.toISOString().slice(0, 10)}` : ''))
  for (const a of plan.applies) {
    const bits = Object.entries(a.set).map(([k, v]) => (
      // A moved date is spelled out from → to. This lane is allowed to change a ship
      // date only while a card is unsettled, and never quietly.
      k === 'shipDate' ? `ship date ${a.shipDateWas || 'unset'} → ${v}` : `${k} ${v}`
    ))
    console.log(`      ${a.bolNumber || `#${a.shipmentId}`} ${a.dc} · project ${a.projectNumber}` +
      (bits.length ? ` · ${bits.join(' · ')}` : ' · already current'))
  }
  for (const m of plan.misses) console.log(`      ${LABEL[m.kind]}: ${m.detail}`)
}

if (r.historical) {
  // Named, never hidden — a silent cap reads as "covered everything".
  const ids = r.reports.filter((x) => x.plan.outOfScope).map((x) => x.notification.authNumber)
  console.log(`\n  ${r.historical} historical notification(s) skipped — no routing card still ` +
    `holds their project/shipment numbers:\n      ${ids.join(', ')}`)
}

const s = summarizeRoutingMisses(r.reports.map((x) => x.plan))
console.log(`\n  ${'─'.repeat(72)}`)
console.log(`  applied to ${r.applied} card(s), ${r.fields} field(s)${dryRun ? ' (would have)' : ''}`)
console.log(`  no match ${s.noMatch} · project-only ${s.projectOnly} · shipment-only ${s.shipmentOnly} ` +
  `· unpaired ${s.unpaired} · auth conflict ${s.authConflict} · DC disagrees ${s.dcDisagrees} ` +
  `· ship date held ${s.shipDateHeld}\n`)

await pool.end()
process.exit(0)
