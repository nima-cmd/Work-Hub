// test/shipDateAdvice.test.js — Nima's step 6: mark it shipped on the date it
// actually left. Every fixture below is a real measured case from 2026-07-31.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  honestFloor, shipDateAdvice, rankShipDateAdvice, monthCloseCount,
  calendarDays, ymd, SEVERITY, auditMarkedShipments,
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

// ── The EDI lane (measured live 2026-08-03) ──────────────────────────────────
//
// Real shape: PO 7590875 DC "SC" — 10 fulfilments under ONE cargo tag, scanned
// back in 2026-07-22, routing auth 55753138 set pickup for 07-29, IFs marked
// shipped 07-30. Treating the scan as a tight floor called all of them "7 days
// adrift"; 47 such flags existed against 0 real problems.

test('EDI reads its custody off the cargo tag, not the fulfilment', () => {
  // 0 of the 50 shipped EDI IFs carry IF-level custody, so the per-IF fields are
  // null and only the DC ones are populated.
  const f = honestFloor({ edi: true, custodyIn: null, dcCustodyIn: d('2026-07-22') })
  assert.equal(f.key, 'DC_CUSTODY_IN')
  assert.match(f.label, /cargo tag/)
  // Boutique must be untouched by the new chain.
  assert.equal(honestFloor({ custodyIn: d('2026-07-27') }).key, 'CUSTODY_IN')
  // A DC scan is invisible to the boutique chain — it isn't that IF's evidence.
  assert.equal(honestFloor({ dcCustodyIn: d('2026-07-22') }), null)
})

test('the routing authorization is the EDI date to type, not the packing scan', () => {
  const a = shipDateAdvice({
    ifNumber: 'IF7302', edi: true,
    dcCustodyIn: d('2026-07-22'),
    routingShipDate: d('2026-07-29'),
    markedDate: d('2026-07-30'),
  })
  assert.equal(a.basis, 'ROUTING_AUTH')
  assert.equal(a.suggestedDate, '2026-07-29')
  // Against the auth the real drift is ONE day, not the seven the scan implies.
  assert.equal(a.driftDays, 1)
  assert.equal(a.severity, SEVERITY.MINOR)
  // It is a plan the retailer set, never something we watched happen.
  assert.equal(a.strength, 'plan')
})

