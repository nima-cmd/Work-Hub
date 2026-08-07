import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PC, TAB, postCustodyState, missionTab, fulfilledNeverScanned, routingForPo,
} from '../src/model/postCustody.js'

const TODAY = new Date('2026-08-07T18:00:00Z')
const ff = (o = {}) => ({ ifNumber: 'IF1', status: 'Picked', labelled: false, ...o })

// ── The three tabs ──────────────────────────────────────────────────────────

test('a sales order with no fulfilment is on the Sales Orders tab', () => {
  assert.equal(missionTab({ fulfilments: [] }), TAB.ORDERS)
})

test('a fulfilment out with Nestor is on the Fulfilment tab', () => {
  assert.equal(missionTab({ fulfilments: [ff()], custodyState: 'warehouse' }), TAB.FULFILMENT)
})

test('a fulfilment created but never scanned out stays on the Fulfilment tab', () => {
  // Nima: "if something fullfilled with no scan out we need to be aware since it
  // should be happening one after another."
  assert.equal(missionTab({ fulfilments: [ff()], custodyState: null }), TAB.FULFILMENT)
  assert.equal(fulfilledNeverScanned({ custodyOut: null, custodyIn: null }), true)
  assert.equal(fulfilledNeverScanned({ custodyOut: '2026-08-01', custodyIn: null }), false)
})

test('goods back in our possession START the action tab, part-scanned included', () => {
  // ⚠️ The load-bearing interpretation. Measured 2026-08-07: leaving returned
  // cards on the fulfilment tab put ALL 26 actionable cards there and left the
  // action tab holding nothing but 65 shipped orders — the lump being fixed.
  assert.equal(missionTab({ fulfilments: [ff()], custodyState: 'returned' }), TAB.ACTION)
  assert.equal(missionTab({ fulfilments: [ff()], custodyState: 'partial' }), TAB.ACTION)
})

// ── EDI: pack → route → pickup confirmation → departure ─────────────────────

test('an EDI card not yet packed in NetSuite is told to pack it', () => {
  const s = postCustodyState({ source: 'edi', fulfilments: [ff({ status: 'Picked' })] }, TODAY)
  assert.equal(s.key, PC.EDI_NEEDS_PACK)
  assert.equal(s.isWork, true)
  assert.match(s.waitingOn, /routable/)
})

test('a packed EDI card with no BOL needs routing', () => {
  const s = postCustodyState({ source: 'edi', fulfilments: [ff({ status: 'Packed' })], routing: null }, TODAY)
  assert.equal(s.key, PC.EDI_NEEDS_ROUTING)
  assert.equal(s.isWork, true)
})

test('a routed EDI card with no carrier yet is awaiting pickup confirmation', () => {
  const s = postCustodyState({
    source: 'edi', fulfilments: [ff({ status: 'Packed' })],
    routing: { bolNumber: 'NB1', status: 'submitted', carrier: null, shipDate: null },
  }, TODAY)
  assert.equal(s.key, PC.EDI_AWAITING_PICKUP)
  assert.equal(s.isWork, false)
})

test('⚠️ a tendered EDI shipment reads AWAITING DEPARTURE, not neglect', () => {
  // The original false positive, exactly: 28 EDI fulfilments reported as "back in
  // our hands, nothing done, oldest 16 days" when every one had a BOL, routing
  // submitted, and an accepted tender for Monday's pickup. This is the live shape
  // of all 9 Nordstrom BOLs on 2026-08-07.
  const s = postCustodyState({
    source: 'edi', fulfilments: [ff({ status: 'Packed' })],
    routing: { bolNumber: 'NB1731246', status: 'submitted', carrier: 'CTE Carrier', shipDate: '2026-08-10' },
  }, TODAY)
  assert.equal(s.key, PC.EDI_AWAITING_DEPARTURE)
  assert.equal(s.isWork, false, 'a confirmed pickup is a WATCH — this is the whole point')
  assert.match(s.waitingOn, /CTE Carrier/)
  assert.match(s.waitingOn, /Aug 10/)
})

// ── Boutique ────────────────────────────────────────────────────────────────

