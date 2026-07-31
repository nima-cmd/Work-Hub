// test/shipDateAdvice.test.js — Nima's step 6: mark it shipped on the date it
// actually left. Every fixture below is a real measured case from 2026-07-31.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  honestFloor, shipDateAdvice, rankShipDateAdvice, monthCloseCount,
  calendarDays, ymd, SEVERITY,
} from '../src/model/shipDateAdvice.js'

// Local midnight, the way node-postgres hands back a `date` column.
const d = (s) => {
  const [y, m, day] = s.split('-').map(Number)
  return new Date(y, m - 1, day)
}

test('honestFloor prefers CUSTODY_IN over CUSTODY_OUT', () => {
  // IF7404, the case that proves it matters: out Jul 23, back Jul 27, marked
  // Jul 29. Against CUSTODY_OUT the drift reads 6 days; the goods were still
  // being packed for four of those, so the honest drift is 2.
  const f = honestFloor({ custodyOut: d('2026-07-23'), custodyIn: d('2026-07-27') })
  assert.equal(f.key, 'CUSTODY_IN')
  assert.equal(ymd(f.date), '2026-07-27')
  assert.equal(f.strength, 'scan')
})

test('honestFloor falls back down the chain, and admits when it has nothing', () => {
  assert.equal(honestFloor({ custodyOut: d('2026-07-23') }).key, 'CUSTODY_OUT')
  const weak = honestFloor({ ifDate: d('2026-07-29') })
  assert.equal(weak.key, 'IF_DATE')
  assert.equal(weak.strength, 'weak', 'an IF date is not a custody fact')
  // No evidence must be null — NOT today. A silent fallback to today is exactly
  // the bug being fixed in toCalDate on the calendar branch.
  assert.equal(honestFloor({}), null)
  assert.equal(honestFloor({ custodyIn: null, custodyOut: '', ifDate: undefined }), null)
})

test('the six real drift cases, audited against the date actually used', () => {
  const cases = [
    ['IF7287', '2026-07-17', '2026-07-27', 10],
    ['IF7354', '2026-07-22', '2026-07-27', 5],
    ['IF7289', '2026-07-17', '2026-07-20', 3],
    ['IF7404', '2026-07-27', '2026-07-29', 2],  // 6 if you wrongly use CUSTODY_OUT
    ['IF7407', '2026-07-27', '2026-07-28', 1],
  ]
  for (const [ifNumber, floor, marked, drift] of cases) {
    const a = shipDateAdvice({ ifNumber, custodyIn: d(floor), markedDate: d(marked) })
    assert.equal(a.driftDays, drift, `${ifNumber} drift`)
    assert.equal(a.suggestedDate, floor, `${ifNumber} should have been dated ${floor}`)
    assert.equal(a.impossible, false)
    // All six sit inside July, so none crossed a close — luck, not design.
    assert.equal(a.crossesMonthClose, false, `${ifNumber} stayed in one month`)
  }
})

test('IF7190 is not late, it is impossible — marked before the goods were back', () => {
  // Marked shipped Jul 15; the custody scan says it was still at the warehouse
  // until Jul 17. Reporting this as "-2 days drift" would bury it; it is a wrong
  // date, and it ranks with the expensive ones.
  const a = shipDateAdvice({ ifNumber: 'IF7190', custodyIn: d('2026-07-17'), markedDate: d('2026-07-15') })
  assert.equal(a.impossible, true)
  assert.equal(a.driftDays, -2)
  assert.equal(a.severity, SEVERITY.MONTH, 'an impossible date is top-priority')
  assert.match(a.advice, /cannot be right/)
})

