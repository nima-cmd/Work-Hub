import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRoutingNotification, parseCarrier, parseConsignee, parseMacysDate,
  projectsReconcile, planRoutingApply, summarizeRoutingMisses, PAIRING, MISS,
} from '../src/model/macysRouting.js'

// Shaped from the real 2026-08-13 notification (project 9022514 / shipment 52172263),
// trimmed to the parts that carry data plus enough boilerplate to prove the parser
// stops at the right boundary. The tail deliberately repeats the words "Carrier" and
// "Project" — that page of standing instructions is why the body is bounded.
const BODY = `<style>.carrier { color: red }</style>
<div>The following project has been authorized for shipping.</div>
<div><b>Appointment #:</b> N/A</div>
<div><b>Trip ID / Authorization #:</b> 00052850382S</div>
<div><b>Carrier:</b> UPS GRND - BILL TO ACCT#5R12Y0 (UPSN)</div>
<div><b>Carrier Mode:</b> SMALL PACKAGE</div>
<div><b>Phone:</b> (111)111-1111X3176</div>
<div><b>Pickup Date:</b> 08/18/2026</div>
<div><b>Delivery Date :</b> 08/19/2026</div>
<div><b>Appointment Type :</b> Drop</div>
<div>Reminder: All Truckload and Intermodal trailers are required to use bolt seals.</div>
<div>BILLS OF LADING</div>
<div>Project Number(s) 9022514 containing Shipment(s) 52172263 - Consigned to: SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094</div>
<div>If you have received a notification email with the carrier field showing as
follows: ERROR Carrier: Project Number(s) 999 containing Shipment(s) 888</div>`

const SUBJECT = "Macy's, Inc. Routing Notification (Project(s) 9022514)"

const parse = (over = {}) => parseRoutingNotification({
  subject: SUBJECT, body: BODY, receivedAt: '2026-08-13T14:00:20Z', messageId: 'm1', ...over,
})

test('parses every field off a real notification', () => {
  const n = parse()
  assert.equal(n.authNumber, '00052850382S')
  assert.equal(n.appointmentNumber, null) // 'N/A' is not a number
  assert.equal(n.carrier, 'UPS GRND')
  assert.equal(n.scac, 'UPSN')
  assert.equal(n.billToAccount, '5R12Y0')
  assert.equal(n.carrierMode, 'SMALL PACKAGE')
  assert.equal(n.pickupDate, '2026-08-18')
  assert.equal(n.deliveryDate, '2026-08-19')
  assert.equal(n.appointmentType, 'Drop')
  assert.equal(n.pairing, PAIRING.ONE_TO_ONE)
  assert.deepEqual(n.subjectProjects, ['9022514'])
})

// The boilerplate below the data repeats "Project Number(s) 999 containing
// Shipment(s) 888" as an example. Reading it would authorize a shipment that does
// not exist.
test('stops at the end of the BILLS OF LADING section', () => {
  const n = parse()
  assert.equal(n.stops.length, 1)
  assert.equal(n.stops[0].projectNumber, '9022514')
  assert.equal(n.stops[0].shipmentNumber, '52172263')
  assert.equal(n.stops[0].shipDirect, true)
  assert.equal(n.stops[0].dcName, 'SECAUCUS')
})

test('a body with no authorization number is not a notification', () => {
  assert.equal(parseRoutingNotification({ subject: SUBJECT, body: '<div>hello</div>' }), null)
})

test('the subject is the body\'s checksum', () => {
  assert.equal(projectsReconcile(parse()), true)
  const wrong = parse({ subject: "Routing Notification (Project(s) 9022514,9099999)" })
  assert.equal(projectsReconcile(wrong), false)
})

test('carrier: the stored short name, the SCAC, and the third-party account', () => {
  assert.deepEqual(parseCarrier('UPS GRND - BILL TO ACCT#5R12Y0 (UPSN)'),
    { name: 'UPS GRND', scac: 'UPSN', billToAccount: '5R12Y0', raw: 'UPS GRND - BILL TO ACCT#5R12Y0 (UPSN)' })
  // No space before the hyphen — the shape that would defeat a ' - ' split.
  assert.equal(parseCarrier('FEDEX GROUND- PARCEL-COLLECT (FDEG)').name, 'FEDEX GROUND')
  assert.equal(parseCarrier('FEDEX GROUND- PARCEL-COLLECT (FDEG)').scac, 'FDEG')
  assert.equal(parseCarrier('FEDEX ECONOMY - LTL (FXNL)').name, 'FEDEX ECONOMY')
  assert.equal(parseCarrier('').name, null)
})