test('⚠️ IF7405: packed and waiting on its ship window is NOT work', () => {
  // Nima, 2026-08-07: "that item fulfilment is packed and is one of the cases
  // where we are waiting but not on routing but rather for the ship window to
  // open so we can route and ship." I had reported it as the oldest boutique item
  // on the board, stuck 16 days. It is correctly parked until 08-18.
  const s = postCustodyState({
    source: 'boutique', location: 'Warehouse',
    fulfilments: [ff({ ifNumber: 'IF7405', status: 'Picked', labelled: false })],
    shipWindow: { daysToShip: 11, soShipDate: '2026-08-18' },
  }, TODAY)
  assert.equal(s.key, PC.AWAITING_SHIP_WINDOW)
  assert.equal(s.isWork, false, 'ageing a correct holding state is how this board invents work')
  assert.match(s.waitingOn, /Aug 18/)
  assert.match(s.waitingOn, /mark packed that day/)
  // ⚠️ NOT keyed on shipWindow.notOpenYet — that is an EDI-850 field and is false
  // for every boutique. Keying on it put all 15 of these into "needs a label".
  assert.equal(
    postCustodyState({
      source: 'boutique', fulfilments: [ff({ labelled: false })],
      shipWindow: { notOpenYet: false, daysToShip: 11, soShipDate: '2026-08-18' },
    }, TODAY).key,
    PC.AWAITING_SHIP_WINDOW,
  )
})

test('an open-window unlabelled boutique names BOTH options, never guessing the lane', () => {
  // ⚠️ Nima's two boutique cases (label vs "requires us to route") have no
  // confirmed signal to tell them apart yet, so this state must not pick one.
  const s = postCustodyState({
    source: 'boutique', location: 'Warehouse',
    fulfilments: [ff({ labelled: false })],
    shipWindow: { daysToShip: 0 },
  }, TODAY)
  assert.equal(s.key, PC.NEEDS_LABEL_OR_ROUTING)
  assert.match(s.waitingOn, /label/)
  assert.match(s.waitingOn, /routing/)
})

test('a labelled boutique is told to mark packed, and WHY that matters', () => {
  const s = postCustodyState({
    source: 'boutique', fulfilments: [ff({ labelled: true, status: 'Picked' })],
    shipWindow: { daysToShip: 0 },
  }, TODAY)
  assert.equal(s.key, PC.NEEDS_MARK_PACKED)
  // Marking packed IS the invoice trigger — the sentence has to say so, because
  // that is the reason it must not be done early.
  assert.match(s.waitingOn, /invoice/)
})

test('packed with no invoice awaits the invoice; invoiced with a balance awaits payment', () => {
  const packed = postCustodyState({
    source: 'boutique', fulfilments: [ff({ labelled: true, status: 'Packed' })], invoices: [],
  }, TODAY)
  assert.equal(packed.key, PC.AWAITING_INVOICE)

  const owing = postCustodyState({
    source: 'boutique', fulfilments: [ff({ labelled: true, status: 'Packed', invoice: 'INV1' })],
    invoices: [{ invNumber: 'INV1', amountRemaining: 2761.44, terms: 'Due on receipt' }],
  }, TODAY)
  assert.equal(owing.key, PC.AWAITING_PAYMENT)
  assert.equal(owing.isWork, false)
})

test('⚠️ payment is judged by paymentGate, never by a raw balance', () => {
  // Testing amountRemaining > 0 was wrong three ways, and all three are live.
  const pack = (inv) => ({
    source: 'boutique', fulfilments: [ff({ labelled: true, status: 'Packed', invoice: 'I' })], invoices: [inv],
  })

  // 1. The NY office's one-way waiver. Live: SO12334 / INV11477 owes $3,262.53
  // AND is Approved For Shipping. My raw-balance version parked it while
  // labelGap correctly said "mark it shipped".
  const waived = postCustodyState(pack({
    invNumber: 'INV11477', amountRemaining: 3262.53, terms: 'Due on receipt',
    shippingStatus: 'Approved For Shipping',
  }), TODAY)
  assert.equal(waived.key, PC.NEEDS_MARK_SHIPPED)
  assert.match(waived.waitingOn, /NY office/)

  // 2. Net terms not yet due are not a hold — the retracted "70 unpaid" shape.
  assert.equal(postCustodyState(pack({ amountRemaining: 6344, terms: 'Net 30' }), TODAY).key, PC.NEEDS_MARK_SHIPPED)

  // 3. "No Payment Required" carries a balance forever by design.
  assert.equal(postCustodyState(pack({ amountRemaining: 666, terms: 'No Payment Required' }), TODAY).key, PC.NEEDS_MARK_SHIPPED)

  // and a genuine Due-on-receipt balance with no waiver DOES hold it
  assert.equal(postCustodyState(pack({ amountRemaining: 158, terms: 'Due on receipt' }), TODAY).key, PC.AWAITING_PAYMENT)
})

test('a China/FOB order never asks for a label', () => {
  // 0 of 12 China fulfilments have ever carried one. Keyed on location, matching
  // labelGap rather than inventing a second rule.
  const s = postCustodyState({
    source: 'boutique', location: 'China Warehouse', fulfilments: [ff({ labelled: false })],
  }, TODAY)
  assert.equal(s.key, PC.FOB_PICKUP)
  assert.equal(s.isWork, false)
})

