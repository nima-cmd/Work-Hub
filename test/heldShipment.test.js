// test/heldShipment.test.js — the warehouse calendar: what is still on our floor.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  heldSince, holdReason, heldEvent, shipmentKey, daysBetween,
  BASIS, REASON,
} from '../src/model/heldShipment.js'
import { planHeldCalendar, ACTION, LANE, CALENDAR_NAME } from '../src/model/shipmentCalendarPlan.js'

const TODAY = '2026-08-26'

test('shipmentKey: never doubles a prefix the identifier already carries', () => {
  // ⚠️ An SO number is literally "SO12344", so `so${clean(so)}` yields "soso12344".
  assert.equal(shipmentKey({ so: 'SO12344' }), 'so12344')
  assert.equal(shipmentKey({ so: 'so12344' }), 'so12344')
  assert.equal(shipmentKey({ po: '911234-001' }), 'po911234001')
  assert.equal(shipmentKey({}), null)
})

test('shipmentKey: the PO wins, and matches the SHIPPED calendar key exactly', () => {
  // ⚠️ The move depends on this. Same shipment, same key, two calendars — if these
  // ever disagree the held copy is never removed and both sit there contradicting.
  assert.equal(shipmentKey({ po: '7242978', so: 'SO9' }), 'po7242978')
  assert.equal(shipmentKey({ po: null, so: 'SO12300' }), 'so12300',
    'boutique with no PO is SO-keyed — 10 of 21 scanned boutique shipments have no PO')
})

test('daysBetween: whole days across months, years and a DST boundary', () => {
  assert.equal(daysBetween('2026-08-14', '2026-08-26'), 12)
  assert.equal(daysBetween('2026-08-26', '2026-08-26'), 0)
  assert.equal(daysBetween('2026-12-28', '2027-01-04'), 7)
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2, 'US DST forward is 2026-03-08')
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2, 'US DST back is 2026-11-01')
  assert.equal(daysBetween('nonsense', TODAY), null)
})

test('heldSince: a witnessed scan outranks a date we merely inferred', () => {
  assert.deepEqual(
    heldSince({ custodyInAt: '2026-08-04', ifDate: '2026-08-01', packedAt: '2026-08-06' }),
    { date: '2026-08-04', basis: BASIS.CUSTODY_IN })
  assert.deepEqual(heldSince({ ifDate: '2026-08-01', packedAt: '2026-08-06' }),
    { date: '2026-08-01', basis: BASIS.IF_CREATED })
  assert.deepEqual(heldSince({ packedAt: '2026-08-06' }), { date: '2026-08-06', basis: BASIS.PACKED })
  assert.deepEqual(heldSince({}), { date: null, basis: null })
})

test('the counter says "at least" when the date is only a first OBSERVATION', () => {
  // ⚠️ schema.sql: PACKED/INVOICED/PAID have no recorded date anywhere in NetSuite, so
  // occurred_at is when the SYNC first saw the state. A precise-looking number from an
  // imprecise source is worse than a vaguer true one.
  const packed = heldEvent({ so: 'SO1', events: { packedAt: '2026-08-20', invoiced: true, paid: false }, todayIso: TODAY })
  assert.match(packed.summary, /held at least 6 days/)
  assert.equal(packed.exact, false)
  assert.match(packed.description, /when the sync first SAW this state/)

  const scanned = heldEvent({ so: 'SO1', events: { custodyInAt: '2026-08-20', invoiced: true, paid: false }, todayIso: TODAY })
  assert.match(scanned.summary, /\(held 6 days\)/)
  assert.doesNotMatch(scanned.summary, /at least/)
  assert.equal(scanned.exact, true)
})

test('a held event sits on TODAY, and never on a predicted date', () => {
  // ⚠️ orders.ship_date is start_date + 28 on 100% of 338 rows. There is no honest
  // forecast in this data, so the entry is dated the one day that cannot be wrong.
  const e = heldEvent({ so: 'SO12300', customer: 'Folie Douce', events: { custodyInAt: '2026-08-25' }, todayIso: TODAY })
  assert.equal(e.date, TODAY)
  assert.match(e.description, /has NOT shipped/, 'a reader must never mistake it for a shipment')
})

test('holdReason: no invoice, then no payment, and an unknown is NOT "ready"', () => {
  assert.equal(holdReason({ invoiced: false, paid: false }), REASON.AWAITING_INVOICE)
  assert.equal(holdReason({ invoiced: true, paid: false }), REASON.AWAITING_PAYMENT)
  assert.equal(holdReason({ invoiced: true, paid: true }), REASON.UNKNOWN)
})

test('singular day, and a missing possession date is stated rather than counted', () => {
  assert.match(heldEvent({ so: 'SO1', events: { custodyInAt: '2026-08-25' }, todayIso: TODAY }).summary, /held 1 day\)/)
  const none = heldEvent({ so: 'SO1', events: {}, todayIso: TODAY })
  assert.equal(none.daysHeld, null)
  assert.doesNotMatch(none.summary, /held/)
  assert.match(none.description, /No date recorded/)
})

