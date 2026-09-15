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
import { deliveryFor, unusableWindow } from '../src/model/containerDelivery.js'
import { displayNameFor } from '../src/model/containerAlias.js'

const d = (v) => (v ? String(v).slice(0, 10) : null)
const { rows: slips } = await pool.query(
  `SELECT p.container_label AS label, p.container_num AS num, p.carton_count AS cartons,
          p.unit_count AS units, p.po_numbers AS pos,
          i.departed_on AS packed_on, i.forwarder, i.forwarder_ref, i.etd_on,
          i.port_arrived_on, i.arrived_on, i.tracking_number, i.origin_port, i.destination_port,
          i.eta_on, i.forwarder_source, i.display_name,
          i.delivered_on, i.delivered_by, i.delivered_note
     FROM packing_slip p LEFT JOIN inbound_shipment i USING (container_label)
    ORDER BY p.container_date DESC`)

for (const s of slips) {
  const { rows: tos } = await pool.query(
    `SELECT to_number AS "toNumber", status, units,
            fulfilled_on AS "fulfilledOn", received_on AS "receivedOn"
       FROM container_transfer
      WHERE container_label = $1 ORDER BY to_number`, [s.label])
  const leg = containerLeg(tos)
  // ⚠️ THE TRACKING NUMBER AND FORWARDER REF ARE PASSED IN — without them nextAction
  // has nothing observed to key on and falls back to describing a leg nobody entered.
  const act = nextAction({
    transferOrders: tos, portArrivedOn: d(s.port_arrived_on),
    trackingNumber: s.tracking_number, forwarderRef: s.forwarder_ref, forwarder: s.forwarder,
  })
  const del = deliveryFor({
    transferOrders: tos, portArrivedOn: s.port_arrived_on,
    deliveredOn: s.delivered_on, deliveredBy: s.delivered_by,
  })
  const win = unusableWindow(tos)

  const { rows: aliases } = await pool.query(
    `SELECT alias, source FROM container_alias WHERE container_label = $1 AND source <> 'slip' ORDER BY source`, [s.label])
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`${displayNameFor(s.label, s.display_name)}`)
  console.log(`${s.cartons} cartons · ${s.units} units · POs ${(s.pos || []).join(', ')}`)
  // ⚠️ Every name it answers to, so someone searching from an email, a filename or the
  // GLC portal finds the same container.
  if (aliases.length) {
    console.log(`also known as:`)
    for (const a of aliases) console.log(`   ${a.source.padEnd(10)} ${a.alias}`)
  }
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
  // ⚠️ THE STATE, NOT A DATE. "unknown" is a real answer here and must not read as
  // "not delivered" — see src/model/containerDelivery.js.
  const DELIVERED = {
    received: (x) => `RECEIVED ${d(x.on)}   (${x.evidence.kind})`,
    delivered: (x) => `ON OUR FLOOR ${d(x.on)}   (${x.evidence.kind}${x.by ? ' — ' + x.by : ''})`,
    unknown: () => '— not known',
  }
  console.log(`  delivered       ${DELIVERED[del.state](del)}`)
  console.log(`                  ${del.why}`)
  if (del.state === 'received' && del.enteredOn && del.enteredOn !== del.on) {
    console.log(`                  on the floor ${d(del.enteredOn)} — ${Math.round((new Date(del.on) - new Date(del.enteredOn)) / 864e5)}d before NetSuite knew`)
  }
  if (win) console.log(`  unusable        ${win.days}d  ${win.fulfilledOn} → ${win.receivedOn}  (${win.label})`)
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
//
// ⚠️ AND NOW WE CAN SAY WHETHER THEY ARE STILL COMING. Until the receipt dates existed
// this was a list of six unexplained gaps that read like a backlog. Every one of them is
// RECEIVED — historical containers whose paperwork we never imported, not freight
// anybody is waiting on. That is a materially different sentence and the reason the
// state is printed per row rather than left to be assumed.
const { rows: orphans } = await pool.query(
  `SELECT memo, count(*) tos, sum(units)::int units, min(trandate) first_seen,
          count(*) FILTER (WHERE received_on IS NOT NULL) received,
          max(received_on) received_on, min(fulfilled_on) fulfilled_on
     FROM container_transfer
    WHERE container_label IS NULL AND memo ~ '[0-9]{4}\\.[0-9]{1,2}\\.[0-9]{1,2}\\s*$'
    GROUP BY memo ORDER BY min(trandate)`)
if (orphans.length) {
  console.log(`\n${'─'.repeat(74)}`)
  console.log(`CONTAINERS IN NETSUITE WITH NO PACKING SLIP IMPORTED — ${orphans.length}`)
  for (const o of orphans) {
    // ⚠️ THREE OUTCOMES, NOT TWO. "some received" is its own row and must never round to
    // either neighbour — it is the only one of the three that is unfinished work.
    // ⚠️ Number() ON BOTH SIDES. pg hands back count(*) as a STRING (bigint has no safe
    // JS number), so `o.received === Number(o.tos)` compared '6' to 6 and was false for
    // every row — the "all received" branch was unreachable and this printed "⚠ 6 of
    // them still have transfer orders to receive" about six containers that landed in
    // May. Shape 1 in CLAUDE.md, in the first run of the code that reports it.
    const done = Number(o.received) === Number(o.tos)
    const state = done ? `received ${String(o.received_on).slice(0, 10)}`
      : Number(o.received) > 0 ? `⚠ ${o.received}/${o.tos} received`
        : 'no receipt'
    const days = done && o.fulfilled_on
      ? `  ${Math.round((new Date(o.received_on) - new Date(o.fulfilled_on)) / 864e5)}d unusable` : ''
    console.log(`   ${String(o.memo).padEnd(34)} ${String(o.tos).padStart(2)} TOs · ${String(o.units).padStart(5)} units · ${String(o.first_seen).slice(0, 10)}  ${state}${days}`)
  }
  const open = orphans.filter((o) => Number(o.received) !== Number(o.tos))
  console.log(`   Their transfer orders are recorded; their cartons, SKUs and POs are not.`)
  console.log(open.length
    ? `   ⚠ ${open.length} of them still have transfer orders to receive.`
    : `   None is outstanding — all ${orphans.length} landed and were received. Missing paperwork, not missing freight.`)
}
await pool.end()
