// test/orderEvents.test.js — the order-event spine.
//
// The tests that matter most here are the TIMESTAMP-HONESTY ones. This module
// exists to turn order_events into a ledger you can trust, so the rules that stop
// it inventing history get tested from several directions rather than assumed:
// a backfill must never write a guessed date, and a re-run must never append a
// duplicate.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPINE, SPINE_ORDER, DERIVED_TYPES, eventKey,
  eventsFromOrders, eventsFromFulfillments, eventsFromInvoices,
  eventsFromRouting, eventsFromEdi,
  deriveEvents, pendingEvents, summarize, timeline,
} from '../src/model/orderEvents.js'

const find = (events, type) => events.filter((e) => e.eventType === type)

// ── Timestamp honesty ────────────────────────────────────────────────────────

test('a real source date produces an actual-quality event', () => {
  const [e] = eventsFromFulfillments([
    { ifNumber: 'IF7413', soNumber: 'SO12293', ifDate: '2026-07-14' },
  ])
  assert.equal(e.eventType, 'IF_CREATED')
  assert.equal(e.tsQuality, 'actual')
  assert.equal(e.occurredAt.toISOString().slice(0, 10), '2026-07-14')
})

test('a transition with no source date is observed, not invented', () => {
  const events = eventsFromInvoices([
    { invNumber: 'INV5001', soNumber: 'SO12293', status: 'Paid In Full' },
  ])
  for (const e of events) {
    assert.equal(e.tsQuality, 'observed')
    assert.equal(e.occurredAt, null, 'observed events carry no date until the caller stamps one')
  }
})

test('backfill writes only real timestamps — it cannot fabricate a Tuesday', () => {
  const derived = [
    ...eventsFromFulfillments([{ ifNumber: 'IF7413', soNumber: 'SO12293', ifDate: '2026-07-14', status: 'Packed' }]),
    ...eventsFromInvoices([{ invNumber: 'INV5001', soNumber: 'SO12293', status: 'Paid In Full' }]),
  ]
  const kept = pendingEvents(derived, new Set(), { mode: 'backfill' })
  assert.deepEqual(kept.map((e) => e.eventType), ['IF_CREATED'])
  // The same input on a normal sync keeps everything, stamped with `now`.
  const now = new Date('2026-08-02T10:00:00Z')
  const synced = pendingEvents(derived, new Set(), { mode: 'sync', now })
  assert.deepEqual(synced.map((e) => e.eventType).sort(), ['IF_CREATED', 'INVOICED', 'PACKED', 'PAID'])
  assert.equal(find(synced, 'PAID')[0].occurredAt.getTime(), now.getTime())
  // ...and the one with a real date keeps its real date, not `now`.
  assert.equal(find(synced, 'IF_CREATED')[0].occurredAt.toISOString().slice(0, 10), '2026-07-14')
})

// ── Idempotency ──────────────────────────────────────────────────────────────

test('an event already in the ledger is not written again', () => {
  const derived = eventsFromOrders([{ soNumber: 'SO12293', firstSeen: '2026-07-01' }])
  const known = new Set([eventKey(derived[0])])
  assert.deepEqual(pendingEvents(derived, known), [])
})

test('a corrected ship date does not append a second DEPARTED', () => {
  const first = eventsFromFulfillments([{ ifNumber: 'IF7413', status: 'Shipped', actualShipDate: '2026-07-20' }])
  const corrected = eventsFromFulfillments([{ ifNumber: 'IF7413', status: 'Shipped', actualShipDate: '2026-07-21' }])
  const known = new Set(first.map(eventKey))
  // The key deliberately excludes occurred_at, so the corrected row is a no-op.
  assert.deepEqual(pendingEvents(corrected, known).map((e) => e.eventType), [])
})

test('duplicates within one snapshot collapse to a single insert', () => {
  const derived = eventsFromOrders([
    { soNumber: 'SO12293', firstSeen: '2026-07-01' },
    { soNumber: 'SO12293', firstSeen: '2026-07-01' },
  ])
  assert.equal(derived.length, 2)
  assert.equal(pendingEvents(derived, new Set()).length, 1)
})

