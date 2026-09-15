// test/exemplarStandards.test.js — the Manual, priced, against the live shipment.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEES, feeFor, shipmentChecklist, AUDIT, CARTON, PALLET,
  RECEIVED_NOT_ORDERED, SOURCE,
} from '../src/model/exemplarStandards.js'
import { macysShipmentChecklist, offsetFor, PORTAL as MACYS_PORTAL, PAGES as MACYS_PAGES } from '../src/model/macysStandards.js'

test('⚠️ THE MINIMUM CHARGE IS THE REAL NUMBER, not the per-carton amount', () => {
  // Almost every carton violation reads "$10.00 per carton, $250.00 minimum".
  // Reading the left column alone understates one mislabelled carton by 25x.
  assert.equal(feeFor('storeMissing', { cartons: 1 }).estimate, 250)
  assert.equal(feeFor('storeMissing', { cartons: 25 }).estimate, 250)
  // Only above the floor does the per-carton rate start to matter.
  assert.equal(feeFor('storeMissing', { cartons: 40 }).estimate, 400)
})

test('⚠️ SHORT AND OVER SHIPPING SAY "EDI/NON-EDI" — being non-EDI is no shelter', () => {
  assert.match(FEES.shortShipped.what, /EDI\/NON-EDI/)
  assert.match(FEES.overShipped.what, /EDI\/NON-EDI/)
  assert.equal(feeFor('shortShipped', { pos: 1 }).estimate, 500)
})

test('the expensive transportation fees are the ones with no carton divisor', () => {
  assert.equal(feeFor('notBookedInTms', { pos: 1 }).estimate, 300)
  assert.equal(feeFor('notBookedInTms', { pos: 24 }).estimate, 7200, 'per PO, and PO 1236143 is 24 orders')
  assert.equal(feeFor('noBolToCarrier').estimate, 250)
  assert.equal(feeFor('missingBoltSeal').estimate, 200)
  // A formula fee has no number, and says so rather than guessing one.
  assert.equal(feeFor('multipleBols').estimate, null)
  assert.match(feeFor('multipleBols').note, /cost of freight \+ \$75/)
})

test('⚠️ THE AUDIT PROGRAMME IS ASSESSED MONTHLY — the open question, answered', () => {
  // I could not tell from the screenshots whether 2% was per PO or per month. The
  // Manual says "Calculations are performed monthly", so one bad shipment does not
  // place you on its own — though every PO is still audited.
  assert.equal(AUDIT.cadence, 'monthly')
  assert.equal(AUDIT.itemErrorRateTrigger, 0.02)
  assert.equal(AUDIT.feePerMonth, 1000)
  assert.equal(AUDIT.minimumMonths, 3)
  assert.match(AUDIT.exit, /three consecutive/)
  // And the audited document is the packing slip when there is no ASN.
  assert.match(AUDIT.auditedAgainst, /packing slip data OR the ASN/)
})

test('⚠️ A RETRANSMITTED PO IS THE CONFIRMATION OF A CHANGE, per §9.2', () => {
  // Bloomingdale's sent PO 1236143 a second time coded 07 Duplicate while removing
  // three SKUs. The Manual puts the retransmission on THEM as the confirmation.
  assert.equal(RECEIVED_NOT_ORDERED.retransmissionIsConfirmation, true)
  assert.match(RECEIVED_NOT_ORDERED.noSubstitutions, /Do not substitute/)
  assert.match(RECEIVED_NOT_ORDERED.consequence, /keep the units/)
})

test('the checklist is ordered by when it has to be true, not by section number', () => {
  const c = shipmentChecklist({ asnWillBeSent: false, cartons: 11, pos: 1 })
  const phases = [...new Set(c.steps.map((s) => s.phase))]
  // Route before pack (the TMS decides the mode); label before pallet (you cannot
  // reach a carton label through three turns of shrink wrap).
  assert.deepEqual(phases, ['before', 'route', 'pack', 'label', 'documents', 'pallet', 'after'])
  assert.ok(phases.indexOf('route') < phases.indexOf('pack'))
  assert.ok(phases.indexOf('label') < phases.indexOf('pallet'))
})

