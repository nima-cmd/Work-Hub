// The custody chain, and where a shipment fell out of it. The spec is Nima's workflow
// (2026-08-06): the scan happens AS THE SLIP PRINTS, so a fulfilment with no scan out
// isn't late — it was never handed over.

import test from 'node:test'
import assert from 'node:assert/strict'
import { scanGapFor, summarizeScanGaps, SCAN_GAP, OUT_STALE_DAYS } from '../src/model/scanGap.js'

const TODAY = new Date('2026-08-06T15:00:00Z')

test('made today and not yet scanned is NOT a gap', () => {
  // The scan belongs at the printer, but this afternoon is still this afternoon.
  const v = scanGapFor({ ifNumber: 'IF9001', ifDate: '2026-08-06', today: TODAY })
  assert.equal(v.ok, true)
  assert.equal(v.kind, SCAN_GAP.OK)
  assert.match(v.reason, /made today/)
})

test('yesterday with no scan is already broken', () => {
  // Not "late by the register's 3 days" — the workflow says it should have been handed
  // over as it printed, so a day old with no scan means the thread was dropped.
  const v = scanGapFor({ ifNumber: 'IF9001', ifDate: '2026-08-05', today: TODAY })
  assert.equal(v.kind, SCAN_GAP.NEVER_SCANNED)
  assert.equal(v.ageDays, 1)
  assert.match(v.reason, /never scanned out — it was never handed over/)
})

test('the live 16-day Nordstrom case', () => {
  // IF7350/7351/7352, dated 2026-07-21, never scanned, invisible to the register.
  const v = scanGapFor({ ifNumber: 'IF7350', ifDate: '2026-07-21', today: TODAY })
  assert.equal(v.kind, SCAN_GAP.NEVER_SCANNED)
  assert.equal(v.ageDays, 16)
})

test('scanned out and back is fine, however old', () => {
  const v = scanGapFor({
    ifNumber: 'IF9001', ifDate: '2026-07-01',
    outAt: '2026-07-02T10:00:00Z', inAt: '2026-07-03T10:00:00Z', today: TODAY,
  })
  assert.equal(v.ok, true)
  assert.equal(v.kind, SCAN_GAP.BACK_WITH_US)
})

test('out with Nestor is quiet at first, then asks for it', () => {
  const fresh = scanGapFor({ ifNumber: 'IF9001', ifDate: '2026-08-04', outAt: '2026-08-05T10:00:00Z', today: TODAY })
  assert.equal(fresh.kind, SCAN_GAP.OUT_NOT_BACK)
  assert.equal(fresh.ok, true)          // 1 day out — normal handling
  assert.equal(fresh.stale, false)      // (was a tautology on first write — it passed either way)

  const stale = scanGapFor({ ifNumber: 'IF9001', ifDate: '2026-07-28', outAt: '2026-08-01T10:00:00Z', today: TODAY })
  assert.equal(stale.kind, SCAN_GAP.OUT_NOT_BACK)
  assert.equal(stale.stale, true)
  assert.equal(stale.ageDays, 5)
  assert.match(stale.reason, /never scanned back — ask for it/)
})

test('the out threshold matches the register, so two surfaces cannot disagree', () => {
  const at = (d) => scanGapFor({ ifNumber: 'X', ifDate: '2026-07-01', outAt: d, today: TODAY })
  assert.equal(OUT_STALE_DAYS, 3)
  assert.equal(at('2026-08-04T10:00:00Z').stale, false)   // 2 days
  assert.equal(at('2026-08-03T10:00:00Z').stale, true)    // 3 days
})

test('⚠️ a RE-handout counts from the latest OUT, not the first', () => {
  // Scanned out, returned, then handed out again after a fix. The second OUT is what
  // decides — using the first would report it overdue on the strength of old history.
  const v = scanGapFor({
    ifNumber: 'IF9001', ifDate: '2026-07-01',
    outAt: '2026-08-05T14:00:00Z', inAt: '2026-07-05T10:00:00Z', today: TODAY,
  })
  assert.equal(v.kind, SCAN_GAP.OUT_NOT_BACK)
  assert.equal(v.ageDays, 1)
  assert.equal(v.stale, false)
})

