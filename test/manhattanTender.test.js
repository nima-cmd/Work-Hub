// Nordstrom's Manhattan Active TMS tender emails — the accepted pickup datetime, the
// carrier, and one SRR per DC. The bodies below are the real shapes from the mailbox,
// trimmed to the fields the parser reads.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTenderEmail, parsePickup, parseSpo, normalizeDc, pickupLocalYmd,
  reconcileTender, summarizeTenderDiffs, matchStop, planTenderApply, SRR_PAIRING, TENDER_DIFF,
} from '../src/model/manhattanTender.js'

// The live 2026-08-06 tender, verbatim in structure. 9 SRRs, 9 SPOs, 9 DCs.
const S190212 = {
  subject: 'Tender Accepted for Shipment S000190212',
  receivedAt: '2026-08-06T20:26:53Z',
  messageId: '19fd8c1e5ae1df08',
  body: `<div><b>ShipmentId :</b> S000190212 </div>
    <p><b> Planned Time of 1st Stop:</b> 10 August 2026 08:00:00 PDT</p>
    <div><b>SRR :</b> [5189002RR000000053, 5189002RR000000054, 5189002RR000000055, 5189002RR000000056, 5189002RR000000057, 5189002RR000000058, 5189002RR000000059, 5189002RR000000060, 5189002RR000000061]</div>
    <div><b>SRR cont1 :</b> []</div>
    <div><b>SPO :</b> [50073685-569, 50073685-584, 50073685-599, 50073677-299, 50073677-399, 50073677-499, 50073677-699, 50073677-799, 50073677-89]</div>
    <div><b>SPO cont1 :</b> []</div>
    <div><b>Origin Details :</b> FacilityId : EXT2082, City : Glendale, State : CA </div>
    <div><b>Destination Details :</b> FacilityId : CTE, City : South Gate, State : CA</div>
    <div><b>Carrier :</b> CTE Carrier  </div>
    <div><b>Total Dimensions :</b> Total Volume : 129.000000000 cuft, Total Weight : 1287.000000000 lb, Total Pallet : 0.0000, Total Carton : 42.0000</div>`,
}

// ⚠️ THE ONE THAT DISPROVES POSITIONAL PAIRING: 9 SRRs, 24 SPOs, 9 DCs, and six of the
// SPOs live in the `cont1` overflow field.
const S137008 = {
  subject: 'Tender Accepted for Shipment S000137008',
  receivedAt: '2026-05-26T16:48:17Z',
  body: `<div><b>ShipmentId :</b> S000137008 </div>
    <p><b> Planned Time of 1st Stop:</b> 27 May 2026 13:00:00 PDT</p>
    <div><b>SRR :</b> [5189002RR000000031, 5189002RR000000032, 5189002RR000000033, 5189002RR000000034, 5189002RR000000035, 5189002RR000000036, 5189002RR000000037, 5189002RR000000038, 5189002RR000000039]</div>
    <div><b>SPO :</b> [40847682-89, 40856265-89, 40856282-89, 40856265-299, 40856282-299, 40847682-299, 40856265-399, 40856282-399, 40847682-399, 40856265-499, 40856282-499, 40847682-499, 40856282-699, 40856265-699, 40847682-699, 40856265-799, 40856282-799, 40847682-799]</div>
    <div><b>SPO cont1 :</b> [40856283-569, 40856257-569, 40856283-584, 40856257-584, 40856283-599, 40856257-599]</div>
    <div><b>Origin Details :</b> FacilityId : EXT2082, City : Glendale, State : CA </div>
    <div><b>Destination Details :</b> FacilityId : CTE, City : South Gate, State : CA</div>
    <div><b>Carrier :</b> CTE Carrier  </div>
    <div><b>Total Dimensions :</b> Total Volume : 356.000000000 cuft, Total Weight : 3026.000000000 lb, Total Pallet : 0.0000, Total Carton : 117.0000</div>`,
}

