import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRACE_TYPES, normalizeRef, trackingCard, fulfillmentCards, invoiceCards, taskCards,
  emailCards, orderCard, dedupeCards, linkedEntries, pushTrail, buildTrace, TRAIL_MAX,
} from '../src/model/trace.js'

test('normalizeRef accepts the five traceable types and uppercases', () => {
  for (const t of TRACE_TYPES) {
    assert.deepEqual(normalizeRef(t.toLowerCase(), ' x1 '), { docType: t, docNumber: 'x1' })
  }
})

test('normalizeRef refuses an untraceable type rather than guessing', () => {
  // PO has its own spine (getPoLedger) and is deliberately not a trace subject
  // yet. Falling through to a generic trace would render an empty page that
  // looks like "this PO has no history".
  assert.throws(() => normalizeRef('PO', '50203208'), /not a traceable type/)
  assert.throws(() => normalizeRef('', '1'), /not a traceable type/)
})

test('normalizeRef refuses a blank document number', () => {
  assert.throws(() => normalizeRef('SO', '   '), /needs a document number/)
  assert.throws(() => normalizeRef('SO', null), /needs a document number/)
})

// ── The account rule (upsRates.js): never present the wrong UPS account ──────

test('a tracking card derives the UPS account from the 1Z prefix and marks wholesale', () => {
  const c = trackingCard('1ZC6J6100302360756')
  assert.equal(c.docType, 'TRACK')
  assert.match(c.detail, /C6J610/)
  assert.match(c.detail, /wholesale/)
})

test('an 18GE01 tracking number is NOT labelled wholesale', () => {
  const c = trackingCard('1Z18GE010123456789')
  assert.match(c.detail, /18GE01/)
  assert.doesNotMatch(c.detail, /wholesale/)
})

test('a non-UPS tracking number makes no account claim at all', () => {
  const c = trackingCard('9400111899223197428490')
  assert.doesNotMatch(c.detail, /C6J610|18GE01/)
  assert.match(c.detail, /not derivable/)
})

test('a blank tracking number produces no card', () => {
  assert.equal(trackingCard(''), null)
  assert.equal(trackingCard(null), null)
})

// ── Rule 2: a reference is not a record ─────────────────────────────────────

test('an invoice NAMED on an IF but absent from invoices is a mention, not a hop', () => {
  const cards = fulfillmentCards([{ ifNumber: 'IF7486', status: 'Shipped', invoiceNumber: 'INV10774' }], [])
  const inv = cards.find((c) => c.docType === 'INV')
  assert.equal(inv.docNumber, 'INV10774')
  assert.equal(inv.missing, true)
  assert.equal(inv.hoppable, false, 'a document we do not have must not offer a hop that dead-ends')
  assert.match(inv.detail, /named on IF7486/)
})

test('an invoice that DOES exist comes from the invoices table, not the IF string', () => {
  const invoices = [{ invNumber: 'INV10774', status: 'Open', amountRemaining: 4180 }]
  const cards = [
    ...fulfillmentCards([{ ifNumber: 'IF7486', status: 'Shipped', invoiceNumber: 'INV10774' }], invoices),
    ...invoiceCards(invoices),
  ]
  const invs = dedupeCards(cards).filter((c) => c.docType === 'INV')
  assert.equal(invs.length, 1, 'one invoice, not a record and a mention of the same number')
  assert.equal(invs[0].missing, undefined)
  assert.equal(invs[0].hoppable, true)
  assert.match(invs[0].detail, /\$4,180/)
})

test('two IFs naming the same absent invoice list it once', () => {
  const cards = fulfillmentCards([
    { ifNumber: 'IF7486', invoiceNumber: 'INV10774' },
    { ifNumber: 'IF7487', invoiceNumber: 'INV10774' },
  ], [])
  assert.equal(dedupeCards(cards).filter((c) => c.docType === 'INV').length, 1)
})

