// test/transferCalendar.test.js — a transfer as a calendar entry.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transferEvent, transferKey, transferState, STATE } from '../src/model/transferCalendar.js'
import { planTransferCalendar, ACTION, LANE, CALENDAR_NAME } from '../src/model/shipmentCalendarPlan.js'
import { RECEIVED } from '../src/model/transferOrder.js'

const TODAY = '2026-08-27'
const base = { toNumber: 'TO127', destination: 'Office', ifNumber: 'IF7195', todayIso: TODAY }

test('the key can never collide with a shipment key', () => {
  // ⚠️ A transfer and a sales order both minting the same id would silently overwrite
  // each other on calendars that share an account.
  assert.equal(transferKey('TO217'), 'to217')
  assert.equal(transferKey('to217'), 'to217', 'no doubled prefix')
  assert.equal(transferKey('217'), 'to217')
  assert.equal(transferKey(''), null)
  assert.notEqual(transferKey('TO12300'), 'so12300')
})

test('⚠️ "Shipped" is NOT departed — it is set when the LABEL is made', () => {
  // Nima, 2026-08-27: "these are marked as shipped when the label is created normally
  // so we dont forget." Measured the same day: 11 transfers read Shipped, THREE have a
  // label and ZERO have an actual_ship_date — eight were marked before a label existed.
  //
  // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE. It expected Shipped → IN_TRANSIT, which
  // encoded my wrong assumption and would have published "sent" for eleven transfers
  // nobody watched leave. The correction came from Nima, not from the tests.
  assert.equal(transferState({ ifStatus: 'Picked' }), STATE.NOT_SHIPPED)
  assert.equal(transferState({ ifStatus: 'Shipped' }), STATE.MARKED_SHIPPED)
  assert.equal(transferState({ ifStatus: 'Shipped', departureConfirmed: true }), STATE.IN_TRANSIT,
    'only a human saying so moves it past marked')
  assert.equal(transferState({ ifStatus: 'Shipped', toStatus: RECEIVED }), STATE.RECEIVED)
  // ⚠️ Received wins even over an unshipped fulfilment — if the far end says it has
  // the goods, arguing with them from our own status field helps nobody.
  assert.equal(transferState({ ifStatus: 'Picked', toStatus: RECEIVED }), STATE.RECEIVED)
})

test('an unshipped transfer sits on TODAY and rolls forward', () => {
  const e = transferEvent({ ...base, toNumber: 'TO217', ifStatus: 'Picked', ifDate: new Date(2026, 7, 26) })
  assert.equal(e.date, TODAY, 'not the fulfilment date — it has not gone yet')
  assert.match(e.summary, /not yet shipped/)
  assert.match(e.description, /has NOT shipped/)
})

test('⚠️ only a CONFIRMED departure earns a past date', () => {
  // A transfer merely marked shipped is, as far as anyone actually knows, still on the
  // floor — so it sits on TODAY and rolls forward. Dating it on if_date would put it on
  // the day the FULFILMENT WAS CREATED and call that a departure.
  const marked = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5) })
  assert.equal(marked.state, STATE.MARKED_SHIPPED)
  assert.equal(marked.date, TODAY, 'still here until someone says otherwise')
  assert.equal(marked.gone, false)

  const confirmed = transferEvent({
    ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5),
    departureConfirmed: true, departureConfirmedAt: new Date(2026, 5, 6),
  })
  assert.equal(confirmed.state, STATE.IN_TRANSIT)
  assert.equal(confirmed.date, '2026-06-06', 'the day the human confirmed, not the IF date')
  assert.equal(confirmed.gone, true)
})

test('⚠️ unreceived is "not confirmed received", NEVER "not delivered"', () => {
  // Nima: "sometiems they dont receive on their end". Absence of their confirmation is
  // not evidence it failed to arrive.
  const e = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5), departureConfirmed: true, departureConfirmedAt: new Date(2026, 5, 5) })
  assert.match(e.summary, /not confirmed received/)
  assert.doesNotMatch(e.description, /not delivered/i)
  assert.match(e.description, /may well have arrived/)
})

test('the days-waiting count is the number he asked for', () => {
  const e = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 4, 4), departureConfirmed: true, departureConfirmedAt: new Date(2026, 4, 4) })
  assert.equal(e.daysWaiting, 115)
  assert.match(e.summary, /\(115d\)/)
  // A received transfer is not "waiting" for anything.
  const done = transferEvent({ ...base, ifStatus: 'Shipped', toStatus: RECEIVED, ifDate: new Date(2026, 4, 4), departureConfirmed: true, departureConfirmedAt: new Date(2026, 4, 4) })
  assert.equal(done.daysWaiting, null)
  assert.match(done.summary, /— received/)
})