test('parses the shipment-level facts', () => {
  const t = parseTenderEmail(S190212)
  assert.equal(t.shipmentId, 'S000190212')
  assert.equal(t.carrier, 'CTE Carrier')
  assert.equal(t.totalCartons, 42)
  assert.equal(t.totalWeightLb, 1287)
  assert.equal(t.totalVolumeCuft, 129)
  assert.equal(t.originFacility, 'EXT2082')
  assert.equal(t.originCity, 'Glendale')
  assert.equal(t.destCity, 'South Gate')
  // 08:00 PDT is 15:00Z the same day.
  assert.equal(t.pickupAt.toISOString(), '2026-08-10T15:00:00.000Z')
})

test('SRR pairs to the DC in first-appearance order — matches Nima\'s hand entry 9 for 9', () => {
  // Ground truth: these nine pairings were already in routing_shipment, keyed by hand,
  // before the parser existed. This asserts the parser reproduces them exactly.
  const t = parseTenderEmail(S190212)
  assert.equal(t.srrPairing, SRR_PAIRING.BY_DC_ORDER)
  assert.deepEqual(
    t.stops.map((s) => [s.dc, s.srr]),
    [
      ['569', '5189002RR000000053'], ['584', '5189002RR000000054'], ['599', '5189002RR000000055'],
      ['299', '5189002RR000000056'], ['399', '5189002RR000000057'], ['499', '5189002RR000000058'],
      ['699', '5189002RR000000059'], ['799', '5189002RR000000060'], ['89', '5189002RR000000061'],
    ],
  )
})

test('⚠️ 9 SRRs against 24 SPOs still resolves to 9 DCs — positional pairing would be wrong', () => {
  const t = parseTenderEmail(S137008)
  assert.equal(t.spoCount, 24, 'the cont1 overflow field must be read')
  assert.equal(t.srrCount, 9)
  assert.equal(t.stops.length, 9)
  assert.equal(t.srrPairing, SRR_PAIRING.BY_DC_ORDER)
  // Position 4 in the SPO list is 40856265-299; pairing by SPO position would have put
  // SRR ...034 on DC 89's third PO. By DC, ...034 belongs to DC 499.
  assert.deepEqual(t.stops.map((s) => s.dc), ['89', '299', '399', '499', '699', '799', '569', '584', '599'])
  assert.equal(t.stops.find((s) => s.dc === '89').srr, '5189002RR000000031')
  // A DC that several POs ship through keeps all of them.
  assert.deepEqual(t.stops.find((s) => s.dc === '89').poNumbers, ['40847682', '40856265', '40856282'])
  assert.deepEqual(t.stops.find((s) => s.dc === '569').poNumbers, ['40856283', '40856257'])
})

test('⚠️ when SRR and DC counts disagree, NOTHING is paired', () => {
  // An SRR on the wrong DC is worse than a missing one — it is a number Nima would
  // confidently type into the portal.
  const t = parseTenderEmail({
    ...S190212,
    body: S190212.body.replace(/, 5189002RR000000061\]/, ']'), // 8 SRRs, still 9 DCs
  })
  assert.equal(t.srrCount, 8)
  assert.equal(t.stops.length, 9)
  assert.equal(t.srrPairing, SRR_PAIRING.COUNT_MISMATCH)
  assert.ok(t.stops.every((s) => s.srr === null))
})

test('a tender with no SRR list is NO_SRR, not a mismatch', () => {
  const t = parseTenderEmail({ ...S190212, body: S190212.body.replace(/<div><b>SRR :<\/b>[^<]*<\/div>/, '') })
  assert.equal(t.srrPairing, SRR_PAIRING.NO_SRR)
})

test('⚠️ the leading-zero join trap: the email says 89, our DC is 089', () => {
  assert.equal(normalizeDc('89'), '89')
  assert.equal(normalizeDc('089'), '89')
  assert.equal(normalizeDc('0089'), '89')
  assert.equal(normalizeDc('SC'), 'SC') // a non-numeric DC is left alone
  assert.equal(normalizeDc(''), null)
  assert.equal(normalizeDc(null), null)
})