// ── Derivation rules ─────────────────────────────────────────────────────────

test('PACKED is emitted only while the IF is currently packed', () => {
  const packed = eventsFromFulfillments([{ ifNumber: 'IF7414', status: 'Packed' }])
  assert.equal(find(packed, 'PACKED').length, 1)
  // A shipped IF was packed at some point, but nothing records when — so no
  // PACKED event rather than a guessed one.
  const shipped = eventsFromFulfillments([{ ifNumber: 'IF7413', status: 'Shipped', actualShipDate: '2026-07-20' }])
  assert.equal(find(shipped, 'PACKED').length, 0)
  assert.equal(find(shipped, 'DEPARTED').length, 1)
  // Picked is neither.
  const picked = eventsFromFulfillments([{ ifNumber: 'IF7228', status: 'Picked' }])
  assert.deepEqual(picked.map((e) => e.eventType), ['IF_CREATED'])
})

test('a shipped IF with no ship date still departs, as observed', () => {
  const [, departed] = eventsFromFulfillments([{ ifNumber: 'IF7413', ifDate: '2026-07-01', status: 'Shipped' }])
  assert.equal(departed.eventType, 'DEPARTED')
  assert.equal(departed.tsQuality, 'observed')
})

test('PAID only for paid-in-full invoices; INVOICED for every one', () => {
  const events = eventsFromInvoices([
    { invNumber: 'INV1', soNumber: 'SO1', status: 'Open' },
    { invNumber: 'INV2', soNumber: 'SO2', status: 'Paid In Full' },
  ])
  assert.equal(find(events, 'INVOICED').length, 2)
  assert.deepEqual(find(events, 'PAID').map((e) => e.docNumber), ['INV2'])
})

test('ROUTED keys on the DC/PO key and needs a routing date', () => {
  const events = eventsFromRouting([
    { dcPoKey: 'BLM:0620', bolNumber: '1001', bolGeneratedAt: '2026-07-22T18:00:00Z' },
    { dcPoKey: 'BLM:0621', bolNumber: '1002', bolGeneratedAt: null }, // BOL number but never generated
    { dcPoKey: 'BLM:0622' },                                          // not routed at all
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].docType, 'DC')
  assert.equal(events[0].docNumber, 'BLM:0620')
  assert.equal(events[0].note, 'BOL 1001')
  assert.equal(events[0].tsQuality, 'actual')
})

test('ROUTED prefers the authorization date over BOL generation', () => {
  // The retailer authorising the route is the routing event; printing paperwork
  // afterwards is not. Every current shipment has a BOL number and no generated
  // BOL, so gating on generation alone would leave this event type empty.
  const [e] = eventsFromRouting([{
    dcPoKey: 'BLM:0620', authNumber: '55753138', bolNumber: '1001',
    authorizedAt: '2026-07-27T22:39:10Z', bolGeneratedAt: '2026-07-29T10:00:00Z',
  }])
  assert.equal(e.occurredAt.toISOString(), '2026-07-27T22:39:10.000Z')
  assert.equal(e.note, 'auth 55753138 · BOL 1001')
  // ...and an authorization with no BOL still counts as routed.
  const [only] = eventsFromRouting([{ dcPoKey: 'BLM:0621', authNumber: '99', authorizedAt: '2026-07-27T22:39:10Z' }])
  assert.equal(only.eventType, 'ROUTED')
  assert.equal(only.note, 'auth 99')
})

