import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePushReports } from '../src/model/pushReport.js'

const freight = { ok: true, pushed: 2, failed: 1, candidates: 3, recorded: 2,
  results: [{ orderKey: 'WH-BOL1' }, { orderKey: 'WH-BOL2' }],
  skipped: [{ bolNumber: 'NB1', reason: 'Warehouse' }] }
const parcel = { ok: true, pushed: 1, failed: 0, candidates: 1, recorded: 1, seen: 1,
  results: [{ orderKey: 'WH-IF7533', orderNumber: 'POJ00384243' }], skipped: [] }

test('every total covers BOTH lanes — the bug this module exists to stop', () => {
  const m = mergePushReports(freight, parcel, { scope: 'edi' })
  assert.equal(m.pushed, 3, '2 freight + 1 parcel')
  assert.equal(m.failed, 1)
  assert.equal(m.candidates, 4)
  assert.equal(m.recorded, 3)
  assert.equal(m.results.length, 3)
})

test('⚠️ the spread must not shadow the sums', () => {
  // If `...freight` were applied AFTER the arithmetic, pushed would read 2 — one
  // lane's number under a label covering two.
  const m = mergePushReports(freight, parcel, { scope: 'edi' })
  assert.notEqual(m.pushed, freight.pushed, 'not the freight number alone')
  assert.notEqual(m.pushed, parcel.pushed, 'and not the parcel number alone')
})

test('extra fields from the caller survive, but never overwrite a total', () => {
  const m = mergePushReports(freight, parcel, { scope: 'edi', shipments: 5, pushed: 999 })
  assert.equal(m.scope, 'edi')
  assert.equal(m.shipments, 5)
  assert.equal(m.pushed, 3, 'a caller cannot clobber the computed total')
})

test('skipped rows from both lanes are kept, with their reasons intact', () => {
  const p2 = { ...parcel, skipped: [{ ifNumber: 'IF7412', hold: 'PACKED_NO_LABEL', reason: 'needs a human' }] }
  const m = mergePushReports(freight, p2, {})
  assert.equal(m.skipped.length, 2)
  assert.ok(m.skipped.every((s) => s.reason), 'a reason-less skip answers no question')
})

test('no parcel pass at all → totals are the freight numbers, and parcelLane is null', () => {
  const m = mergePushReports(freight, null, { scope: 'edi' })
  assert.equal(m.pushed, 2)
  assert.equal(m.candidates, 3)
  assert.equal(m.parcelLane, null, 'null, not a zeroed object that looks like it ran')
})

test('the sub-report attributes the total to a lane', () => {
  const m = mergePushReports(freight, parcel, {})
  assert.deepEqual(m.parcelLane, { candidates: 1, pushed: 1, seen: 1, skipped: 0 })
})

test('missing or junk numbers coerce to 0 rather than producing NaN', () => {
  // A NaN total renders as "NaN pushed", which reads as a broken app rather than a
  // missing field — and pg hands counts back as strings.
  const m = mergePushReports({ pushed: '2' }, { pushed: undefined, candidates: 'x' }, {})
  assert.equal(m.pushed, 2)
  assert.equal(m.candidates, 0)
  assert.ok(!Number.isNaN(m.pushed))
})
