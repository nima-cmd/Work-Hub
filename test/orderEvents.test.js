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
  SPINE, SPINE_ORDER, SPINE_LABEL, DERIVED_TYPES, eventKey,
  eventsFromOrders, eventsFromFulfillments, eventsFromInvoices,
  eventsFromRouting, eventsFromEdi, invNumberFrom810, isOurInvoiceNumber,
  deriveEvents, pendingEvents, summarize, timeline, poTimelineSteps, docCountLabel,
  classifyPartnerRef, partnerRefNotes,
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

test('EDI: each document is keyed as what it actually is', () => {
  // Real business numbers from Orderful (2026-08-02): the 856 carries a BOL and
  // the 810 our own invoice number. Only the 850's is a PO.
  const events = eventsFromEdi([
    { type: '850_PURCHASE_ORDER', direction: 'IN', stream: 'LIVE', businessNumber: '8170366', createdAt: '2026-07-01T12:00:00Z', tradingPartner: "Bloomingdale's" },
    { type: '856_SHIP_NOTICE_MANIFEST', direction: 'OUT', stream: 'LIVE', businessNumber: 'NB1731231', createdAt: '2026-07-20T12:00:00Z', tradingPartner: "Bloomingdale's" },
    { type: '810_INVOICE', direction: 'OUT', stream: 'LIVE', businessNumber: '11398', createdAt: '2026-07-21T12:00:00Z' },
    { type: '856', direction: 'OUT', stream: 'TEST', businessNumber: 'NB9', createdAt: '2026-07-20T12:00:00Z' }, // test stream
    { type: '997', direction: 'OUT', stream: 'LIVE', businessNumber: 'X', createdAt: '2026-07-20T12:00:00Z' }, // not a spine event
  ])
  assert.deepEqual(
    events.map((e) => [e.eventType, e.docType, e.docNumber]),
    [
      ['PO_RECEIVED', 'PO', '8170366'],
      ['ASN_SENT', 'ASN', 'NB1731231'],
      // 'INV11398', not 'PO'/'11398' — so the 810 lands on the same document as
      // the INVOICED/PAID events and joins the SO ledger for free.
      ['INVOICE_SENT', 'INV', 'INV11398'],
    ],
  )
  assert.equal(events[0].note, "Bloomingdale's")
  assert.equal(events[1].tsQuality, 'actual')
})

test('the 850 counts only inbound; 856/810 only outbound', () => {
  const events = eventsFromEdi([
    // Us as the buyer — the purchasing side, not this pipeline.
    { type: '850_PURCHASE_ORDER', direction: 'OUT', stream: 'LIVE', businessNumber: 'P1', createdAt: '2026-07-01T12:00:00Z' },
    // A partner's inbound ASN is their event, not ours.
    { type: '856_SHIP_NOTICE_MANIFEST', direction: 'IN', stream: 'LIVE', businessNumber: 'NB1', createdAt: '2026-07-02T12:00:00Z' },
  ])
  assert.deepEqual(events, [])
})

test('an 810 business number that already carries INV is not double-prefixed', () => {
  assert.equal(invNumberFrom810('11398'), 'INV11398')
  assert.equal(invNumberFrom810('INV11398'), 'INV11398')
  assert.equal(invNumberFrom810('inv11398'), 'INV11398')
})

test('a reference that is NOT our invoice number is never prefixed', () => {
  // Every shape measured live 2026-08-03. Ours are 4–5 digits; the prefix may
  // only be restored onto one of those, because 'INV' + a foreign reference
  // invents a document number that exists nowhere and joins to nothing.
  assert.equal(isOurInvoiceNumber('9114'), true)      // Bloomingdale's, bare
  assert.equal(isOurInvoiceNumber('INV11416'), true)  // the newest we hold
  assert.equal(isOurInvoiceNumber('C13369495'), false) // Nordstrom, from 2025-10-29
  assert.equal(isOurInvoiceNumber('3426195360'), false) // Nordstrom transition band
  assert.equal(isOurInvoiceNumber('1245531'), false)  // NMG
  assert.equal(isOurInvoiceNumber('339213124.5'), false) // parsed as a float upstream
  assert.equal(isOurInvoiceNumber(''), false)
  assert.equal(isOurInvoiceNumber(null), false)

  assert.equal(invNumberFrom810('C13369495'), 'C13369495')
  assert.equal(invNumberFrom810('3426195360'), '3426195360')
  assert.equal(invNumberFrom810('339213124.5'), '339213124.5')
})

test("a partner-referenced 810 is still an invoice document, keyed on the partner's reference", () => {
  // Nordstrom cut over on 2025-10-29 from our invoice number to their own 'C'
  // reference. Before this, PO 50125577's trail showed 'INVC13369495' — an
  // invoice we never raised — beside its one real INV11244.
  const events = eventsFromEdi([
    { type: '810_INVOICE', direction: 'OUT', stream: 'LIVE', businessNumber: 'C13369495', createdAt: '2026-07-06T12:00:00Z', tradingPartner: 'Nordstrom (US) (Direct to Store)' },
  ])
  assert.deepEqual(
    events.map((e) => [e.eventType, e.docType, e.docNumber]),
    [['INVOICE_SENT', 'INV', 'C13369495']],
  )
})