test('dedupe keeps the record and drops the later mention of the same number', () => {
  const record = invoiceCards([{ invNumber: 'INV1', status: 'Open' }])
  const named = fulfillmentCards([{ ifNumber: 'IF1', invoiceNumber: 'INV1' }], [])
  const out = dedupeCards([...record, ...named]).filter((c) => c.docType === 'INV')
  assert.equal(out.length, 1)
  assert.equal(out[0].missing, undefined, 'the real row must win over a mention')
})

test('an IF with no named invoice invents nothing', () => {
  const cards = fulfillmentCards([{ ifNumber: 'IF7486', status: 'Picked', invoiceNumber: null }], [])
  assert.equal(cards.filter((c) => c.docType === 'INV').length, 0)
  assert.equal(cards.filter((c) => c.docType === 'IF').length, 1)
})

test('an IF carries every one of its tracking numbers', () => {
  const cards = fulfillmentCards([{
    ifNumber: 'IF7486', status: 'Shipped',
    trackingNumbers: ['1ZC6J6100302360756', '1ZC6J6100302360757'],
  }], [])
  assert.equal(cards.filter((c) => c.docType === 'TRACK').length, 2)
})

// ── Rule 1: related and linked never merge ──────────────────────────────────

test('a hand-attached Google Doc lands in LINKED and never in related', () => {
  const trace = buildTrace({
    subject: { docType: 'SO', docNumber: 'SO12296' },
    related: fulfillmentCards([{ ifNumber: 'IF7486', status: 'Shipped' }], []),
    linked: {
      docLinks: [{ id: 1, bType: 'GDOC', bNumber: 'abc123', label: 'Resort 26 shoe order', url: 'https://docs.google.com/document/d/abc123' }],
    },
  })
  assert.equal(trace.related.some((c) => c.docNumber === 'abc123'), false)
  assert.equal(trace.linked.length, 1)
  assert.equal(trace.linked[0].kind, 'external')
  assert.equal(trace.linked[0].host, 'docs.google.com')
  assert.equal(trace.linked[0].hoppable, false)
})

test('a doc-to-doc link is hoppable when it names a traceable type, and not otherwise', () => {
  const linked = linkedEntries({
    docLinks: [
      { id: 1, bType: 'IF', bNumber: 'IF7486', label: 'the fulfilment' },
      { id: 2, bType: 'PO', bNumber: '50203208', label: 'the customer PO' },
    ],
  })
  assert.equal(linked[0].hoppable, true)
  assert.equal(linked[1].hoppable, false, 'PO is not a trace subject yet — the hop would dead-end')
})

test('a linked email is an external Gmail hop, never a related card', () => {
  const linked = linkedEntries({
    emailLinks: [{ id: 9, subject: 'Routing auth', gmailUrl: 'https://mail.google.com/mail/u/0/#all/abc' }],
  })
  assert.equal(linked[0].kind, 'email')
  assert.equal(linked[0].host, 'mail.google.com')
  assert.equal(linked[0].hoppable, false)
})

test('an external link with a bare url still shows a label rather than nothing', () => {
  const [l] = linkedEntries({ docLinks: [{ id: 1, bType: 'GDOC', bNumber: 'x', url: 'https://drive.google.com/file/d/x' }] })
  assert.ok(l.label, 'a link with no label falls back to its identity')
})

// ── The trace object ────────────────────────────────────────────────────────

test('a trace never lists itself as related to itself', () => {
  const trace = buildTrace({
    subject: { docType: 'IF', docNumber: 'IF7486' },
    related: [...fulfillmentCards([{ ifNumber: 'IF7486', status: 'Shipped' }], []), orderCard({ soNumber: 'SO12296', customer: 'Four Seasons Maui' })],
  })
  assert.equal(trace.related.some((c) => c.docType === 'IF' && c.docNumber === 'IF7486'), false)
  assert.equal(trace.related.some((c) => c.docType === 'SO'), true)
})