test('routing dwell is not drift — the 47 phantom flags stay silent', () => {
  // Same carton, no authorization on file: the 7-day gap is the carton waiting
  // for the truck. Reporting it would be the false positive this exists to stop.
  const a = shipDateAdvice({
    ifNumber: 'IF7317', edi: true,
    dcCustodyIn: d('2026-07-22'),
    markedDate: d('2026-07-29'),
  })
  assert.equal(a.driftDays, 7)
  assert.equal(a.severity, SEVERITY.NONE, '7 days of dwell must not raise anything')
  assert.equal(a.dwellOnly, true)
  assert.match(a.advice, /waits for the retailer's truck/)
  // Boutique with the SAME 7-day gap is real drift and must still fire.
  const boutique = shipDateAdvice({ custodyIn: d('2026-07-22'), markedDate: d('2026-07-29') })
  assert.equal(boutique.severity, SEVERITY.DRIFT)
})

test('dwell never excuses a month close or an impossible date', () => {
  // Packed Jul 22, marked Aug 3: dwell or not, that books in the wrong month.
  const crossing = shipDateAdvice({
    ifNumber: 'IF7320', edi: true, dcCustodyIn: d('2026-07-22'), markedDate: d('2026-08-03'),
  })
  assert.equal(crossing.crossesMonthClose, true)
  assert.equal(crossing.severity, SEVERITY.MONTH)
  assert.equal(monthCloseCount([crossing]), 1)

  // Marked BEFORE the cartons were packed — impossible, whatever the plan said.
  const impossible = shipDateAdvice({
    ifNumber: 'IF7305', edi: true,
    dcCustodyIn: d('2026-07-22'), routingShipDate: d('2026-07-29'), markedDate: d('2026-07-20'),
  })
  assert.equal(impossible.impossible, true)
  assert.equal(impossible.severity, SEVERITY.MONTH)
})

test('shipping before the authorized pickup is early, not impossible', () => {
  // The truck came a day sooner than scheduled. The goods were already packed on
  // the 22nd, so nothing was faked — this must not be reported as impossible.
  const a = shipDateAdvice({
    ifNumber: 'IF7311', edi: true,
    dcCustodyIn: d('2026-07-22'), routingShipDate: d('2026-07-29'), markedDate: d('2026-07-28'),
  })
  assert.equal(a.impossible, false)
  assert.equal(a.driftDays, -1)
})

test('an EDI fulfilment with no scan and no auth still admits it knows nothing', () => {
  const a = shipDateAdvice({ ifNumber: 'IF9999', edi: true }, { today: d('2026-08-03') })
  assert.equal(a.suggestedDate, null)
  assert.equal(a.severity, SEVERITY.NONE)
  assert.match(a.basisLabel, /no custody scan/)
})

// ── The retro half: shipments already marked ─────────────────────────────────
//
// Every fixture below is a real measured row from 2026-08-03's live audit of all
// 91 shipped fulfilments.

test('auditMarkedShipments only judges marks that have real evidence', () => {
  const rows = [
    // Real evidence: a custody scan. 10 days late, same month — worth a look.
    { ifNumber: 'IF7287', custodyIn: d('2026-07-17'), markedDate: d('2026-07-27') },
    // Only the fulfilment date, which NetSuite routinely copies to the ship
    // date. Auditing one against the other is near-circular, so it is excluded
    // and counted as `weak` rather than silently dropped.
    { ifNumber: 'IF7100', ifDate: d('2026-06-05'), markedDate: d('2026-06-20') },
    // Nothing at all — shipped before any custody scan existed. `blind`.
    { ifNumber: 'IF6800', markedDate: d('2026-06-05') },
    // Not marked yet: belongs to the FORWARD list, never to this one.
    { ifNumber: 'IF7440', custodyIn: d('2026-07-31') },
  ]
  const { items, counts } = auditMarkedShipments(rows, {
    today: d('2026-08-03'), custodyEpoch: d('2026-07-17'),
  })

  assert.deepEqual(items.map((i) => i.ifNumber), ['IF7287'])
  assert.equal(counts.total, 1)
  // Both excluded rows shipped in June, before any scan existed.
  assert.equal(counts.preCustody, 2)
  assert.equal(counts.unscanned, 0)
})

test('the audit distinguishes "never checkable" from "nobody scanned it"', () => {
  const rows = [
    // Before the feed existed — nothing anyone can do about this one.
    { ifNumber: 'IF6800', ifDate: d('2026-06-01'), markedDate: d('2026-06-05') },
    // After it existed, and still no scan. A live gap, not a historical one, so
    // it must not hide inside the number above.
    { ifNumber: 'IF7395', ifDate: d('2026-07-24'), markedDate: d('2026-07-25') },
  ]
  const { counts } = auditMarkedShipments(rows, {
    today: d('2026-08-03'), custodyEpoch: d('2026-07-17'),
  })
  assert.equal(counts.preCustody, 1)
  assert.equal(counts.unscanned, 1)
})

test('with no custody epoch the audit overstates the live gap, never understates it', () => {
  // Erring the other way would let a historical blind spot pass as clean.
  const { counts } = auditMarkedShipments(
    [{ ifNumber: 'IF6800', ifDate: d('2026-06-01'), markedDate: d('2026-06-05') }],
    { today: d('2026-08-03') },
  )
  assert.equal(counts.preCustody, 0)
  assert.equal(counts.unscanned, 1)
})

test('a mark a day off its scan is normal handling, not an error to chase', () => {
  const { items } = auditMarkedShipments(
    [{ ifNumber: 'IF7407', custodyIn: d('2026-07-26'), markedDate: d('2026-07-27') }],
    { today: d('2026-08-03') },
  )
  assert.equal(items.length, 0)
})

test('the audit separates a wrong month from a wrong day and an impossible date', () => {
  const rows = [
    // The expensive kind: booked into August, evidence says July.
    { ifNumber: 'IF7500', custodyIn: d('2026-07-30'), markedDate: d('2026-08-02') },
    // IF7190, real: marked two days BEFORE the goods came back. Not "negative
    // drift" — a date that cannot be true.
    { ifNumber: 'IF7190', custodyIn: d('2026-07-17'), markedDate: d('2026-07-15') },
    // Wrong day, right month.
    { ifNumber: 'IF7354', custodyIn: d('2026-07-22'), markedDate: d('2026-07-27') },
  ]
  const { items, counts } = auditMarkedShipments(rows, { today: d('2026-08-03') })

  assert.equal(counts.monthClose, 1)
  assert.equal(counts.impossible, 1)
  assert.equal(counts.drift, 1)
  // Ranked so the expensive ones cannot be missed, same rule as the forward list.
  assert.equal(items[0].advice.severity, SEVERITY.MONTH)
})

test('an EDI mark is audited against the routing authorization, not the packing scan', () => {
  // The live shape: cartons scanned in 07-22, truck authorized 07-29, marked
  // 07-30. Against the scan that reads 8 days adrift — which is DWELL. Against
  // the authorization it is one day, and stays out of the list entirely.
  const { items, counts } = auditMarkedShipments([{
    ifNumber: 'IF7420', edi: true,
    dcCustodyIn: d('2026-07-22'), routingShipDate: d('2026-07-29'), markedDate: d('2026-07-30'),
  }], { today: d('2026-08-03') })

  assert.equal(items.length, 0)
  assert.equal(counts.preCustody, 0)
  assert.equal(counts.unscanned, 0)
})

test('an EDI mark that crosses the close still speaks, dwell or not', () => {
  const { items, counts } = auditMarkedShipments([{
    ifNumber: 'IF7421', edi: true,
    dcCustodyIn: d('2026-07-22'), routingShipDate: d('2026-07-29'), markedDate: d('2026-08-01'),
  }], { today: d('2026-08-03') })

  assert.equal(counts.monthClose, 1)
  assert.equal(items[0].advice.basis, 'ROUTING_AUTH')
})