test('consignee: direct to the DC, or via a Merge Center', () => {
  const direct = parseConsignee('SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094')
  assert.equal(direct.shipDirect, true)
  assert.equal(direct.mergeCenter, null)
  assert.equal(direct.dcName, 'SECAUCUS')

  const via = parseConsignee('STONE MOUNTAIN (BT) c/o MEGA-MERGE CA 12801 EXCELSIOR DRIVE SANTA FE SPGS , CA 90670')
  assert.equal(via.shipDirect, false)
  assert.equal(via.mergeCenter, 'CA')
  assert.equal(via.dcName, 'STONE MOUNTAIN (BT)')
})

test('a pickup date is a DATE — the time of day is never turned into an instant', () => {
  assert.equal(parseMacysDate('08/04/2026 10:00:00 AM'), '2026-08-04')
  assert.equal(parseMacysDate('08/18/2026'), '2026-08-18')
  assert.equal(parseMacysDate('not a date'), null)
})

// ── the comma-list block, from the real 2026-05-04 notification ───────────────
const listBody = (projects, shipments) => BODY.replace(
  'Project Number(s) 9022514 containing Shipment(s) 52172263 - Consigned to: SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
  `Project Number(s) ${projects} containing Shipment(s) ${shipments} - Consigned to: SECAUCUS c/o MEGA-MERGE CA 12801 EXCELSIOR DRIVE SANTA FE SPGS , CA 90670`,
)

test('equal-length comma lists are zipped by position', () => {
  const n = parse({ body: listBody('8836810,8835718', '51756016,51754370') })
  assert.equal(n.pairing, PAIRING.BY_POSITION)
  assert.deepEqual(n.stops.map((s) => [s.projectNumber, s.shipmentNumber]),
    [['8836810', '51756016'], ['8835718', '51754370']])
})

// ⚠️ The SRR lesson: a reference on the wrong shipment is worse than no reference,
// because it is a number someone types into a portal with confidence.
test('unequal comma lists pair NOTHING and say so', () => {
  const n = parse({ body: listBody('8836810,8835718', '51756016') })
  assert.equal(n.pairing, PAIRING.COUNT_MISMATCH)
  assert.equal(n.stops.length, 1)
  assert.equal(n.stops[0].unpaired, true)
  assert.equal(n.stops[0].projectNumber, null)
  assert.equal(n.stops[0].shipmentNumber, null)

  const { misses, applies } = planRoutingApply(n, [])
  assert.equal(applies.length, 0)
  assert.equal(misses[0].kind, MISS.UNPAIRED)
})

// ── the dual exact key ────────────────────────────────────────────────────────
const card = (over = {}) => ({
  id: 30, partner: "Bloomingdale's", dc: 'SC', bolNumber: 'NB1731263', status: 'needs_routing',
  projectNumber: '9022514', shipmentNumber: '52172263',
  authNumber: null, carrier: null, scac: null, shipDate: '2026-08-12', ...over,
})

test('both keys matching is the only path that writes', () => {
  const plan = planRoutingApply(parse(), [card()])
  assert.equal(plan.matched, 1)
  assert.equal(plan.misses.length, 0)
  assert.deepEqual(plan.applies[0].set, {
    authNumber: '00052850382S', carrier: 'UPS GRND', scac: 'UPSN', shipDate: '2026-08-18',
    // Where it is CONSIGNED comes off the same notification. This was parsed and
    // discarded until 2026-08-13, so the card kept the column default — "via the CA
    // merge center" — while its own authorization said Secaucus, direct.
    shipDirect: true,
    consignedTo: 'SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
  })
  // The live case: the card read six days early and the notification corrects it.
  assert.equal(plan.applies[0].shipDateWas, '2026-08-12')
})