test('no tracking is said OUT LOUD, and the advice matches the shipment', () => {
  // ⚠️ A shipment that left with no tracking cannot be chased at all — worth knowing
  // BEFORE the far end says it never arrived. And do not tell someone to check a
  // tracking number that is not there.
  const none = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5), tracking: [], departureConfirmed: true, departureConfirmedAt: new Date(2026, 5, 5) })
  assert.match(none.description, /No tracking number recorded/)
  assert.match(none.description, /chased by asking/)
  assert.doesNotMatch(none.description, /Check the tracking above/)

  const some = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5), tracking: ['1ZC6J610'], departureConfirmed: true, departureConfirmedAt: new Date(2026, 5, 5) })
  assert.match(some.description, /1ZC6J610/)
  assert.match(some.description, /Check the tracking above/)
})

test('no date, no event — the same rule as every other calendar here', () => {
  assert.equal(transferEvent({ ...base, ifStatus: 'Shipped', ifDate: null, departureConfirmed: true, departureConfirmedAt: null, todayIso: null }), null)
  assert.equal(transferEvent({ ...base, toNumber: null, ifStatus: 'Picked' }), null)
  // An unshipped transfer with no todayIso has nothing to sit on either.
  assert.equal(transferEvent({ ...base, ifStatus: 'Picked', todayIso: null }), null)
})

test('plan: creates, then leaves unchanged, and removes what stopped being tracked', () => {
  const t = [{ toNumber: 'TO127', destination: 'Office', ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5) }]
  const first = planTransferCalendar({ transfers: t, existing: new Map(), todayIso: TODAY })
  assert.equal(first.entries[0].action, ACTION.CREATE)

  const live = new Map([[first.entries[0].key, first.entries[0].event]])
  assert.equal(planTransferCalendar({ transfers: t, existing: live, todayIso: TODAY }).entries[0].action, ACTION.UNCHANGED)

  // ⚠️ A destination removed from the tracked list must not leave an entry asserting
  // freight that is no longer ours to report.
  const gone = planTransferCalendar({ transfers: [], existing: live, todayIso: TODAY })
  assert.equal(gone.entries[0].action, ACTION.REMOVE)
  assert.equal(gone.entries[0].reason, 'no-longer-tracked')
})

test('plan: becoming received is an UPDATE, not a duplicate', () => {
  const t = [{ toNumber: 'TO190', destination: 'Consignment', ifStatus: 'Shipped', ifDate: new Date(2026, 6, 6), departureConfirmed: true, departureConfirmedAt: new Date(2026, 6, 6) }]
  const before = planTransferCalendar({ transfers: t, existing: new Map(), todayIso: TODAY })
  const live = new Map([[before.entries[0].key, before.entries[0].event]])
  const after = planTransferCalendar({
    transfers: [{ ...t[0], toStatus: RECEIVED }], existing: live, todayIso: TODAY,
  })
  assert.equal(after.entries[0].action, ACTION.UPDATE)
  assert.equal(after.entries[0].state, STATE.RECEIVED)
  assert.equal(after.entries[0].date, before.entries[0].date, 'it stays on the day it went')
})

test('the summary counts states and names the longest unconfirmed wait', () => {
  const p = planTransferCalendar({
    transfers: [
      { toNumber: 'TO123', destination: 'Office', ifStatus: 'Shipped', ifDate: new Date(2026, 4, 4), departureConfirmed: true, departureConfirmedAt: new Date(2026, 4, 4) },
      { toNumber: 'TO190', destination: 'Consignment', ifStatus: 'Shipped', toStatus: RECEIVED, ifDate: new Date(2026, 6, 6), departureConfirmed: true, departureConfirmedAt: new Date(2026, 6, 6) },
      { toNumber: 'TO217', destination: 'Office', ifStatus: 'Picked' },
    ],
    existing: new Map(), todayIso: TODAY,
  })
  assert.equal(p.summary.create, 3)
  assert.equal(p.summary.longestWait, 115)
  assert.equal(p.summary.byState[STATE.RECEIVED], 1)
  assert.equal(p.summary.byState[STATE.NOT_SHIPPED], 1)
})

test('transfers get their own calendar, not the boutique one', () => {
  assert.match(CALENDAR_NAME[LANE.TRANSFER], /Transfers/)
  assert.notEqual(CALENDAR_NAME[LANE.TRANSFER], CALENDAR_NAME[LANE.BOUTIQUE])
})

test('⚠️ a marked-shipped transfer with no tracking is warned about', () => {
  // Eight of the eleven marked-shipped transfers have NO label at all. That is exactly
  // when you want to know there is nothing to chase — the warning must not wait for a
  // departure confirmation that may never come.
  const e = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5), tracking: [] })
  assert.equal(e.state, STATE.MARKED_SHIPPED)
  assert.match(e.description, /No tracking number recorded/)
})

test('⚠️ the body explains WHY marked-shipped is not gone', () => {
  const e = transferEvent({ ...base, ifStatus: 'Shipped', ifDate: new Date(2026, 5, 5) })
  assert.match(e.description, /when the LABEL is made/)
  assert.match(e.description, /Nobody has confirmed this left/)
  // ⚠️ And it must never say "sent" — that is the claim the whole change removes.
  assert.doesNotMatch(e.summary, /\bsent\b/)
  assert.match(e.summary, /marked shipped — not confirmed it left/)
})
