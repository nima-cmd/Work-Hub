import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filingTarget, filingNote, splitUnfiled, daysBetween, FILING_LEDGER_START,
} from '../src/model/filing.js'
import { SPINE, DERIVED_TYPES } from '../src/model/orderEvents.js'

// ── filingTarget ─────────────────────────────────────────────────────────────

test('a boutique slip files against its fulfilment', () => {
  const t = filingTarget({ kind: 'slip', ifNumber: 'IF7441', soNumber: 'SO12293', customer: 'I Am More' })
  assert.deepEqual(t, { docType: 'IF', docNumber: 'IF7441', soNumber: 'SO12293' })
})

test('an EDI slip with an IF QR files against the fulfilment, not the PO', () => {
  // The whole point of the IF-in-the-QR change: one PO/DC pair carries several
  // fulfilments, so filing at PO level would mark all of them done at once.
  const t = filingTarget({ kind: 'edi', po: '7776940', dc: 'SBX2', ifNumber: 'IF7452' })
  assert.equal(t.docType, 'IF')
  assert.equal(t.docNumber, 'IF7452')
})

test('an old bare-PO tag with no IF falls back to the DC doc key', () => {
  // Same key shape the custody DC scans use, so both land on one timeline.
  const t = filingTarget({ kind: 'edi', po: '7776940', dc: 'SBX2' })
  assert.deepEqual(t, { docType: 'DC', docNumber: '7776940:SBX2', soNumber: null })
})

test('a PO with no DC still produces a stable key', () => {
  assert.equal(filingTarget({ kind: 'edi', po: '6049324' }).docNumber, '6049324:')
})

test('the IF number is normalised to upper case', () => {
  assert.equal(filingTarget({ ifNumber: 'if7441' }).docNumber, 'IF7441')
})

test('the master BOL gets no filing event', () => {
  // It covers several POs and is nobody's packing slip. Recording it against
  // every covered PO would mark them all filed on a document that isn't theirs.
  assert.equal(filingTarget({ partner: "Bloomingdale's", pos: ['7776940', '7776941'], filename: 'X master BOL.pdf' }), null)
})

test('a skipped document is never recorded as filed', () => {
  // It was held back precisely because we could not place it — the queue must
  // keep nagging about it.
  assert.equal(filingTarget({ kind: 'slip', ifNumber: 'IF7441', skip: true }), null)
})

test('an unresolvable document produces no target rather than a guess', () => {
  assert.equal(filingTarget({ kind: 'boutique', raw: 'GIBBERISH' }), null)
  assert.equal(filingTarget({}), null)
  assert.equal(filingTarget(null), null)
})

// ── filingNote ───────────────────────────────────────────────────────────────

test('the note names the file and where it went', () => {
  assert.equal(
    filingNote({ filename: 'IF7441.pdf', partner: 'I Am More', pos: ['SO12293'] }),
    'IF7441.pdf → I Am More/SO12293',
  )
})

test('the note degrades rather than rendering empty separators', () => {
  assert.equal(filingNote({ filename: 'IF7441.pdf' }), 'IF7441.pdf')
  assert.equal(filingNote({}), null)
})

// ── the epoch split ──────────────────────────────────────────────────────────

const NOW = new Date('2026-08-12T12:00:00Z')
const START = '2026-08-02'

test('shipments from before the epoch are backlog, not overdue work', () => {
  // The load-bearing decision. On day one 91 shipments have no FILED event
  // because none was ever written — surfacing them as work would open the chip
  // at 91 and get the whole strip ignored.
  const r = splitUnfiled([
    { ifNumber: 'IF7287', shippedAt: '2026-07-27' },
    { ifNumber: 'IF7500', shippedAt: '2026-08-05' },
  ], { start: START, now: NOW })
  assert.deepEqual(r.counts, { due: 1, backlog: 1 })
  assert.equal(r.due[0].ifNumber, 'IF7500')
  assert.equal(r.backlog[0].ifNumber, 'IF7287')
})

test('a shipment that left ON the epoch day counts as due', () => {
  const r = splitUnfiled([{ ifNumber: 'IF7490', shippedAt: '2026-08-02' }], { start: START, now: NOW })
  assert.equal(r.counts.due, 1)
})

test('an undated shipment goes to backlog, never to due', () => {
  // Calling an undated shipment overdue is a guess, and this module exists to
  // not make those.
  const r = splitUnfiled([{ ifNumber: 'IF7190', shippedAt: null }], { start: START, now: NOW })
  assert.deepEqual(r.counts, { due: 0, backlog: 1 })
  assert.equal(r.backlog[0].ageDays, null)
})

test('an unparseable ship date does not silently become due', () => {
  // An Invalid Date compares false against everything, so a naive >= would drop
  // it into whichever branch fell through.
  const r = splitUnfiled([{ ifNumber: 'IF9999', shippedAt: 'not a date' }], { start: START, now: NOW })
  assert.equal(r.counts.due, 0)
  assert.equal(r.counts.backlog, 1)
})

test('both lists are oldest-first so the worst offender reads at the top', () => {
  const r = splitUnfiled([
    { ifNumber: 'IF7502', shippedAt: '2026-08-10' },
    { ifNumber: 'IF7500', shippedAt: '2026-08-03' },
    { ifNumber: 'IF7501', shippedAt: '2026-08-06' },
  ], { start: START, now: NOW })
  assert.deepEqual(r.due.map((d) => d.ifNumber), ['IF7500', 'IF7501', 'IF7502'])
  assert.equal(r.due[0].ageDays, 9)
})

test('an empty set reports zero rather than throwing', () => {
  const r = splitUnfiled([], { start: START, now: NOW })
  assert.deepEqual(r.counts, { due: 0, backlog: 0 })
  assert.equal(r.since, START)
})

test('the epoch is reported back so the UI can name the start date', () => {
  assert.equal(splitUnfiled([]).since, FILING_LEDGER_START)
})

test('daysBetween returns null rather than NaN for a missing end', () => {
  assert.equal(daysBetween(null, NOW), null)
  assert.equal(daysBetween('2026-08-10T00:00:00Z', NOW), 2)
})

// ── the spine ────────────────────────────────────────────────────────────────

test('FILED is in the spine but is not derived', () => {
  // Nothing in NetSuite or Orderful knows the paper exists, so deriving it from
  // a table snapshot is impossible — and listing it in DERIVED_TYPES would let
  // a sync double-write or, worse, invent it.
  assert.ok(SPINE.some((s) => s.key === 'FILED'))
  assert.ok(!DERIVED_TYPES.includes('FILED'))
})