test('EDI: outbound LIVE 856/810 only, at PO level', () => {
  const events = eventsFromEdi([
    { type: '856', direction: 'OUT', stream: 'LIVE', businessNumber: 'PO900', createdAt: '2026-07-20T12:00:00Z', tradingPartner: "Bloomingdale's" },
    { type: '810', direction: 'OUT', stream: 'LIVE', businessNumber: 'PO900', createdAt: '2026-07-21T12:00:00Z' },
    { type: '850', direction: 'IN', stream: 'LIVE', businessNumber: 'PO900', createdAt: '2026-07-01T12:00:00Z' }, // inbound
    { type: '856', direction: 'OUT', stream: 'TEST', businessNumber: 'PO901', createdAt: '2026-07-20T12:00:00Z' }, // test stream
    { type: '997', direction: 'OUT', stream: 'LIVE', businessNumber: 'PO900', createdAt: '2026-07-20T12:00:00Z' }, // not a spine event
  ])
  assert.deepEqual(events.map((e) => e.eventType), ['ASN_SENT', 'INVOICE_SENT'])
  assert.equal(events[0].docType, 'PO')
  assert.equal(events[0].docNumber, 'PO900')
  assert.equal(events[0].note, "Bloomingdale's")
  assert.equal(events[0].tsQuality, 'actual')
})

test('the TEST stream can never reach the ledger', () => {
  const events = eventsFromEdi([
    { type: '856', direction: 'OUT', stream: 'TEST', businessNumber: 'PO901', createdAt: '2026-07-20T12:00:00Z' },
  ])
  assert.deepEqual(events, [])
})

test('UNLINKED is stored as no SO, not as the literal string', () => {
  const [e] = eventsFromFulfillments([{ ifNumber: 'IF7414', soNumber: 'UNLINKED', ifDate: '2026-07-01' }])
  assert.equal(e.soNumber, null)
})

test('an unparseable date degrades to observed rather than to Invalid Date', () => {
  const [e] = eventsFromOrders([{ soNumber: 'SO1', firstSeen: 'not a date' }])
  assert.equal(e.occurredAt, null)
  assert.equal(e.tsQuality, 'observed')
})

// ── Assembly and reporting ───────────────────────────────────────────────────

test('deriveEvents walks every source table', () => {
  const events = deriveEvents({
    orders: [{ soNumber: 'SO1', firstSeen: '2026-07-01' }],
    fulfillments: [{ ifNumber: 'IF1', soNumber: 'SO1', ifDate: '2026-07-02', status: 'Shipped', actualShipDate: '2026-07-05' }],
    invoices: [{ invNumber: 'INV1', soNumber: 'SO1', status: 'Open' }],
    routing: [{ dcPoKey: 'DC:1', bolGeneratedAt: '2026-07-04' }],
    edi: [{ type: '856', direction: 'OUT', stream: 'LIVE', businessNumber: 'PO1', createdAt: '2026-07-06' }],
  })
  assert.deepEqual(summarize(events), {
    SO_IMPORTED: 1, IF_CREATED: 1, DEPARTED: 1, INVOICED: 1, ROUTED: 1, ASN_SENT: 1,
  })
})

test('deriveEvents survives an entirely empty snapshot', () => {
  assert.deepEqual(deriveEvents({}), [])
  assert.deepEqual(deriveEvents(), [])
  assert.deepEqual(summarize([]), {})
})

test('every derived type is in the spine, and none is written elsewhere', () => {
  const spineKeys = new Set(SPINE.map((s) => s.key))
  for (const t of DERIVED_TYPES) assert.ok(spineKeys.has(t), `${t} missing from SPINE`)
  // These belong to the scan handlers and stampApprovedForShipping — deriving
  // them here too would double-write them.
  for (const t of ['CUSTODY_OUT', 'CUSTODY_IN', 'REACHED_APPROVED']) {
    assert.ok(!DERIVED_TYPES.includes(t), `${t} must not be derived`)
  }
})

test('timeline breaks same-day ties on spine order, not insertion order', () => {
  // The source stores DATEs, so several transitions land on the same midnight.
  const sorted = timeline([
    { eventType: 'DEPARTED', occurredAt: '2026-07-20' },
    { eventType: 'IF_CREATED', occurredAt: '2026-07-20' },
    { eventType: 'SO_IMPORTED', occurredAt: '2026-07-01' },
  ])
  assert.deepEqual(sorted.map((e) => e.eventType), ['SO_IMPORTED', 'IF_CREATED', 'DEPARTED'])
  assert.ok(SPINE_ORDER.get('IF_CREATED') < SPINE_ORDER.get('DEPARTED'))
})