test('parseSpo splits on the last hyphen', () => {
  assert.deepEqual(parseSpo('50073677-89'), { po: '50073677', dc: '89' })
  assert.deepEqual(parseSpo('PO-123-569'), { po: 'PO-123', dc: '569' })
  assert.equal(parseSpo('nohyphen'), null)
  assert.equal(parseSpo('-569'), null)
  assert.equal(parseSpo('50073677-'), null)
})

test('an unmapped timezone returns null rather than guessing the zone', () => {
  assert.equal(parsePickup('10 August 2026 08:00:00 PDT').toISOString(), '2026-08-10T15:00:00.000Z')
  assert.equal(parsePickup('10 January 2026 08:00:00 PST').toISOString(), '2026-01-10T16:00:00.000Z')
  assert.equal(parsePickup('10 August 2026 08:00:00 EDT'), null)
  assert.equal(parsePickup('not a date'), null)
  assert.equal(parsePickup(null), null)
})

test('⚠️ the pickup date compared is the CARRIER\'s local date, not the UTC one', () => {
  // A 17:00 PDT pickup is the next day in UTC. Comparing UTC dates would invent a
  // one-day disagreement on every late-afternoon tender.
  const t = parseTenderEmail({ ...S190212, body: S190212.body.replace('08:00:00 PDT', '17:00:00 PDT') })
  assert.equal(t.pickupAt.toISOString(), '2026-08-11T00:00:00.000Z')
  assert.equal(pickupLocalYmd(t), '2026-08-10')
})

test('junk in the mailbox parses to null, it does not throw', () => {
  assert.equal(parseTenderEmail({ subject: 'Set Password', body: '<p>hello</p>' }), null)
  assert.equal(parseTenderEmail({}), null)
})

// ── reconciliation ────────────────────────────────────────────────────────────

// The nine live rows as they stand today: SRRs keyed by hand, carrier null, and a
// ship_date of 2026-08-05 against an accepted pickup of 2026-08-10.
const LIVE_ROWS = [
  { id: 14, dc: '569', cartons: 8, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000053', bolNumber: 'NB1731246', memberPos: ['50073685'] },
  { id: 15, dc: '584', cartons: 6, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000054', bolNumber: 'NB1731247', memberPos: ['50073685'] },
  { id: 16, dc: '599', cartons: 3, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000055', bolNumber: 'NB1731248', memberPos: ['50073685'] },
  { id: 17, dc: '299', cartons: 2, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000056', bolNumber: 'NB1731249', memberPos: ['50073677'] },
  { id: 18, dc: '399', cartons: 6, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000057', bolNumber: 'NB1731250', memberPos: ['50073677'] },
  { id: 19, dc: '499', cartons: 3, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000058', bolNumber: 'NB1731251', memberPos: ['50073677'] },
  { id: 20, dc: '699', cartons: 6, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000059', bolNumber: 'NB1731252', memberPos: ['50073677'] },
  { id: 21, dc: '799', cartons: 7, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000060', bolNumber: 'NB1731253', memberPos: ['50073677'] },
  // ⚠️ ours is '089', the tender says '89'.
  { id: 22, dc: '089', cartons: 1, shipDate: '2026-08-05', carrier: null, routingRequestNumber: '5189002RR000000061', bolNumber: 'NB1731254', memberPos: ['50073677'] },
]

test('the live shape: all 9 stops match, 42 cartons reconcile, SRRs already agree', () => {
  const r = reconcileTender(parseTenderEmail(S190212), LIVE_ROWS)
  assert.equal(r.matched, 9, 'the 089/89 stop must match, not fall out')
  assert.equal(r.ourCartons, 42)
  assert.equal(r.theirCartons, 42)
  assert.equal(r.cartonsAgree, true)
  // The SRRs Nima keyed are the tender's — so this raises no SRR difference at all.
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.SRR).length, 0)
  // What IS wrong: every row's date and every row's missing carrier.
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.PICKUP_DATE).length, 9)
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.CARRIER).length, 9)
  const d = r.diffs.find((x) => x.kind === TENDER_DIFF.PICKUP_DATE)
  assert.equal(d.ours, '2026-08-05')
  assert.equal(d.theirs, '2026-08-10')
})

test('a stop with no routing shipment is named, and suppresses the carton checksum', () => {
  const r = reconcileTender(parseTenderEmail(S190212), LIVE_ROWS.slice(0, 8))
  assert.equal(r.matched, 8)
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.NO_SHIPMENT).length, 1)
  // ⚠️ 41 vs 42 is arithmetic, not a discrepancy — a partial match undercounts by
  // construction, so the checksum must go quiet rather than report a phantom.
  assert.equal(r.cartonsAgree, null)
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.CARTONS).length, 0)
})

