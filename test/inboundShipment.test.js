// test/inboundShipment.test.js — a vessel between two dates.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  inferMode, transitDays, transitStats, estimateEta, shipmentState,
  describeShipment, shipmentBoard, sourceWins, MIN_SAMPLES,
} from '../src/model/inboundShipment.js'

const TODAY = new Date('2026-09-09T12:00:00Z')

test('mode is inferred from the labels this account really uses — and flagged', () => {
  assert.deepEqual(inferMode('11 Air 1820 1777 air list carton 2026.9.7'), { mode: 'air', inferred: true })
  assert.deepEqual(inferMode('1 air carton 2026.8.8'), { mode: 'air', inferred: true })
  assert.deepEqual(inferMode('321 carton 2026.7.10'), { mode: 'sea', inferred: true })
  assert.deepEqual(inferMode('55 carton 2026.9.7'), { mode: 'sea', inferred: true })
  // ⚠️ Never guessed into a mode. Mode picks which transit average applies, so a
  // wrong one moves an ETA by weeks.
  assert.equal(inferMode('PO1616Transfer').mode, null)
  assert.equal(inferMode('').mode, null)
})

test('⚠️ TRANSIT TIME NEEDS AN OBSERVED ARRIVAL, never an estimate', () => {
  assert.equal(transitDays({ departedOn: '2026-08-08', arrivedOn: '2026-08-10' }), 2)
  // An estimated ETA is not evidence of anything. Feeding it back would make the
  // model converge on its own first guess and grow confident doing it.
  assert.equal(transitDays({ departedOn: '2026-08-08', etaOn: '2026-08-10' }), null)
  assert.equal(transitDays({ arrivedOn: '2026-08-10' }), null)
})

const observed = [
  { containerLabel: '1 air', mode: 'air', departedOn: '2026-08-08', arrivedOn: '2026-08-10' },
  { containerLabel: '2 air', mode: 'air', departedOn: '2026-06-09', arrivedOn: '2026-06-12' },
  { containerLabel: '3 air', mode: 'air', departedOn: '2026-05-01', arrivedOn: '2026-05-03' },
  { containerLabel: '16 carton', mode: 'sea', departedOn: '2026-07-09', arrivedOn: '2026-07-25' },
  { containerLabel: '264 carton', mode: 'sea', departedOn: '2026-06-18', arrivedOn: '2026-07-06' },
  { containerLabel: '39 carton', mode: 'sea', departedOn: '2026-05-22', arrivedOn: '2026-06-12' },
]

test('⚠️ MEDIAN NOT MEAN, and the spread is reported alongside it', () => {
  const { stats } = transitStats(observed)
  assert.equal(stats.air.n, 3)
  assert.equal(stats.air.median, 2)
  assert.equal(stats.air.spread, 1)
  assert.equal(stats.air.enough, true)
  assert.equal(stats.sea.median, 18)
  // One vessel stuck at customs must not drag the expectation for every other.
  const withOutlier = transitStats([...observed, { containerLabel: 'held', mode: 'sea', departedOn: '2026-01-01', arrivedOn: '2026-04-01' }])
  // 16/18/21 days, plus one vessel held 90. Median 18 -> 20. The MEAN would be 36 —
  // an expectation that matches nothing that has ever actually happened.
  assert.equal(withOutlier.stats.sea.median, 20, 'the median moves 2 days; a mean would move 18')
  assert.equal(withOutlier.stats.sea.max, 90)
  assert.equal(withOutlier.stats.sea.spread, 74, 'and the spread makes the outlier visible')
})

test('a shipment with no mode is an anomaly, not silently averaged in', () => {
  const { stats, anomalies } = transitStats([
    ...observed,
    { containerLabel: 'mystery', mode: null, departedOn: '2026-07-01', arrivedOn: '2026-07-10' },
  ])
  assert.equal(stats.air.n, 3)
  assert.equal(anomalies.length, 1)
  assert.match(anomalies[0].reason, /cannot be attributed/)
})

test('arriving before departing is reported, never clamped to a same-day arrival', () => {
  const { anomalies } = transitStats([{ containerLabel: 'x', mode: 'sea', departedOn: '2026-07-10', arrivedOn: '2026-07-01' }])
  assert.match(anomalies[0].reason, /before it departed/)
  assert.equal(anomalies[0].days, -9)
})

test(`⚠️ UNDER ${MIN_SAMPLES} OBSERVED ARRIVALS THERE IS NO ESTIMATE`, () => {
  // Two containers agreeing is a coincidence. A screen saying "unknown" is worth
  // more than one saying a date it made up.
  const thin = transitStats(observed.slice(0, 2)).stats
  assert.equal(estimateEta({ mode: 'air', departedOn: '2026-09-09' }, thin), null)
  const full = transitStats(observed).stats
  assert.equal(estimateEta({ mode: 'air', departedOn: '2026-09-09' }, full).etaOn, '2026-09-11')
})