test('the project matching alone never writes', () => {
  const plan = planRoutingApply(parse(), [card({ shipmentNumber: '99999999' })])
  assert.equal(plan.applies.length, 0)
  assert.equal(plan.misses[0].kind, MISS.PROJECT_ONLY)
  assert.match(plan.misses[0].detail, /99999999/)
})

test('the shipment matching alone never writes', () => {
  const plan = planRoutingApply(parse(), [card({ projectNumber: '99999999' })])
  assert.equal(plan.applies.length, 0)
  assert.equal(plan.misses[0].kind, MISS.SHIPMENT_ONLY)
})

test('two different cards holding one key each is not a match', () => {
  const plan = planRoutingApply(parse(), [
    card({ id: 1, shipmentNumber: null }),
    card({ id: 2, projectNumber: null }),
  ])
  assert.equal(plan.applies.length, 0)
  assert.equal(plan.misses[0].kind, MISS.PROJECT_ONLY)
})

test('a notification matching nothing is historical, not nine failures', () => {
  const plan = planRoutingApply(parse(), [card({ projectNumber: 'x', shipmentNumber: 'y' })])
  assert.equal(plan.outOfScope, true)
})

// ⚠️ Found on the live board, not in review. Notification 00052827257S matches seven
// cards that all carry a conflicting authorization. Deriving "historical" from
// applies.length called it historical and skipped printing all seven conflicts —
// a count answering a different question from its label.
test('a notification that matched cards is NOT historical, even if it writes nothing', () => {
  const plan = planRoutingApply(parse(), [card({ authNumber: '55753138', status: 'authorized' })])
  assert.equal(plan.applies.length, 0)
  assert.equal(plan.matchedCards, 1)
  assert.equal(plan.outOfScope, false)
})

// ⚠️ Shipments 5–8 on the live board store 55753138 — that notification's APPOINTMENT
// number, not its Trip ID. A rule that "corrected" them would silently rewrite a
// number keyed off a document.
test('an existing authorization is never overwritten', () => {
  const plan = planRoutingApply(parse(), [card({ authNumber: '55753138', status: 'authorized' })])
  assert.equal(plan.misses.some((m) => m.kind === MISS.AUTH_CONFLICT), true)
  // Nothing at all is written: a card already carrying a DIFFERENT authorization is
  // not this notification's card, so its carrier and dates are not ours to move
  // either. The conflict is the whole finding — one human look, not a partial write.
  assert.equal(plan.applies.length, 0)
  assert.equal(plan.changes, 0)
})

test('the same notification applied twice is a no-op', () => {
  const settled = card({
    authNumber: '00052850382S', carrier: 'UPS GRND', scac: 'UPSN',
    shipDate: '2026-08-18', status: 'authorized',
    // A settled card includes where it is consigned. Leaving these off made the
    // fixture assert a no-op that the real lane could not deliver.
    shipDirect: true, consignedTo: 'SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
  })
  const plan = planRoutingApply(parse(), [settled])
  assert.equal(plan.matched, 1)
  assert.equal(plan.changes, 0)
  assert.equal(plan.misses.length, 0)
})

// Nima: "the date the bol is created is the date i generate it for routing, it has
// nothing to do with what date i think it will ship." So the stored date is an
// artifact, not a prediction — the pickup date wins regardless of status. My first
// cut held it on an `authorized` card, which treated an artifact as evidence.
test('the pickup date wins on any card that has not left, whatever its status', () => {
  for (const status of ['needs_routing', 'submitted', 'authorized', 'routed']) {
    const plan = planRoutingApply(parse(), [card({ status, shipDate: '2026-08-02' })])
    assert.equal(plan.applies[0].set.shipDate, '2026-08-18', `status ${status}`)
    assert.equal(plan.misses.length, 0, `status ${status}`)
  }
})

// The one guard that stays: a departed shipment is history, and `shipped_at` is the
// real evidence of when it left. The 08-01 batch departed 08-03, BEFORE its own 08-04
// pickup date — writing 08-04 there would claim a date after the freight was gone.
test('a departed shipment keeps its date — history is surfaced, not rewritten', () => {
  const plan = planRoutingApply(parse(), [
    card({ status: 'authorized', shipDate: '2026-08-02', shippedAt: '2026-08-03T00:00:00Z' }),
  ])
  assert.equal(plan.applies[0].set.shipDate, undefined)
  const m = plan.misses.find((x) => x.kind === MISS.SHIP_DATE_DEPARTED)
  assert.ok(m)
  assert.match(m.detail, /left 2026-08-03/)
})