// ── the plan, including the move ────────────────────────────────────────────
const cand = (so, po = null, days = 5) => ({
  so, po, customer: 'X', ifNumber: 'IF1',
  events: { custodyInAt: `2026-08-${String(26 - days).padStart(2, '0')}`, invoiced: true, paid: false },
})

test('plan: creates what is held, and leaves an unchanged entry alone', () => {
  const first = planHeldCalendar({ candidates: [cand('SO1')], existing: new Map(), todayIso: TODAY })
  assert.equal(first.entries[0].action, ACTION.CREATE)
  const live = new Map([[first.entries[0].key, first.entries[0].event]])
  const second = planHeldCalendar({ candidates: [cand('SO1')], existing: live, todayIso: TODAY })
  assert.equal(second.entries[0].action, ACTION.UNCHANGED)
})

test('plan: rolling forward a day is an UPDATE, not a duplicate', () => {
  const day1 = planHeldCalendar({ candidates: [cand('SO1')], existing: new Map(), todayIso: '2026-08-26' })
  const live = new Map([[day1.entries[0].key, day1.entries[0].event]])
  const day2 = planHeldCalendar({ candidates: [cand('SO1')], existing: live, todayIso: '2026-08-27' })
  assert.equal(day2.entries[0].action, ACTION.UPDATE)
  assert.equal(day2.entries[0].event.start.date, '2026-08-27')
  assert.equal(day2.entries[0].event.end.date, '2026-08-28', 'the all-day end stays exclusive')
})

test('plan: THE MOVE — once it ships the held copy is removed', () => {
  // ⚠️ The whole point of the third calendar. Without this the same shipment sits on
  // two calendars saying opposite things.
  const c = cand('SO1', '7242978')
  const key = shipmentKey({ po: '7242978' })
  const p = planHeldCalendar({
    candidates: [c], existing: new Map([[key, { summary: 'in the warehouse' }]]),
    shippedKeys: new Set([key]), todayIso: TODAY,
  })
  assert.equal(p.entries.length, 1)
  assert.equal(p.entries[0].action, ACTION.REMOVE)
  assert.equal(p.entries[0].reason, 'shipped')
})

test('plan: a shipped one that was never on the held calendar is a no-op, not a delete', () => {
  const key = shipmentKey({ po: '7242978' })
  const p = planHeldCalendar({
    candidates: [cand('SO1', '7242978')], existing: new Map(), shippedKeys: new Set([key]), todayIso: TODAY,
  })
  assert.deepEqual(p.entries, [], 'nothing to remove and nothing to create')
})

test('plan: an event with no candidate left is STALE and removed', () => {
  // ⚠️ It left the population without appearing on a shipped calendar — the ship date
  // synced but no ASN, say. Left alone it would sit on today forever, asserting that a
  // departed box is on the floor.
  const p = planHeldCalendar({
    candidates: [], existing: new Map([['so999', { summary: 'old' }]]), todayIso: TODAY,
  })
  assert.equal(p.entries.length, 1)
  assert.equal(p.entries[0].action, ACTION.REMOVE)
  assert.equal(p.entries[0].reason, 'no-longer-held')
})

test('plan: the summary counts reasons and names the oldest', () => {
  const p = planHeldCalendar({
    candidates: [
      { so: 'SO1', events: { custodyInAt: '2026-07-27', invoiced: false } },   // 30 days
      { so: 'SO2', events: { custodyInAt: '2026-08-24', invoiced: true, paid: false } },
    ],
    existing: new Map(), todayIso: TODAY,
  })
  assert.equal(p.summary.create, 2)
  assert.equal(p.summary.oldest, 30)
  assert.equal(p.summary.byReason[REASON.AWAITING_INVOICE], 1)
  assert.equal(p.summary.byReason[REASON.AWAITING_PAYMENT], 1)
})

test('the third calendar is named so it cannot be read as a shipping record', () => {
  assert.match(CALENDAR_NAME[LANE.HELD], /warehouse/i)
  assert.doesNotMatch(CALENDAR_NAME[LANE.HELD], /shipped/i)
})

test('"held 0 days" is said the way a person would say it', () => {
  // Technically true, reads as a bug in a list of 25.
  const today = heldEvent({ so: 'SO1', events: { custodyInAt: TODAY }, todayIso: TODAY })
  assert.match(today.summary, /arrived today/)
  assert.doesNotMatch(today.summary, /0 days/)
  assert.equal(today.daysHeld, 0, 'the NUMBER is still exact — only the wording changed')

  const observed = heldEvent({ so: 'SO1', events: { packedAt: TODAY }, todayIso: TODAY })
  assert.match(observed.summary, /first seen today/, 'and it still admits it was only observed')
})
