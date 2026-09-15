#!/usr/bin/env node
// scripts/check-containers.js — every inbound container in one place.
//
// Nima, 2026-09-15: "we have information on these container in different areas and it be
// nice to consolidate it all in one place."
//
// Four sources, each authoritative for something different:
//   packing slip  cartons, units, POs, and the FACTORY PACK date
//   GLC WiseGrid  the real ETD, the port arrival, the ports        (entered — no API)
//   NetSuite      the China receipt, and the transfer order per PO
//   a person      that it actually reached the door
//
//   node --env-file=.env.local scripts/check-containers.js

import { pool } from '../src/db.js'
import { containerLeg, nextAction } from '../src/model/containerTransfer.js'

const d = (v) => (v ? String(v).slice(0, 10) : null)
const { rows: slips } = await pool.query(
  `SELECT p.container_label AS label, p.container_num AS num, p.carton_count AS cartons,
          p.unit_count AS units, p.po_numbers AS pos,
          i.departed_on AS packed_on, i.forwarder, i.forwarder_ref, i.etd_on,
          i.port_arrived_on, i.arrived_on, i.tracking_number, i.origin_port, i.destination_port,
          i.eta_on, i.forwarder_source
     FROM packing_slip p LEFT JOIN inbound_shipment i USING (container_label)
    ORDER BY p.container_date DESC`)

for (const s of slips) {
  const { rows: tos } = await pool.query(
    `SELECT to_number AS "toNumber", status, units FROM container_transfer
      WHERE container_label = $1 ORDER BY to_number`, [s.label])
  const leg = containerLeg(tos)
  const act = nextAction({ transferOrders: tos, portArrivedOn: d(s.port_arrived_on) })

  console.log(`\n${'─'.repeat(74)}`)
  console.log(`${s.num}`)
  console.log(`${s.cartons} cartons · ${s.units} units · POs ${(s.pos || []).join(', ')}`)
  console.log(`${'─'.repeat(74)}`)
  console.log(`  packed (slip)   ${d(s.packed_on) || '—'}        ⚠ the factory's date, not departure`)
  console.log(`  forwarder       ${s.forwarder || '—'} ${s.forwarder_ref || ''}`)
  if (s.origin_port || s.destination_port) console.log(`  route           ${s.origin_port || '?'} → ${s.destination_port || '?'}`)
  console.log(`  ETD             ${d(s.etd_on) || '— not recorded from GLC'}`)
  // ⚠️ ETA AND PORT ARRIVAL ARE DIFFERENT FACTS and are never collapsed: one is a
  // prediction the forwarder is making, the other is something that happened.
  if (s.eta_on) console.log(`  ETA (predicted) ${d(s.eta_on)}`)
  console.log(`  port arrival    ${d(s.port_arrived_on) || (s.eta_on ? '— not yet' : '— not recorded from GLC')}`)
  if (s.tracking_number) console.log(`  tracking        ${s.tracking_number}`)
  // ⚠️ THE ONE LINE THE APP CANNOT FILL IN. Nima, 2026-09-15: "59 hasn't arrived it
  // arrived at port, the part where its transported to us is the part that is
  // invisible." GLC stops at the port of discharge; the drayage to Glendale is tracked
  // by nobody we can read.
  console.log(`  delivered       ${d(s.arrived_on) || '— NOT TRACKED ANYWHERE (drayage from the port)'}`)
  console.log()
  console.log(`  China leg       ${leg.known ? leg.leg : leg.why}${leg.mixed ? '  (MIXED — see below)' : ''}`)
  if (leg.known) {
    for (const t of leg.transferOrders) console.log(`     ${t.to.padEnd(7)} ${String(t.status).replace('Transfer Order : ', '').padEnd(22)}`)
    if (leg.unrecognised.length) console.log(`     ⚠ unrecognised: ${leg.unrecognised.join(', ')}`)
  }
  console.log()
  console.log(`  NEXT            ${act.action}`)
  if (act.why) console.log(`                  ${act.why}`)
}

// ⚠️ THE INTERESTING ORPHANS ONLY. 169 transfer orders match no container, and almost
// all are the outbound work src/model/transferOrder.js already tracks — memos like "for
// SO11677" or blank. Printing all 169 buries the handful that matter.
//
// ⚠️ THE ONES THAT MATTER ARE CONTAINER-SHAPED MEMOS WITH NO PACKING SLIP: "321 carton
// 2026.7.10", "264 carton 2026.6.18" and three more. Those are real containers whose
// slips were never imported — the transfer orders are a MORE COMPLETE container
// register than our packing slips are, which is worth knowing and was invisible until
// this sync existed.
const { rows: orphans } = await pool.query(
  `SELECT memo, count(*) tos, sum(units)::int units, min(trandate) first_seen
     FROM container_transfer
    WHERE container_label IS NULL AND memo ~ '[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}\\s*$'
    GROUP BY memo ORDER BY min(trandate)`)
if (orphans.length) {
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`CONTAINERS IN NETSUITE WITH NO PACKING SLIP IMPORTED — ${orphans.length}`)
  for (const o of orphans) {
    console.log(`   ${String(o.memo).padEnd(34)} ${String(o.tos).padStart(2)} TOs · ${String(o.units).padStart(5)} units · ${String(o.first_seen).slice(0, 10)}`)
  }
  console.log('   Their transfer orders are recorded; their cartons, SKUs and POs are not.')
}
await pool.end()