test('⚠️ NON-EDI GETS THE PACKING SLIP STEP; EDI GETS THE ASN STEP', () => {
  const nonEdi = shipmentChecklist({ asnWillBeSent: false })
  const edi = shipmentChecklist({ asnWillBeSent: true })

  const ps = nonEdi.steps.find((s) => /Packing slip per PO/.test(s.what))
  assert.ok(ps, 'non-EDI must be told about the packing slip')
  assert.match(ps.detail, /all six sides/)
  assert.match(ps.detail, /UNSIGNED BOL/)
  assert.equal(ps.fee.cost, '$250')

  assert.ok(edi.steps.find((s) => /Transmit the 856/.test(s.what)))
  assert.ok(!edi.steps.find((s) => /Packing slip per PO/.test(s.what)))

  // Everything else is identical — EDI status changes one line, not the process.
  assert.equal(nonEdi.steps.length, edi.steps.length)
})

test('the bolt seal step appears only for a full truckload', () => {
  assert.ok(!shipmentChecklist({ mode: 'parcel' }).steps.find((s) => /bolt seal/i.test(s.what)))
  assert.ok(shipmentChecklist({ mode: 'TL' }).steps.find((s) => /bolt seal/i.test(s.what)))
})

test('direct-to-store adds its authorization step, and it is per PO one time only', () => {
  const dts = shipmentChecklist({ dts: true })
  const step = dts.steps.find((s) => /Direct-to-Door/.test(s.what))
  assert.ok(step)
  assert.match(step.detail, /ONE TIME, never reused/)
  assert.match(step.detail, /carton labels AND the BOL/)
})

test('every step that cites a fee resolves to a real fee line', () => {
  // ⚠️ A checklist step pointing at a fee key that does not exist would print an
  // empty cost and read as "free".
  for (const s of shipmentChecklist({ cartons: 5 }).steps) {
    if (!s.fee) continue
    assert.ok(s.fee.section, `${s.what} has a fee with no section`)
    assert.ok(s.fee.cost, `${s.what} has a fee with no cost`)
  }
})

test('the specs match the Manual, not memory', () => {
  assert.deepEqual(CARTON.weightLb, [5, 50])
  assert.deepEqual(CARTON.lengthIn, [9, 36])
  assert.equal(CARTON.recycledAllowed, false)
  assert.deepEqual(PALLET.sizeIn, [48, 40])
  assert.equal(PALLET.type, '4-way')
  assert.equal(PALLET.maxHeightIn, 72)
  assert.equal(PALLET.shrinkWrapTurns, 3)
  assert.equal(PALLET.wrapIndividually, false)
  assert.equal(SOURCE.formerly, 'Saks Global')
  assert.equal(SOURCE.edition, 'August 2026')
})

// ── The checklist is ticked off and stored, so its keys are a contract ──────

test('⚠️ EVERY STEP HAS A UNIQUE KEY — a tick is stored against it, not against the wording', () => {
  for (const opts of [
    {}, { dts: true }, { mode: 'TL' }, { asnWillBeSent: true },
    { dts: true, mode: 'TL', asnWillBeSent: true },
  ]) {
    const keys = shipmentChecklist(opts).steps.map((s) => s.key)
    assert.ok(keys.every(Boolean), `a step has no key under ${JSON.stringify(opts)}`)
    assert.equal(new Set(keys).size, keys.length, `duplicate key under ${JSON.stringify(opts)}`)
  }
})

test('the ASN step and the packing-slip step are DIFFERENT keys, because they are alternatives', () => {
  // Sharing a key would carry a tick for "ASN transmitted" across to "packing slip
  // attached" the moment the EDI lane was switched on — two different physical acts.
  const edi = shipmentChecklist({ asnWillBeSent: true }).steps.map((s) => s.key)
  const non = shipmentChecklist({ asnWillBeSent: false }).steps.map((s) => s.key)
  assert.ok(edi.includes('asn-856') && !edi.includes('packing-slip'))
  assert.ok(non.includes('packing-slip') && !non.includes('asn-856'))
})

test('a conditional step appears only when it applies, and keeps its key when it does', () => {
  assert.ok(!shipmentChecklist({}).steps.some((s) => s.key === 'dts-auth'))
  assert.ok(shipmentChecklist({ dts: true }).steps.some((s) => s.key === 'dts-auth'))
  assert.ok(!shipmentChecklist({}).steps.some((s) => s.key === 'bolt-seal'))
  assert.ok(shipmentChecklist({ mode: 'TL' }).steps.some((s) => s.key === 'bolt-seal'))
})

// ── The Macy's / Bloomingdale's checklist ──────────────────────────────────