test('no fulfilment date stays SILENT rather than guessing', () => {
  const v = scanGapFor({ ifNumber: 'IF9001', ifDate: null, today: TODAY })
  assert.equal(v.ok, true)
  assert.match(v.reason, /no fulfilment date/)
})

test('the summary counts broken threads and excludes what we already hold', () => {
  const counts = summarizeScanGaps([
    { kind: SCAN_GAP.NEVER_SCANNED }, { kind: SCAN_GAP.NEVER_SCANNED },
    { kind: SCAN_GAP.OUT_NOT_BACK, stale: true },
    { kind: SCAN_GAP.OUT_NOT_BACK, stale: false },
    { kind: SCAN_GAP.BACK_WITH_US }, { kind: SCAN_GAP.BACK_WITH_US }, { kind: SCAN_GAP.BACK_WITH_US },
    { kind: SCAN_GAP.OK },
  ])
  assert.equal(counts.neverScanned, 2)
  assert.equal(counts.outNotBack, 2)
  assert.equal(counts.outStale, 1)
  assert.equal(counts.backWithUs, 3)
  // ⚠️ broken = never handed over + overdue at Nestor. Things in OUR hands are excluded:
  // labelGap and the ship desk own those, and two surfaces instructing the same order
  // differently is the defect this repo keeps re-finding.
  assert.equal(counts.broken, 3)
})

test('garbage input is never a gap', () => {
  for (const a of [undefined, {}, { ifNumber: 'X' }]) assert.equal(scanGapFor(a).ok, true)
})

// ⚠️ THE CORRECTION THAT MATTERED MOST. The first version of this model read only
// doc_type='IF' events and reported 28 broken threads — and ALL 28 WERE FALSE. Every one
// was a Nordstrom fulfilment whose per-DC cargo tag had been scanned: the goods went out
// together on the tag, exactly as designed. Caught only by asking why 28 of 28 hits came
// from a single lane. Same shape as labelGap's freight and FOB lanes.
test('a cargo-tag scan accounts for an EDI fulfilment with no IF scan', () => {
  const v = scanGapFor({
    ifNumber: 'IF7350', ifDate: '2026-07-21',
    outAt: null, inAt: null,
    dcOutAt: '2026-07-27T10:00:00Z', dcInAt: '2026-07-28T10:00:00Z',
    today: TODAY,
  })
  assert.equal(v.ok, true)
  assert.equal(v.kind, SCAN_GAP.BACK_WITH_US)
  assert.equal(v.basis, 'DC')
  assert.match(v.reason, /on its cargo tag/)
})

test('a cargo tag still out reports with-Nestor, not never-handed-over', () => {
  const v = scanGapFor({
    ifNumber: 'IF7415', ifDate: '2026-07-29', dcOutAt: '2026-07-30T10:00:00Z', today: TODAY,
  })
  assert.equal(v.kind, SCAN_GAP.OUT_NOT_BACK)
  assert.equal(v.basis, 'DC')
  assert.equal(v.stale, true)
})

test('the IF scan WINS over the cargo tag when both exist', () => {
  // The per-fulfilment scan is the tighter evidence, so it decides — and its dates are
  // the ones reported, not the tag's.
  const v = scanGapFor({
    ifNumber: 'IF9001', ifDate: '2026-07-01',
    outAt: '2026-08-05T10:00:00Z', inAt: null,
    dcOutAt: '2026-07-02T10:00:00Z', dcInAt: '2026-07-03T10:00:00Z',
    today: TODAY,
  })
  assert.equal(v.kind, SCAN_GAP.OUT_NOT_BACK)   // NOT back, per the IF's own evidence
  assert.equal(v.basis, 'IF')
  assert.equal(v.ageDays, 1)
})

test('neither route scanned is still a broken thread', () => {
  const v = scanGapFor({ ifNumber: 'IF9001', ifDate: '2026-07-01', today: TODAY })
  assert.equal(v.kind, SCAN_GAP.NEVER_SCANNED)
  assert.equal(v.basis, null)
})
