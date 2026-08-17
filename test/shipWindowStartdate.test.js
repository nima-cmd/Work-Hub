import test from 'node:test'
import assert from 'node:assert/strict'
import { shipWindow } from '../src/model/shipWindow.js'
import { postCustodyState, PC } from '../src/model/postCustody.js'

const TODAY = new Date('2026-08-14T12:00:00Z')
const day = (t) => (t == null ? null : new Date(t).toISOString().slice(0, 10))

// ⚠️ FOUR FIELDS WERE TRIED BEFORE THIS ONE. transaction.shipdate was trandate+28 on
// 98% of orders; custbody_promisedate defaults +4; the line's expectedshipdate has no
// header feeding it. Nima, asked directly on 2026-08-14: "in netsuite Field ID:
// startdate". Measured across 399 sales orders it takes 30 distinct offsets from
// trandate (-9 to +620) — hand-set, not a default.
const SB = {   // SO12344, Saint Bernard — live values
  soNumber: 'SO12344', source: 'boutique',
  windowStart: '2026-08-28', windowEnd: '2026-09-10',
  shipDate: '2026-08-18', startDate: '2026-07-21',   // the +28 phantom, must be ignored
}

test('the order\'s own window drives the deadline, not the +28 phantom', () => {
  const w = shipWindow(SB, TODAY)
  assert.equal(day(w.windowStart), '2026-08-28')
  assert.equal(day(w.windowEnd), '2026-09-10')
  assert.equal(day(w.mustShipBy), '2026-09-10')   // the window's close, not 08-18
  assert.equal(w.source, 'window')
  assert.equal(w.notOpenYet, true)
})

// ⚠️ THE BUG NIMA FOUND FROM THE OTHER SIDE: "for Saint Bernard needs a label or a
// routing. Its been returned but we are waiting for the ship window on this one."
// PR #94 was right to stop trusting the +28 date, but it left AWAITING_SHIP_WINDOW with
// nothing to key on, so every order waiting for its window fell through to needing a
// label. The real field makes the state reachable again.
test('an order waiting for its window is NOT waiting for a label', () => {
  const card = {
    ...SB, fulfilments: [{ ifNumber: 'IF7405', status: 'Picked', labelled: false, custodyIn: '2026-08-01' }],
    invoices: [], shipWindow: shipWindow(SB, TODAY), departed: false,
  }
  const pc = postCustodyState(card, TODAY)
  assert.equal(pc.key, PC.AWAITING_SHIP_WINDOW)
  assert.notEqual(pc.key, PC.NEEDS_LABEL_OR_ROUTING)
})

// ⚠️ Lead with when it OPENS. The first cut printed the window's END — "not due to ship
// until Sep 10" for a window opening Aug 28 — describing thirteen days of runway as
// none. Both dates belong on the card; they answer different questions.
test('the sentence says when it opens, and the deadline in brackets', () => {
  const card = {
    ...SB, fulfilments: [{ ifNumber: 'IF7405', status: 'Picked', labelled: false, custodyIn: '2026-08-01' }],
    invoices: [], shipWindow: shipWindow(SB, TODAY), departed: false,
  }
  const { waitingOn } = postCustodyState(card, TODAY)
  assert.match(waitingOn, /Ships from Aug 28/)
  assert.match(waitingOn, /by Sep 10/)
})

// A window with an opening and no close is still a window — it cannot ship yet.
test('a start-only window still holds the order', () => {
  const w = shipWindow({ source: 'boutique', windowStart: '2026-09-01' }, TODAY)
  assert.ok(w)
  assert.equal(day(w.windowStart), '2026-09-01')
  assert.equal(w.notOpenYet, true)
})

test('no window at all still returns null rather than inventing one', () => {
  assert.equal(shipWindow({ source: 'boutique', shipDate: '2026-08-18', startDate: '2026-07-21' }, TODAY), null)
})

// ⚠️ EDI is untouched: the partner's 850 outranks our own dates, and a headstart still
// applies to theirs and not to ours.
test('an EDI partner\'s cancel date still wins over the order\'s window', () => {
  const w = shipWindow({
    source: 'edi', customer: "Bloomingdale's", windowStart: '2026-09-01', windowEnd: '2026-09-30',
    ediWindow: { shipNotBefore: '2026-08-20', cancelAfter: '2026-08-25' },
  }, TODAY)
  assert.equal(w.source, 'edi')
  assert.equal(day(w.mustShipBy), '2026-08-25')
})