test('history is passed through in the order it arrived, not re-sorted', () => {
  // The ledger's own timeline()/decorate() already ordered and labelled these.
  // Sorting again here is how a timeline starts disagreeing with the Ledger view.
  const history = [
    { occurredAt: '2026-08-20T00:00:00Z', label: 'Confirmed it left' },
    { occurredAt: '2026-08-13T00:00:00Z', label: 'Order imported' },
  ]
  const trace = buildTrace({ subject: { docType: 'SO', docNumber: 'SO12296' }, history })
  assert.deepEqual(trace.history.map((h) => h.label), ['Confirmed it left', 'Order imported'])
})

test('counts match the arrays actually rendered, after dedupe and self-removal', () => {
  const trace = buildTrace({
    subject: { docType: 'SO', docNumber: 'SO12296' },
    history: [{ label: 'a' }, { label: 'b' }],
    related: [
      ...fulfillmentCards([{ ifNumber: 'IF7486', invoiceNumber: 'INV1' }, { ifNumber: 'IF7487', invoiceNumber: 'INV1' }], []),
      ...taskCards([{ id: 58289, subject: 'Confirm departure', status: 'done', completedAt: '2026-08-20' }]),
    ],
    linked: { docLinks: [{ id: 1, bType: 'GDOC', bNumber: 'x', url: 'https://docs.google.com/d/x' }] },
    notes: [{ id: 1, note: 'Guest ships direct' }],
  })
  assert.equal(trace.counts.related, trace.related.length)
  assert.equal(trace.counts.history, 2)
  assert.equal(trace.counts.linked, 1)
  assert.equal(trace.counts.notes, 1)
  // 2 IFs + 1 deduped invoice mention + 1 task
  assert.equal(trace.related.length, 4)
})

test('the subject carries its own tone, type label and home view', () => {
  const trace = buildTrace({ subject: { docType: 'EMAIL', docNumber: 'abc' } })
  assert.equal(trace.subject.typeLabel, 'Transmission')
  assert.equal(trace.subject.view, 'transmissions')
  assert.ok(trace.subject.tone)
})

test('an empty trace is a valid trace, not a crash', () => {
  const trace = buildTrace({ subject: { docType: 'SO', docNumber: 'SO1' } })
  assert.deepEqual(trace.related, [])
  assert.deepEqual(trace.linked, [])
  assert.deepEqual(trace.notes, [])
  assert.equal(trace.counts.history, 0)
})

test('task and email cards keep their subject line as a title', () => {
  assert.equal(taskCards([{ id: 1, subject: 'Confirm departure', status: 'open' }])[0].title, 'Confirm departure')
  assert.equal(emailCards([{ id: 'a', subject: 'Tender accepted', fromName: 'Manhattan' }])[0].title, 'Tender accepted')
})

// ── The hop trail ───────────────────────────────────────────────────────────

test('the trail appends each new hop', () => {
  let trail = []
  trail = pushTrail(trail, { docType: 'EMAIL', docNumber: 'abc' })
  trail = pushTrail(trail, { docType: 'TASK', docNumber: '58289' })
  trail = pushTrail(trail, { docType: 'SO', docNumber: 'SO12296' })
  assert.deepEqual(trail.map((t) => t.docNumber), ['abc', '58289', 'SO12296'])
})

test('hopping back to something already on the trail rewinds instead of growing', () => {
  let trail = [{ docType: 'EMAIL', docNumber: 'abc' }, { docType: 'TASK', docNumber: '58289' }, { docType: 'SO', docNumber: 'SO12296' }]
  trail = pushTrail(trail, { docType: 'TASK', docNumber: '58289' })
  assert.deepEqual(trail.map((t) => t.docNumber), ['abc', '58289'])
})

test('the trail is capped so it cannot grow without bound', () => {
  let trail = []
  for (let i = 0; i < TRAIL_MAX + 4; i++) trail = pushTrail(trail, { docType: 'SO', docNumber: `SO${i}` })
  assert.equal(trail.length, TRAIL_MAX)
  assert.equal(trail.at(-1).docNumber, `SO${TRAIL_MAX + 3}`, 'the cap drops the oldest, never the current subject')
})