test('one ASN announcing several POs is still ONE event', () => {
  // The PO fan-out is resolved at query time through edi_document_po_refs. If it
  // were fanned out here instead, every window report would double-count the
  // transmission — 936 PO-pairs across 818 real ASNs, live 2026-08-02.
  const events = eventsFromEdi([
    { type: '856_SHIP_NOTICE_MANIFEST', direction: 'OUT', stream: 'LIVE', businessNumber: 'NB1731231', createdAt: '2026-07-20T12:00:00Z' },
  ])
  assert.equal(events.length, 1)
  assert.equal(events[0].docNumber, 'NB1731231')
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
  // Checked against the derived MAPS rather than SPINE alone: the spine is in two
  // pieces (PO_SPINE holds the 850, which precedes every SO event), and what a
  // derived type actually needs is a label to render and a position to sort by.
  for (const t of DERIVED_TYPES) {
    assert.ok(SPINE_LABEL.has(t), `${t} has no label`)
    assert.ok(SPINE_ORDER.has(t), `${t} has no sort position`)
  }
  // PO_RECEIVED sorts ahead of the whole SO spine — the 850 is what causes the
  // sales order, so it can never render below SO_IMPORTED on a same-day tie.
  assert.ok(SPINE_ORDER.get('PO_RECEIVED') < SPINE_ORDER.get('SO_IMPORTED'))
  // These belong to the scan handlers and stampApprovedForShipping — deriving
  // them here too would double-write them.
  for (const t of ['CUSTODY_OUT', 'CUSTODY_IN', 'REACHED_APPROVED']) {
    assert.ok(!DERIVED_TYPES.includes(t), `${t} must not be derived`)
  }
})

test('a PO timeline collapses to one row per step, reporting its span', () => {
  const steps = poTimelineSteps([
    { eventType: 'PO_RECEIVED', docType: 'PO', docNumber: '7776940', occurredAt: '2026-07-11', label: '850 received' },
    { eventType: 'IF_CREATED', docType: 'IF', docNumber: 'IF7332', occurredAt: '2026-07-30' },
    { eventType: 'IF_CREATED', docType: 'IF', docNumber: 'IF7333', occurredAt: '2026-07-30' },
    { eventType: 'IF_CREATED', docType: 'IF', docNumber: 'IF7334', occurredAt: '2026-08-01' },
    { eventType: 'ASN_SENT', docType: 'ASN', docNumber: 'NB1731234', occurredAt: '2026-07-30' },
  ])
  assert.deepEqual(steps.map((s) => [s.eventType, s.docs.length]), [
    ['PO_RECEIVED', 1], ['IF_CREATED', 3], ['ASN_SENT', 1],
  ])
  // The span is the point: three fulfilments over three days, not one date.
  const ifs = steps.find((s) => s.eventType === 'IF_CREATED')
  assert.equal(new Date(ifs.first).toISOString().slice(0, 10), '2026-07-30')
  assert.equal(new Date(ifs.last).toISOString().slice(0, 10), '2026-08-01')
  assert.deepEqual(ifs.docs, ['IF7332', 'IF7333', 'IF7334'])
})

test('a step is only observed when every event in it is', () => {
  // One real date makes the span's edges real — the UI must not hedge a date it
  // actually knows just because a sibling was a first-sighting.
  const [step] = poTimelineSteps([
    { eventType: 'INVOICED', docNumber: 'INV1', occurredAt: '2026-07-30', observed: true },
    { eventType: 'INVOICED', docNumber: 'INV2', occurredAt: '2026-07-31', observed: false },
  ])
  assert.equal(step.observed, false)
  const [allObserved] = poTimelineSteps([
    { eventType: 'INVOICED', docNumber: 'INV1', occurredAt: '2026-07-30', observed: true },
  ])
  assert.equal(allObserved.observed, true)
})

test('a PO timeline orders by when each step started, not by the expected shape', () => {
  // An 810 that went out before the 856 is a real anomaly. Sorting by spine
  // position would silently tidy it into the order we expected to see.
  const steps = poTimelineSteps([
    { eventType: 'ASN_SENT', docNumber: 'NB1', occurredAt: '2026-07-30' },
    { eventType: 'INVOICE_SENT', docNumber: 'INV1', occurredAt: '2026-07-20' },
  ])
  assert.deepEqual(steps.map((s) => s.eventType), ['INVOICE_SENT', 'ASN_SENT'])
})