test('⚠️ a SHIPPED order with no fulfilment rows never asks for a label', () => {
  // Live: SO12263 (Pluto LA) and SO12234 (Centre Point Nantucket) are SHIPPED
  // with ZERO fulfilments. They reached the possession tab on the order's own
  // stage and then fell through every branch to "needs a carrier label" — on
  // goods that have already gone. They were the ONLY two work items the board
  // was going to show, and both were false.
  const s = postCustodyState({
    source: 'boutique', departed: true, fulfilments: [],
    shipWindow: { daysToShip: -3 },
  }, TODAY)
  assert.equal(s.key, PC.DEPARTED)
  // and with no fulfilment and no departure evidence, it names nothing at all
  assert.equal(postCustodyState({ source: 'boutique', fulfilments: [] }, TODAY), null)
})

test('a shipped card is terminal on either evidence', () => {
  assert.equal(postCustodyState({ source: 'boutique', fulfilments: [ff({ status: 'Shipped' })] }, TODAY).key, PC.DEPARTED)
  assert.equal(postCustodyState({
    source: 'edi', fulfilments: [ff({ status: 'Packed' })],
    routing: { bolNumber: 'NB1', shippedAt: '2026-08-05T22:05:50Z' },
  }, TODAY).key, PC.DEPARTED)
})

// ── PO groups + the routing join ────────────────────────────────────────────

test('⚠️ a tendered EDI card still reading Picked is AWAITING DEPARTURE, with the lag noted', () => {
  // THE LIVE SHAPE on 2026-08-07: all 9 Nordstrom BOLs are routed and tendered
  // for Monday while their fulfilments still read `Picked` in NetSuite — the
  // status lags the pallet. Walking Nima's chain in order would tell him to
  // "pack" a shipment a carrier is already booked for. Placement follows the
  // furthest PROVEN fact; the missing keystroke rides along as a note.
  const s = postCustodyState({
    source: 'edi', fulfilments: [ff({ status: 'Picked' })],
    routing: { bolNumber: 'NB1731246', status: 'submitted', carrier: 'CTE Carrier', shipDate: '2026-08-10' },
  }, TODAY)
  assert.equal(s.key, PC.EDI_AWAITING_DEPARTURE)
  assert.equal(s.isWork, false)
  assert.match(s.waitingOn, /still reads Picked in NetSuite/)
})

test('the routing join takes the LEAST advanced of a card\'s live BOLs', () => {
  // One PO can span up to 9 DCs (PO 50073677 does, live). If one sibling DC is
  // still unrouted the card must not claim "pickup confirmed".
  const shipments = [
    { bolNumber: 'A', memberPos: ['P1'], status: 'submitted', carrier: 'CTE', shipDate: '2026-08-10', shippedAt: null },
    { bolNumber: 'B', memberPos: ['P1'], status: 'needs_routing', carrier: null, shipDate: null, shippedAt: null },
  ]
  assert.equal(routingForPo(shipments, 'P1').bolNumber, 'B')
  const s = postCustodyState({
    source: 'edi', fulfilments: [ff({ status: 'Packed' })], routing: routingForPo(shipments, 'P1'),
  }, TODAY)
  assert.equal(s.key, PC.EDI_NEEDS_ROUTING)
})

test('a PO group takes its state from the fulfilment holding it up', () => {
  // One packed, one still picked, nothing routed → the shipment cannot move, so
  // the card must read "pack it", not average out to done.
  const s = postCustodyState({
    source: 'edi',
    fulfilments: [ff({ ifNumber: 'IF1', status: 'Packed' }), ff({ ifNumber: 'IF2', status: 'Picked' })],
    routing: null,
  }, TODAY)
  assert.equal(s.key, PC.EDI_NEEDS_PACK)
})

test('the routing join finds the PO inside memberPos, preferring the live BOL', () => {
  // routing_shipment is keyed by (partner, DC) over 1..many POs — the card has no
  // shipment id, so the PO must be looked up inside the member list.
  const shipments = [
    { bolNumber: 'OLD', memberPos: ['50073677'], shippedAt: '2026-06-05T00:00:00Z' },
    { bolNumber: 'NEW', memberPos: ['50073677', '50073678'], shippedAt: null },
  ]
  assert.equal(routingForPo(shipments, '50073677').bolNumber, 'NEW')
  assert.equal(routingForPo(shipments, 50073678).bolNumber, 'NEW')
  assert.equal(routingForPo(shipments, '99999'), null)
  assert.equal(routingForPo(shipments, null), null)
})