test('⚠️ THE TWO CHECKLISTS CANNOT CROSS-TICK', () => {
  // `gs1-placement` is a natural name for a step in BOTH — Exemplar's is §12.1 at
  // $10/carton with a $250 minimum, Macy's is Appendix H at $5/carton with a $50
  // minimum. Different requirements, different money. preship_check rows are keyed on
  // the step alone, so the Macy's keys are namespaced rather than left merely unlikely
  // to collide.
  const ex = new Set([{}, { dts: true }, { mode: 'TL' }, { asnWillBeSent: true }]
    .flatMap((o) => shipmentChecklist(o).steps.map((s) => s.key)))
  const my = new Set([{ asnWillBeSent: true }, { asnWillBeSent: false }]
    .flatMap((o) => macysShipmentChecklist(o).steps.map((s) => s.key)))
  assert.equal([...my].filter((k) => ex.has(k)).length, 0)
  assert.ok([...my].every((k) => k.startsWith('macys:')))
})

test('⚠️ IT NAMES WHAT IT HAS NOT READ', () => {
  // Three of the four Macy's-side documents in partnerDocuments are rulesIn: null. A
  // checklist that does not say so reads as complete, and this one is deliberately not
  // the equal of Exemplar's.
  const c = macysShipmentChecklist({})
  // ⚠️ WAS THREE, NOW ONE. The Macy's Routing Guide (macysRouting.js) and the
  // Store-to-DC listing (macysStores.js) were both read on 2026-09-15; only the
  // Bloomingdale's-specific routing guide is left. The COUNT is asserted rather than the
  // mere presence of a list, so closing a gap has to be reflected here and a stale
  // "unread" cannot linger.
  assert.equal(c.notCovered.length, 1)
  assert.ok(c.notCovered.some((n) => /ticketing, hanger and RFID/.test(n)))
  assert.ok(!c.notCovered.some((n) => /Macy's Routing Guide/.test(n)))
  assert.match(c.caveat, /Confirm the edition/)
})

test('⚠️ THE SHORTAGE LINE IS MARKED AS THE EXPENSIVE ONE', () => {
  // It is a receipt fee PLUS half the merchandise. On a wholesale handbag order the
  // percentage is nearly the whole exposure, and it must not look like the $5 lines.
  const c = macysShipmentChecklist({})
  const short = c.steps.find((s) => s.key === 'macys:ship-what-the-po-says')
  assert.equal(short.theExpensiveOne, true)
  assert.equal(short.offset.key, 'poNoncompliance')
})

test('⚠️ AND WITHOUT A MERCHANDISE VALUE IT REFUSES TO ESTIMATE', () => {
  // The flat part alone is not the exposure — quoting $150 for something that is $4,140
  // is worse than saying the number is not known.
  const c = macysShipmentChecklist({ receipts: 3 })
  const short = c.steps.find((s) => s.key === 'macys:ship-what-the-po-says')
  assert.match(short.offset.cost, /not supplied|%/)
})

test('⚠️ COLLATERAL WAS STORED AND NEVER ADDED — every shortage came out $1/unit short', () => {
  // p58: "$50.00 per receipt and 50% cost of merchandise; $1.00 per unit for collateral".
  // `perUnitCollateral` was in OFFSETS from the transcription and offsetFor never looked
  // at it, so the live Bloomingdale's cut quoted $4,140 instead of $4,210 — a number
  // used to decide whether to ship. A field the calculator ignores is worse than one
  // never extracted: it reads as covered.
  const r = offsetFor('poNoncompliance', { receipts: 3, units: 70, merchandiseUsd: 7980 })
  assert.equal(r.estimate, 4210)
  assert.ok(r.parts.some((p) => /collateral/.test(p)))
})

test('⚠️ "AND FREIGHT" IS UNBOUNDED AND DOES NOT ROUND TO ZERO', () => {
  // Wrong-location merchandise is $250/receipt AND $10/carton AND the freight. The
  // freight is usually the larger half and cannot be known here, so it is reported as
  // an unknown add-on rather than omitted from a total that then looks complete.
  const r = offsetFor('wrongLocation', { receipts: 1, cartons: 22 })
  assert.equal(r.estimate, 470)
  assert.match(r.unknown, /freight cost itself/)
})

test('the short-ship rule cites its page, not just its appendix', () => {
  assert.equal(offsetFor('poNoncompliance', {}).page, 58)
  assert.equal(MACYS_PAGES.shortShip, 58)
})