test('an estimate always carries its basis and its confidence', () => {
  const { stats } = transitStats(observed)
  const air = estimateEta({ mode: 'air', departedOn: '2026-09-09' }, stats)
  assert.equal(air.source, 'estimate')
  assert.match(air.basis, /median of 3 observed air arrivals \(2-3 days\)/)
  assert.equal(air.confidence, 'tight')
  const sea = estimateEta({ mode: 'sea', departedOn: '2026-09-09' }, stats)
  assert.equal(sea.confidence, 'loose', '16-21 days is a range, and says so')
})

test('no mode and no departure date each mean no estimate at all', () => {
  const { stats } = transitStats(observed)
  assert.equal(estimateEta({ mode: null, departedOn: '2026-09-09' }, stats), null)
  assert.equal(estimateEta({ mode: 'air' }, stats), null)
})

test('⚠️ "no eta" IS ITS OWN STATE — the vessel nobody can date is the forgotten one', () => {
  const s = shipmentState({ departedOn: '2026-09-01', mode: null }, TODAY)
  assert.equal(s.state, 'no eta')
  assert.equal(s.attention, true)
  assert.match(s.note, /air or sea/)
  assert.equal(s.daysOut, 8)
})

test('overdue admits it might just be unmarked', () => {
  // ⚠️ Nothing here observes a vessel. An arrival that happened and was never marked
  // reads exactly like one that has not happened, and the first stale card teaches
  // everyone to ignore the list.
  const s = shipmentState({ departedOn: '2026-08-20', etaOn: '2026-09-05', etaSource: 'estimate' }, TODAY)
  assert.equal(s.state, 'overdue')
  assert.equal(s.daysLate, 4)
  assert.match(s.note, /ESTIMATED/)
  assert.match(s.note, /never marked/)
})

test('due today, in transit and arrived', () => {
  assert.equal(shipmentState({ departedOn: '2026-09-01', etaOn: '2026-09-09' }, TODAY).state, 'due today')
  const t = shipmentState({ departedOn: '2026-09-01', etaOn: '2026-09-14' }, TODAY)
  assert.equal(t.state, 'in transit')
  assert.equal(t.daysToEta, 5)
  const a = shipmentState({ departedOn: '2026-09-07', arrivedOn: '2026-09-09' }, TODAY)
  assert.equal(a.state, 'arrived')
  assert.equal(a.transitDays, 2)
  assert.equal(a.attention, false)
})

test('⚠️ AN ESTIMATE NEVER OVERWRITES AN ENTERED DATE', () => {
  assert.equal(sourceWins('estimate', 'entered'), false)
  assert.equal(sourceWins('entered', 'estimate'), true)
  assert.equal(sourceWins('email', 'estimate'), true)
  assert.equal(sourceWins('estimate', null), true, 'but it does fill a gap')

  const { stats } = transitStats(observed)
  const kept = describeShipment(
    { containerLabel: '11 Air', mode: 'air', departedOn: '2026-09-09', etaOn: '2026-09-20', etaSource: 'entered' },
    stats, TODAY,
  )
  assert.equal(kept.etaOn, '2026-09-20', 'the entered date survives')
  assert.equal(kept.etaSource, 'entered')

  const filled = describeShipment(
    { containerLabel: '11 Air', mode: 'air', departedOn: '2026-09-09' }, stats, TODAY,
  )
  assert.equal(filled.etaOn, '2026-09-11')
  assert.equal(filled.etaSource, 'estimate')
  assert.match(filled.etaBasis, /median of 3/)
})

test('the board sorts by what needs attention and counts from the resolved state', () => {
  const { stats } = transitStats(observed)
  const board = shipmentBoard([
    ...observed,
    { containerLabel: 'late one', mode: 'sea', departedOn: '2026-07-01', etaOn: '2026-08-01', etaSource: 'entered' },
    { containerLabel: 'no mode', mode: null, departedOn: '2026-09-01' },
    { containerLabel: 'sailing', mode: 'air', departedOn: '2026-09-08', etaOn: '2026-09-30', etaSource: 'entered' },
  ], TODAY)
  assert.equal(board.rows[0].state, 'overdue')
  assert.equal(board.counts.overdue, 1)
  assert.equal(board.counts.noEta, 1)
  assert.equal(board.counts.arrived, 6)
  assert.equal(board.attention, 2)
  // Counting must agree with the list it is a count OF.
  assert.equal(board.counts.overdue, board.rows.filter((r) => r.state === 'overdue').length)
  assert.equal(stats.air.median, 2)
})

test('mode inferred from the label is marked as inferred on the card', () => {
  const r = describeShipment({ containerLabel: '11 Air 1820 1777 air list carton 2026.9.7', departedOn: '2026-09-09' }, {}, TODAY)
  assert.equal(r.mode, 'air')
  assert.equal(r.modeInferred, true)
})
