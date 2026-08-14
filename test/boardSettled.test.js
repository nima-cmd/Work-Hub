import test from 'node:test'
import assert from 'node:assert/strict'
import { boardSettled, NET_FLOW_EPOCH } from '../src/model/netDeparture.js'
import { netTerms } from '../src/model/paymentGate.js'

const opts = { netTerms }
const base = { status: 'Shipped', invoiceNumber: 'INV1', source: 'boutique', terms: null, shipDate: '2026-07-10' }

// Nima, 2026-08-14: Mission Quests should show "what currently needs work" — a shipped
// and invoiced order is not work.
test('shipped and invoiced is settled', () => {
  assert.equal(boardSettled(base, opts).settled, true)
})

// ⚠️ The line between decluttering and HIDING work. 19 fulfilments are shipped with no
// invoice, including the "shipped, still owed" case that sat 24 days.
test('shipped WITHOUT an invoice is never settled', () => {
  const r = boardSettled({ ...base, invoiceNumber: null }, opts)
  assert.equal(r.settled, false)
  assert.match(r.reason, /needs an invoice/)
})

test('not shipped is never settled', () => {
  assert.equal(boardSettled({ ...base, status: 'Picked' }, opts).settled, false)
  assert.equal(boardSettled({ ...base, status: 'Packed' }, opts).settled, false)
})

// Under the Net flow, marking shipped happens when the LABEL is made and proves
// nothing moved — so it stays until a human confirms departure.
test('a Net-terms order inside the new flow waits for confirmation', () => {
  const r = boardSettled({ ...base, terms: 'Net 30', shipDate: '2026-08-13' }, opts)
  assert.equal(r.settled, false)
  assert.match(r.reason, /confirm it actually left/)
})

test('...and is settled once departure is confirmed', () => {
  const r = boardSettled({
    ...base, terms: 'Net 30', shipDate: '2026-08-13',
    departureConfirmedAt: '2026-08-14T10:00:00Z',
  }, opts)
  assert.equal(r.settled, true)
})

// ⚠️ THE TRAP. Departure confirmation has a 2026-08-12 epoch, so a Net-terms order
// shipped before it can NEVER be confirmed. Treating those as "awaiting confirmation"
// would pin 137 cards to the board permanently — the exact clutter being removed.
// Nima: "if this predate the app ... we know it has departed."
test('a PRE-EPOCH Net-terms order is settled, because it can never be confirmed', () => {
  const r = boardSettled({ ...base, terms: 'Net 30', shipDate: '2026-08-01' }, opts)
  assert.equal(r.settled, true)
  assert.ok(new Date('2026-08-01') < new Date(NET_FLOW_EPOCH))
})

// ⚠️ orders.terms only began being captured on 2026-08-13 (PR #91). Blank means "before
// we recorded terms", not "no terms" — and all 16 live blanks are boutique orders
// shipped 5+ weeks earlier, every one invoiced. Holding them would pin them forever.
test('terms we never captured are not Net terms', () => {
  assert.equal(boardSettled({ ...base, terms: null }, opts).settled, true)
  assert.equal(boardSettled({ ...base, terms: '' }, opts).settled, true)
})

// EDI never enters the Net flow — inNetFlow excludes it outright.
test('an EDI fulfilment is settled on shipped + invoiced alone', () => {
  const r = boardSettled({ ...base, source: 'edi', terms: 'Net 30', shipDate: '2026-08-13' }, opts)
  assert.equal(r.settled, true)
})

test('a kept card always says why it was kept', () => {
  for (const f of [{ ...base, status: 'Picked' }, { ...base, invoiceNumber: null },
    { ...base, terms: 'Net 30', shipDate: '2026-08-13' }]) {
    const r = boardSettled(f, opts)
    assert.equal(r.settled, false)
    assert.ok(r.reason && r.reason.length > 5)
  }
})