test('a matched card whose DC disagrees is applied AND flagged', () => {
  const plan = planRoutingApply(parse(), [card({ dc: 'ST', dcLabel: 'Stone Mountain' })])
  assert.equal(plan.applies.length, 1)
  assert.equal(plan.misses[0].kind, MISS.DC_DISAGREES)
  const agree = planRoutingApply(parse(), [card({ dc: 'SC', dcLabel: 'Secaucus' })])
  assert.equal(agree.misses.length, 0)
})

test('summary counts each kind of miss separately, never lumped', () => {
  const s = summarizeRoutingMisses([
    planRoutingApply(parse(), [card({ shipmentNumber: '9' })]),
    planRoutingApply(parse(), [card()]),
  ])
  assert.equal(s.notifications, 2)
  assert.equal(s.projectOnly, 1)
  assert.equal(s.applied, 1)
})

// ── Where the freight is consigned ──────────────────────────────────────────────
//
// ⚠️ THE BUG THESE PROTECT, and it was live. `routing_shipment.ship_direct` DEFAULTS
// to false and `merge_center` DEFAULTS to 'CA', so a card nobody hand-edited asserted
// "consigned via the Santa Fe Springs merge center". On 2026-08-13 all five
// Bloomingdale's cards authorized for the 08-18 pickup read that way, while their own
// notifications consigned them DIRECT to Secaucus / Los Angeles / Stone Mountain /
// China Grove / Joppa. The BOL's ship-to block reads these fields.
//
// The parser had produced the right answer the whole time; the planner threw it away.

test('the notification decides where the freight is consigned, beating a stored default', () => {
  // The card carries `false` — the column default, which nobody typed. A COALESCE
  // would treat that as an answer and change nothing; that is precisely how the
  // wrong value survived, so the write is keyed on DISAGREEMENT, not on absence.
  const plan = planRoutingApply(parse(), [card({ shipDirect: false, mergeCenter: 'CA' })])
  assert.equal(plan.applies[0].set.shipDirect, true)
  assert.equal(plan.applies[0].set.consignedTo, 'SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094')
  // Named on both sides, because a change to the destination must never move quietly.
  assert.match(plan.applies[0].consigneeWas, /merge center CA/)
  assert.match(plan.applies[0].consigneeNow, /direct to SECAUCUS/)
})

test('a card that already agrees is left alone, so a re-run reports no change', () => {
  const plan = planRoutingApply(parse(), [card({
    shipDirect: true,
    consignedTo: 'SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
  })])
  assert.equal(plan.applies[0].set.shipDirect, undefined)
  assert.equal(plan.applies[0].set.consignedTo, undefined)
  assert.equal(plan.applies[0].consigneeWas, null)
})

test('a merge-center notification writes the merge center, not just the direct case', () => {
  const via = BODY.replace(
    'Consigned to: SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
    'Consigned to: SECAUCUS c/o MEGA-MERGE CA 12801 EXCELSIOR DRIVE SANTA FE SPGS , CA 90670',
  )
  const plan = planRoutingApply(parse({ body: via }), [card({ shipDirect: true })])
  assert.equal(plan.applies[0].set.shipDirect, false)
  assert.equal(plan.applies[0].set.mergeCenter, 'CA')
})

test('an unparseable consignee writes NOTHING — a non-answer is not evidence', () => {
  // The rule from routingAuthSource: "we looked and found nothing" must never be
  // written as if it were a finding. shipDirect null → no field is set.
  const blank = BODY.replace(
    'Consigned to: SECAUCUS 500 MEADOWLANDS PARKWAY SECAUCUS , NJ 07094',
    'Consigned to:  ',
  )
  const plan = planRoutingApply(parse({ body: blank }), [card({ shipDirect: false })])
  assert.equal(plan.applies[0].set.shipDirect, undefined)
  assert.equal(plan.applies[0].set.consignedTo, undefined)
})