test('a real carton disagreement IS reported when every stop matched', () => {
  const rows = LIVE_ROWS.map((r) => (r.dc === '569' ? { ...r, cartons: 5 } : r))
  const r = reconcileTender(parseTenderEmail(S190212), rows)
  assert.equal(r.matched, 9)
  assert.equal(r.cartonsAgree, false)
  assert.equal(r.diffs.find((d) => d.kind === TENDER_DIFF.CARTONS).ours, 39)
})

test('reconcile never returns a corrected row — only differences', () => {
  const r = reconcileTender(parseTenderEmail(S190212), LIVE_ROWS)
  // Hand-entered fields are Nima's; the tender is evidence, not an overwrite.
  assert.ok(!('apply' in r) && !('updates' in r))
  assert.ok(r.diffs.every((d) => 'ours' in d || d.kind === TENDER_DIFF.NO_SHIPMENT))
})

test('an agreeing shipment raises nothing', () => {
  const rows = LIVE_ROWS.map((r) => ({ ...r, shipDate: '2026-08-10', carrier: 'CTE Carrier' }))
  const r = reconcileTender(parseTenderEmail(S190212), rows)
  assert.deepEqual(r.diffs, [])
  assert.equal(r.cartonsAgree, true)
})

test('summarize counts each fact separately, never lumped', () => {
  const s = summarizeTenderDiffs([reconcileTender(parseTenderEmail(S190212), LIVE_ROWS)])
  assert.deepEqual(s, {
    tenders: 1, outOfScope: 0, reconciled: 1,
    pickupDate: 9, carrier: 9, srr: 0, noShipment: 0, cartons: 0,
  })
})

test('⚠️ the DC alone is NOT a key — a historical tender must not match today\'s rows', () => {
  // DC 569/584/599 are on the June tender AND on today's. Matching on DC alone would
  // report a pickup-date disagreement for a truck that already came and went in June.
  const june = parseTenderEmail({
    subject: 'Tender Accepted for Shipment S000145602',
    receivedAt: '2026-06-03T20:44:18Z',
    body: `<div><b>ShipmentId :</b> S000145602 </div>
      <p><b> Planned Time of 1st Stop:</b> 4 June 2026 08:00:00 PDT</p>
      <div><b>SRR :</b> [5189002RR000000040, 5189002RR000000041, 5189002RR000000042]</div>
      <div><b>SPO :</b> [50125052-599, 50125052-584, 50125052-569]</div>
      <div><b>Carrier :</b> CTE Carrier  </div>
      <div><b>Total Dimensions :</b> Total Carton : 34.0000</div>`,
  })
  assert.deepEqual(june.stops.map((s) => s.dc), ['599', '584', '569'])
  const r = reconcileTender(june, LIVE_ROWS)
  assert.equal(r.matched, 0, 'PO 50125052 is on none of our rows')
  assert.equal(r.outOfScope, true)
  assert.deepEqual(r.diffs, [], 'an out-of-scope tender raises NOTHING, not 3 NO_SHIPMENT rows')
})