test("a document count says whose numbers it is counting", () => {
  // PO 50125577, live: one real invoice and three Nordstrom 'C' references. The
  // 810 step would read '3 INVs', claiming invoices we never raised — the same
  // lump the never-lump rule exists to stop.
  const inv = (docs) => docCountLabel({ eventType: 'INVOICE_SENT', docType: 'INV', docs })
  assert.deepEqual(inv(['C13369485', 'C13369490', 'C13369495']), { text: '3 partner refs', foreign: 3 })
  assert.deepEqual(inv(['INV11244', 'INV11245']), { text: '2 INVs', foreign: 0 })
  // Mixed is real: a PO can straddle the 2025-10-29 cutover.
  assert.deepEqual(inv(['INV9725', 'C13369495']), { text: '1 INVs + 1 partner ref', foreign: 1 })
  // A single document is still named, with the reference marked for what it is.
  assert.deepEqual(inv(['C13369495']), { text: 'C13369495 (partner ref)', foreign: 1 })
  assert.deepEqual(inv(['INV11244']), { text: 'INV11244', foreign: 0 })
  // Only the invoice step asks the question — an ASN reference is nobody's
  // invoice number and must not be flagged as a foreign one.
  assert.deepEqual(
    docCountLabel({ eventType: 'ASN_SENT', docType: 'ASN', docs: ['NB1731231', 'NB1731232'] }),
    { text: '2 ASNs', foreign: 0 },
  )
})

test('a partner ref is classified by what the records can actually say about it', () => {
  // Measured live 2026-08-03 across all 116 non-ours-shaped refs: 71 resolve
  // through invoices.nordstrom_ref, 42 predate the earliest invoice document we
  // hold, and 3 (C12017200/205/210) were transmitted inside the span we cover
  // yet sit on no invoice anywhere. Three different answers; the UI used to
  // render all three identically.
  const floor = '2026-02-04'
  assert.equal(classifyPartnerRef({ covers: ['INV11246'], sentAt: '2025-12-16', recordsFrom: floor }), 'covers')
  assert.equal(classifyPartnerRef({ covers: [], sentAt: '2025-10-29', recordsFrom: floor }), 'preRecords')
  assert.equal(classifyPartnerRef({ covers: [], sentAt: '2026-03-04', recordsFrom: floor }), 'unmatched')
  // No floor yet (trandate unpopulated until a sync runs): "predates our
  // records" is a claim that needs the floor to back it, so it must not fire.
  assert.equal(classifyPartnerRef({ covers: [], sentAt: '2025-10-29', recordsFrom: null }), 'unmatched')
  // No transmission date: same rule — never place a document we cannot date.
  assert.equal(classifyPartnerRef({ covers: [], sentAt: null, recordsFrom: floor }), 'unmatched')
})

test('partner-ref notes collapse the resolved and name each unaccounted-for ref', () => {
  // Resolved refs summarise — their invoices already appear as INVOICED/PAID
  // events above. The unaccounted-for ones are the exceptions, and burying them
  // in a count is exactly how this stayed latent through #39 and #40.
  const floor = '2026-02-04'
  const notes = partnerRefNotes([
    { ref: 'C12017090', covers: ['INV10715', 'INV10718'], sentAt: '2026-03-04' },
    { ref: 'C12017095', covers: ['INV10716', 'INV10718'], sentAt: '2026-03-04' },
    { ref: 'C10274590', covers: [], sentAt: '2025-10-29' },
    { ref: 'C12017200', covers: [], sentAt: '2026-03-04' },
  ], floor)

  assert.deepEqual(notes.map((n) => n.verdict), ['covers', 'preRecords', 'unmatched'])
  // The shared INV10718 counts once — the summary counts invoices, not pairs.
  assert.equal(notes[0].text, '2 partner refs → 3 INVs of ours')
  assert.equal(notes[1].text, 'C10274590 — predates our invoice records')
  assert.match(notes[1].title, /2026-02-04/, 'the claim names the floor that backs it')
  assert.equal(notes[2].text, 'C12017200 — on no invoice we hold')
  assert.match(notes[2].title, /never adopted/)

  // Without a floor the unmatched wording must not claim span coverage.
  const bare = partnerRefNotes([{ ref: 'C10274590', covers: [], sentAt: '2025-10-29' }], null)
  assert.equal(bare[0].verdict, 'unmatched')
  assert.ok(!/span our records cover/.test(bare[0].title), 'no floor, no coverage claim')

  assert.deepEqual(partnerRefNotes([], floor), [], 'a PO with no partner refs renders nothing extra')
})

test('the pre-spine event types still get a label rather than rendering raw', () => {
  // SHIPPED_VALUE and CUSTODY_CLEARED are written outside the deriver but do
  // reach the ledger, so they appear in PO and SO timelines.
  assert.equal(SPINE_LABEL.get('SHIPPED_VALUE'), 'Shipped value recorded')
  assert.equal(SPINE_LABEL.get('CUSTODY_CLEARED'), 'Custody register cleared')
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
