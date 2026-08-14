import test from 'node:test'
import assert from 'node:assert/strict'
import { matchesQuery, searchableText, indexCards, describeMatch } from '../src/model/cardSearch.js'

const card = (over = {}) => ({
  soNumber: 'SO12440', poNumber: '8298615', customer: "Bloomingdale's - 0001 59th St. - New York",
  dc: 'SC', stage: 'SHIPPED', source: 'edi',
  fulfillments: [{ ifNumber: 'IF7511', invoice: 'INV11402' }],
  invoices: [{ invNumber: 'INV11402' }],
  flags: [{ key: 'NEEDS_LABEL', label: 'needs a label' }],
  ...over,
})

// ⚠️ THE POINT. The board is keyed on the sales order, but nothing arriving from
// outside is: the warehouse holds paperwork showing an IF, a partner quotes a PO, a
// carrier quotes a tracking number. Searching only soNumber would answer none of them.
test('finds a card by any identifier a person might arrive holding', () => {
  for (const q of ['SO12440', '8298615', 'IF7511', 'INV11402', 'Bloomingdale', 'SC']) {
    assert.equal(matchesQuery(card(), q), true, `should match ${q}`)
  }
})

// ⚠️ The IF is the MOST likely thing to be typed and it is not a property of the order
// at all — it lives on a child document.
test('an IF number matches even though it belongs to a fulfilment', () => {
  assert.equal(matchesQuery(card(), 'IF7511'), true)
  assert.equal(matchesQuery(card(), 'IF9999'), false)
})

// NetSuite prints IF7511, people write "if 7511", a PO arrives as "PO 8298615".
test('prefixes and punctuation are optional', () => {
  assert.equal(matchesQuery(card(), 'if 7511'), true)
  assert.equal(matchesQuery(card(), '7511'), true)
  assert.equal(matchesQuery(card(), 'PO 8298615'), true)
  assert.equal(matchesQuery(card(), 'so-12440'), true)
})

test('matching is case-insensitive', () => {
  assert.equal(matchesQuery(card(), 'bloomingdales'), true)
  assert.equal(matchesQuery(card(), 'BLOOMINGDALE'), true)
})

// Two words means "narrow it", not "widen it" — and each may hit a different field.
test('multiple words are ANDed across fields', () => {
  assert.equal(matchesQuery(card(), 'bloomingdale 7511'), true)
  assert.equal(matchesQuery(card(), 'bloomingdale nordstrom'), false)
})

// The words on a flag are what people actually remember.
test('flag wording is searchable, so "label" finds everything needing one', () => {
  assert.equal(matchesQuery(card(), 'label'), true)
  assert.equal(matchesQuery(card({ flags: [] }), 'label'), false)
})

test('an empty query matches everything, so the board is never accidentally empty', () => {
  for (const q of ['', '   ', null, undefined]) assert.equal(matchesQuery(card(), q), true)
})

test('a card missing most fields does not throw', () => {
  assert.equal(matchesQuery({}, 'anything'), false)
  assert.equal(matchesQuery({}, ''), true)
  assert.deepEqual(searchableText({}), [])
})

test('indexing is idempotent and reused', () => {
  const [c] = indexCards([card()])
  assert.ok(c.__search.length > 5)
  const again = indexCards([c])[0]
  assert.equal(again.__search, c.__search)
})

// ⚠️ A shorter list with no explanation is indistinguishable from data loss — the
// failure mode this app keeps hitting.
test('the result always explains itself', () => {
  assert.equal(describeMatch({ shown: 3, total: 26, query: 'IF75' }), '3 of 26 match “IF75”')
  assert.equal(describeMatch({ shown: 0, total: 26, query: 'zzz' }), 'nothing matches “zzz”')
  assert.equal(describeMatch({ shown: 26, total: 26, query: '' }), null)
})

// ⚠️ EDI orders are grouped by PO, so the card standing in for SO12440 is called
// 8298615 and its own soNumber is the PO. Searching the sales order a person actually
// has in front of them must still find it.
test('a grouped EDI card is found by any of its member sales orders', () => {
  const group = {
    isGroup: true, soNumber: '8298615', poNumber: '8298615',
    soNumbers: ['SO12440', 'SO12441'],
    members: [{ soNumber: 'SO12440', customer: "Bloomingdale's - 59th St" }],
    fulfillments: [{ ifNumber: 'IF7511' }],
  }
  assert.equal(matchesQuery(group, 'SO12440'), true)
  assert.equal(matchesQuery(group, 'SO12441'), true)
  assert.equal(matchesQuery(group, '59th'), true)
  assert.equal(matchesQuery(group, 'SO99999'), false)
})