test('matchStop needs the DC and an overlapping PO', () => {
  const ships = [
    { id: 14, dc: '569', memberPos: ['50073685'] },
    { id: 99, dc: '569', memberPos: ['50125052'] },
  ]
  assert.equal(matchStop({ dc: '569', poNumbers: ['50073685'] }, ships).id, 14)
  assert.equal(matchStop({ dc: '569', poNumbers: ['50125052'] }, ships).id, 99)
  assert.equal(matchStop({ dc: '569', poNumbers: ['99999999'] }, ships), null)
  assert.equal(matchStop({ dc: '777', poNumbers: ['50073685'] }, ships), null)
  // A row with no PO list can't be ruled out — matched rather than silently dropped.
  assert.equal(matchStop({ dc: '569', poNumbers: ['x'] }, [{ id: 7, dc: '569' }]).id, 7)
})

test('a PARTIAL match still names the missing stops', () => {
  // Some DCs known, some not — that IS a real gap, unlike a wholly historical tender.
  const r = reconcileTender(parseTenderEmail(S190212), LIVE_ROWS.slice(0, 3))
  assert.equal(r.matched, 3)
  assert.equal(r.outOfScope, false)
  assert.equal(r.diffs.filter((d) => d.kind === TENDER_DIFF.NO_SHIPMENT).length, 6)
})

// ── planTenderApply — the click, not the cron ─────────────────────────────────

test('accepting the tender rewrites the date and fills the carrier', () => {
  const p = planTenderApply(parseTenderEmail(S190212), LIVE_ROWS)
  assert.equal(p.outOfScope, false)
  assert.equal(p.shipments, 9, 'all nine BOLs in one press')
  assert.equal(p.changes, 18, 'a date and a carrier each')
  assert.equal(p.conflicts, 0)
  assert.equal(p.pickupDate, '2026-08-10')
  const e = p.edits.find((x) => x.dc === '89')
  assert.deepEqual(e.set, { shipDate: '2026-08-10', carrier: 'CTE Carrier' })
  assert.equal(e.bolNumber, 'NB1731254')
})

test('⚠️ a hand-keyed SRR is NEVER overwritten — a disagreement stays visible', () => {
  const rows = LIVE_ROWS.map((r) => (r.dc === '569' ? { ...r, routingRequestNumber: '5189002RR000000099' } : r))
  const p = planTenderApply(parseTenderEmail(S190212), rows)
  const e = p.edits.find((x) => x.dc === '569')
  assert.ok(!('routingRequestNumber' in e.set), 'his number stands')
  assert.deepEqual(e.kept, [{ field: 'routingRequestNumber', ours: '5189002RR000000099', theirs: '5189002RR000000053' }])
  assert.equal(p.conflicts, 1)
})

test('an EMPTY SRR is filled', () => {
  const rows = LIVE_ROWS.map((r) => ({ ...r, routingRequestNumber: null }))
  const p = planTenderApply(parseTenderEmail(S190212), rows)
  assert.equal(p.edits.find((x) => x.dc === '89').set.routingRequestNumber, '5189002RR000000061')
  assert.equal(p.conflicts, 0)
})

test('applying an already-applied tender plans nothing — the button goes quiet', () => {
  const rows = LIVE_ROWS.map((r) => ({ ...r, shipDate: '2026-08-10', carrier: 'CTE Carrier' }))
  const p = planTenderApply(parseTenderEmail(S190212), rows)
  assert.deepEqual(p.edits, [])
  assert.equal(p.changes, 0)
})

test('a historical tender plans nothing at all', () => {
  const june = parseTenderEmail({
    subject: 'Tender Accepted for Shipment S000145602', receivedAt: '2026-06-03T20:44:18Z',
    body: `<div><b>ShipmentId :</b> S000145602 </div>
      <p><b> Planned Time of 1st Stop:</b> 4 June 2026 08:00:00 PDT</p>
      <div><b>SRR :</b> [5189002RR000000040, 5189002RR000000041, 5189002RR000000042]</div>
      <div><b>SPO :</b> [50125052-599, 50125052-584, 50125052-569]</div>
      <div><b>Carrier :</b> CTE Carrier  </div>`,
  })
  const p = planTenderApply(june, LIVE_ROWS)
  assert.equal(p.outOfScope, true)
  assert.deepEqual(p.edits, [])
})
