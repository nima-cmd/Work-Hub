// test/pickTicketPdf.test.js — the pick ticket as a printable document.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPickTicketPdf, columnPlan, shortLoc, problemLine, pickTicketFilename, needsLandscape } from '../server/pickTicketPdf.js'

const ticket = (o = {}) => ({
  asked: ['7242978'], totalUnits: 684, skuCount: 2, salesOrders: 23, stores: 23,
  fetchedAt: '2026-09-01T16:56:00.000Z',
  poColumns: ['7242978'],
  pos: [{ po: '7242978', units: 684, verdict: 'ok' }],
  stockColumns: [
    { id: '7', name: "Warehouse Bulk : Bloomingdale's", isOrderLocation: true },
    { id: '2', name: 'Warehouse', isOrderLocation: false },
    { id: '3', name: 'Virtual Warehouse', isOrderLocation: false },
  ],
  stockKnown: true,
  skus: [
    { sku: 'SN03011NG-LAVENDER', total: 82, byPo: { 7242978: 82 }, onHand: { 7: 0, 2: 4, 3: 0 }, onHandTotal: 4, short: 78 },
    { sku: 'SN16044FN-CANYON', total: 25, byPo: { 7242978: 25 }, onHand: { 7: 0, 2: 20, 3: 33 }, onHandTotal: 53, short: 0 },
  ],
  shortSkus: [{ sku: 'SN03011NG-LAVENDER', need: 82, have: 4, short: 78 }],
  ...o,
})

test('it produces an actual PDF', async () => {
  // ⚠️ The whole point of this module: the old Print button called window.print() against
  // an app with no print stylesheet and produced nothing usable.
  const buf = await buildPickTicketPdf(ticket())
  assert.ok(buf.length > 1000)
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
})

test('⚠️ NO CHARACTER OUTSIDE WinAnsi REACHES THE PAGE', async () => {
  // pdfkit's built-in Helvetica cannot encode U+26A0; the first render printed every "⚠"
  // as "&", so the warning lines read "& PO 40847685 — all closed". Anything outside
  // WinAnsi is silently mangled rather than throwing, so it has to be asserted.
  const strings = [
    problemLine({ verdict: 'missing', po: 'X' }),
    problemLine({ verdict: 'allClosed', po: 'X', salesOrders: 2, cancelledUnits: 290 }),
    problemLine({ verdict: 'empty', po: 'X', salesOrders: 1 }),
    ...columnPlan(ticket(), 540).map((c) => c.label),
  ]
  for (const s of strings) {
    // The middle dot (U+00B7) IS in WinAnsi and is used in the stats line; the test is
    // for the characters above it.
    assert.doesNotMatch(s, /[←-⯿]/, `non-WinAnsi glyph in: ${s}`)
  }
})

test("the order's own location is marked, and the mark survives truncation", () => {
  // The first render sheared " *" off the page: shortLoc kept 12 characters and the
  // marker plus ellipsis did not fit a 62pt column.
  const cols = columnPlan(ticket(), 540)
  const loc = cols.find((c) => c.key === 'loc:7')
  assert.ok(loc.label.endsWith(' *'), loc.label)
  assert.ok(loc.label.length <= 13, `${loc.label} is ${loc.label.length} chars`)
})

test('⚠️ the LEAF of a location name is kept, never the parent', () => {
  // "Warehouse Bulk" is identical for all seven partner buckets — keeping the parent
  // would make Nordstrom and Bloomingdale's the same column.
  assert.equal(shortLoc("Warehouse Bulk : Bloomingdale's"), 'Bloomingd.')
  assert.equal(shortLoc('Warehouse Bulk : Nordstrom'), 'Nordstrom')
  assert.equal(shortLoc('Warehouse'), 'Warehouse')
  assert.equal(shortLoc('Virtual Warehouse'), 'Virtual WH')
})

test('a single-PO ticket does not print its total twice', () => {
  const cols = columnPlan(ticket(), 540).map((c) => c.key)
  assert.ok(!cols.some((k) => k.startsWith('po:')))
  assert.deepEqual(cols, ['sku', 'need', 'loc:7', 'loc:2', 'loc:3', 'short'])
})

test('several POs each get a column', () => {
  const cols = columnPlan(ticket({ poColumns: ['A', 'B'] }), 540).map((c) => c.key)
  assert.deepEqual(cols.slice(0, 3), ['sku', 'po:A', 'po:B'])
})

test('⚠️ an unknown stock column prints "?", never 0', () => {
  const cols = columnPlan(ticket({ stockKnown: false }), 540)
  const loc = cols.find((c) => c.key === 'loc:2')
  assert.equal(loc.get({ onHand: {} }), '?')
})

test('a zero on hand prints as 0 — blank would read as "not looked at"', () => {
  const loc = columnPlan(ticket(), 540).find((c) => c.key === 'loc:7')
  assert.equal(loc.get({ onHand: { 7: 0 } }), '0')
})

test('the SHORT column is blank unless there is a shortfall', () => {
  const short = columnPlan(ticket(), 540).find((c) => c.key === 'short')
  assert.equal(short.get({ short: 0 }), '')
  assert.equal(short.get({ short: 78 }), 78)
})

test('a wide ticket turns landscape rather than running off the page', () => {
  assert.equal(needsLandscape(ticket()), false)
  assert.equal(needsLandscape(ticket({ poColumns: ['A', 'B', 'C', 'D'] })), true)
})

test('the filename names the POs, and survives a PO with punctuation in it', () => {
  // NetSuite's otherrefnum is free text — "POJ00384244 | Closed" is a real live value.
  assert.equal(pickTicketFilename(ticket()), 'PickTicket_7242978.pdf')
  assert.equal(pickTicketFilename(ticket({ asked: ['POJ00384244 | Closed'] })), 'PickTicket_POJ00384244Closed.pdf')
})

test('it still renders when the stock lookup failed', async () => {
  const buf = await buildPickTicketPdf(ticket({ stockKnown: false, shortSkus: [] }))
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
})

test('it renders an empty ticket rather than throwing', async () => {
  const buf = await buildPickTicketPdf({ asked: ['X'], skus: [], pos: [{ po: 'X', verdict: 'missing' }], totalUnits: 0 })
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
})