test('month-close is the expensive case and outranks a bigger same-month drift', () => {
  // The scenario Nima pays for: packed and in hand Jul 30, still unmarked on
  // Aug 1. Only two days of drift, but it crosses the close.
  const crossing = shipDateAdvice(
    { ifNumber: 'IF7408', custodyIn: d('2026-07-30') },
    { today: d('2026-08-01') },
  )
  assert.equal(crossing.crossesMonthClose, true)
  assert.equal(crossing.driftDays, 2)
  assert.equal(crossing.severity, SEVERITY.MONTH)
  assert.equal(crossing.suggestedDate, '2026-07-30')
  assert.match(crossing.advice, /wrong close/)

  // Nine days of drift, same month — worse-looking, cheaper.
  const inMonth = shipDateAdvice(
    { ifNumber: 'IF7288', custodyIn: d('2026-08-04') },
    { today: d('2026-08-13') },
  )
  assert.equal(inMonth.driftDays, 9)
  assert.equal(inMonth.crossesMonthClose, false)
  assert.equal(inMonth.severity, SEVERITY.DRIFT)

  assert.deepEqual(
    rankShipDateAdvice([inMonth, crossing]).map((i) => i.ifNumber),
    ['IF7408', 'IF7288'],
    'the month-crosser must come first even though its drift is smaller',
  )
})

test('a same-day scan is quiet — no nagging on work done right', () => {
  const a = shipDateAdvice({ ifNumber: 'IF7441', custodyIn: d('2026-07-31') }, { today: d('2026-07-31') })
  assert.equal(a.driftDays, 0)
  assert.equal(a.severity, SEVERITY.NONE)
  assert.equal(a.crossesMonthClose, false)
})

test('no scan means no suggestion — it never guesses a date', () => {
  const a = shipDateAdvice({ ifNumber: 'IF7414' }, { today: d('2026-07-31') })
  assert.equal(a.suggestedDate, null)
  assert.equal(a.severity, SEVERITY.NONE)
  assert.equal(a.basis, null)
  assert.match(a.basisLabel, /no custody scan/)
})

test('a month boundary one day apart still crosses; 30 days inside one does not', () => {
  const oneDay = shipDateAdvice({ custodyIn: d('2026-07-31') }, { today: d('2026-08-01') })
  assert.equal(oneDay.driftDays, 1)
  assert.equal(oneDay.crossesMonthClose, true)
  assert.equal(oneDay.severity, SEVERITY.MONTH, 'one day across the close beats 30 inside it')

  const wholeMonth = shipDateAdvice({ custodyIn: d('2026-08-01') }, { today: d('2026-08-31') })
  assert.equal(wholeMonth.driftDays, 30)
  assert.equal(wholeMonth.crossesMonthClose, false)
})

test('calendarDays ignores the clock and survives a DST change', () => {
  // 2026-03-08 is the US spring-forward: that day is 23 hours long, so plain
  // millisecond division rounds to the wrong number of days.
  assert.equal(calendarDays(d('2026-03-07'), d('2026-03-09')), 2)
  assert.equal(calendarDays(d('2026-11-01'), d('2026-11-02')), 1) // fall back, 25h
  // Times of day must not leak into a day count.
  assert.equal(calendarDays(new Date(2026, 6, 17, 23, 59), new Date(2026, 6, 18, 0, 1)), 1)
  assert.equal(calendarDays(null, d('2026-07-18')), null)
})

test('ymd reads the LOCAL calendar date, not the UTC one', () => {
  // A date at local midnight in a US timezone is the PREVIOUS day in UTC, so
  // toISOString() would silently report the wrong ship date.
  assert.equal(ymd(new Date(2026, 6, 17)), '2026-07-17')
  assert.equal(ymd(null), null)
  assert.equal(ymd('nonsense'), null)
})

test('monthCloseCount counts what belongs on the chip', () => {
  const items = [
    shipDateAdvice({ custodyIn: d('2026-07-29') }, { today: d('2026-08-03') }), // crosses
    shipDateAdvice({ custodyIn: d('2026-07-17'), markedDate: d('2026-07-15') }), // impossible
    shipDateAdvice({ custodyIn: d('2026-08-01') }, { today: d('2026-08-05') }),  // same month
    shipDateAdvice({}, { today: d('2026-08-05') }),                             // no evidence
  ]
  assert.equal(monthCloseCount(items), 2)
})
