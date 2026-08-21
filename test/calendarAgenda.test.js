import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENDA, buildAgenda, splitAgenda, byDay, weekDays, monthDays, agendaSummary, isoDay,
} from '../src/model/calendarAgenda.js'

const TODAY = new Date('2026-08-21T12:00:00Z')
const so = (over = {}) => ({ soNumber: 'SO1', customer: 'A Shop', source: 'boutique', stage: 'OPEN', ...over })

// ── The dead fields must never come back ────────────────────────────────────

test('ship_date and cancel_date are NOT used — they are the fabricated pair', () => {
  // Measured: cancel_date NULL on all 121 unshipped orders, and ALL 121 ship_dates are
  // the NetSuite trandate+28 default. The old calendar plotted both, which is why the
  // dots meant nothing.
  const out = buildAgenda({
    orders: [so({ shipDate: '2026-09-01', cancelDate: '2026-09-05' })],
    today: TODAY,
  })
  assert.equal(out.length, 0, 'an order with only the fabricated dates contributes nothing')
})

test('a real ship window DOES produce an entry', () => {
  const out = buildAgenda({ orders: [so({ windowEnd: '2026-09-01' })], today: TODAY })
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, AGENDA.WINDOW_CLOSE)
  assert.equal(out[0].day, '2026-09-01')
  assert.equal(out[0].inDays, 11)
})

// ── Grouping: a count, not a list of 23 rows ────────────────────────────────

test('overlapping boutique windows collapse to ONE entry carrying the count', () => {
  // "in the case of boutiques there overlapping one … so we can have the number of
  // boutiques about to close" — 23 closed on one day in the real data.
  const orders = Array.from({ length: 23 }, (_, i) =>
    so({ soNumber: `SO${i}`, windowEnd: '2026-09-15' }))
  const out = buildAgenda({ orders, today: TODAY })
  assert.equal(out.length, 1)
  assert.equal(out[0].count, 23)
  assert.match(out[0].headline, /23 boutique/)
  assert.equal(out[0].items.length, 23, 'the orders ride along so each can open its packet')
})

test('different channels on the same day stay separate entries', () => {
  const out = buildAgenda({
    orders: [
      so({ soNumber: 'A', windowEnd: '2026-09-10', source: 'boutique' }),
      so({ soNumber: 'B', windowEnd: '2026-09-10', source: 'edi' }),
    ],
    today: TODAY,
  })
  assert.equal(out.length, 2, 'a boutique window and an EDI window are different work')
})

test('a shipped order contributes nothing, whatever its window says', () => {
  const out = buildAgenda({ orders: [so({ windowEnd: '2026-09-01', stage: 'SHIPPED' })], today: TODAY })
  assert.equal(out.length, 0)
})

// ── The partner's own dates ─────────────────────────────────────────────────

test("the EDI cancel-after comes from the partner's 850, not from orders", () => {
  const out = buildAgenda({
    ediCancels: [{ day: '2026-09-10', partner: 'Shopbop (BOP LLC)', count: 2, businessNumbers: ['POJ1', 'POJ2'] }],
    today: TODAY,
  })
  assert.equal(out[0].kind, AGENDA.EDI_CANCEL)
  assert.match(out[0].headline, /Shopbop/)
  assert.doesNotMatch(out[0].headline, /BOP LLC/, 'the legal-entity suffix is noise on a calendar')
  assert.equal(out[0].items[0].docType, 'THEIR_PO', "a partner's PO is theirs, not our factory PO")
})

// ── Containers ──────────────────────────────────────────────────────────────

test('a container arrival is the POs sharing a due date, as one entry', () => {
  const out = buildAgenda({
    arrivals: [{ day: '2026-09-15', pos: 13, lines: 217, units: 5410, poNumbers: ['PO1', 'PO2'] }],
    today: TODAY,
  })
  assert.equal(out[0].kind, AGENDA.CONTAINER_ARRIVAL)
  assert.equal(out[0].count, 13)
  assert.match(out[0].headline, /13 POs/)
  assert.match(out[0].headline, /5410 units/)
})

test('a container arrival is never marked overdue', () => {
  // It landing last week is history, not a failure. Only deadlines can be late.
  const out = buildAgenda({
    arrivals: [{ day: '2026-08-01', pos: 2, units: 100 }],
    today: TODAY,
  })
  assert.equal(out[0].overdue, false)
  assert.ok(out[0].inDays < 0)
})

test('a passed DEADLINE is overdue', () => {
  const out = buildAgenda({
    ediCancels: [{ day: '2026-08-01', partner: 'Bloomingdale’s', count: 1 }],
    today: TODAY,
  })
  assert.equal(out[0].overdue, true)
})

// ── Tasks: an empty lane is a fact, not a gap ───────────────────────────────

test('tasks with no due date contribute nothing, and that is honest', () => {
  // 0 of 11 open tasks carry a due date today.
  const out = buildAgenda({ tasks: [{ id: 1, subject: 'x', status: 'open' }], today: TODAY })
  assert.equal(out.length, 0)
})

test('a task WITH a due date lands on that day', () => {
  const out = buildAgenda({
    tasks: [{ id: 7, subject: 'Chase the 810', status: 'open', dueAt: '2026-08-25T00:00:00Z' }],
    today: TODAY,
  })
  assert.equal(out[0].kind, AGENDA.TASK_DUE)
  assert.equal(out[0].headline, 'Chase the 810')
  assert.equal(out[0].items[0].docType, 'TASK')
})

test('several tasks on one day become a count', () => {
  const out = buildAgenda({
    tasks: [
      { id: 1, subject: 'a', status: 'open', dueAt: '2026-08-25' },
      { id: 2, subject: 'b', status: 'open', dueAt: '2026-08-25' },
    ],
    today: TODAY,
  })
  assert.equal(out[0].headline, '2 tasks')
})

test('a done task is not due', () => {
  const out = buildAgenda({ tasks: [{ id: 1, subject: 'a', status: 'done', dueAt: '2026-08-25' }], today: TODAY })
  assert.equal(out.length, 0)
})

// ── Forward vs review ───────────────────────────────────────────────────────

test('today belongs to FORWARD — it is still actionable', () => {
  const { forward, past } = splitAgenda(buildAgenda({
    orders: [so({ windowEnd: '2026-08-21' })], today: TODAY,
  }))
  assert.equal(forward.length, 1)
  assert.equal(past.length, 0)
  assert.equal(forward[0].today, true)
})

test('an OVERDUE deadline stays in forward however old — it is the most urgent thing', () => {
  // Filing a passed cancel-after under "review the past" is how it stops being chased.
  const { forward, past } = splitAgenda(buildAgenda({
    ediCancels: [{ day: '2026-06-01', partner: 'Nordstrom', count: 4 }], today: TODAY,
  }))
  assert.equal(forward.length, 1, 'a missed deadline is not history')
  assert.equal(past.length, 0)
})

test('a past non-deadline goes to review', () => {
  const { forward, past } = splitAgenda(buildAgenda({
    arrivals: [{ day: '2026-07-01', pos: 3, units: 90 }], today: TODAY,
  }))
  assert.equal(forward.length, 0)
  assert.equal(past.length, 1)
})

test('review is ordered most-recent first', () => {
  const { past } = splitAgenda(buildAgenda({
    arrivals: [
      { day: '2026-07-01', pos: 1, units: 1 },
      { day: '2026-08-01', pos: 1, units: 1 },
    ],
    today: TODAY,
  }))
  assert.deepEqual(past.map((e) => e.day), ['2026-08-01', '2026-07-01'])
})

// ── Ordering and indexing ───────────────────────────────────────────────────

test('soonest first, and urgent kinds lead within a day', () => {
  const out = buildAgenda({
    orders: [so({ windowEnd: '2026-09-01' })],
    arrivals: [{ day: '2026-09-01', pos: 5, units: 10 }, { day: '2026-08-25', pos: 1, units: 1 }],
    today: TODAY,
  })
  assert.equal(out[0].day, '2026-08-25', 'soonest first')
  const sameDay = out.filter((e) => e.day === '2026-09-01')
  assert.equal(sameDay[0].kind, AGENDA.WINDOW_CLOSE, 'a deadline outranks an arrival on the same day')
})

test('byDay indexes every entry exactly once', () => {
  const entries = buildAgenda({
    orders: [so({ windowEnd: '2026-09-01' }), so({ soNumber: 'B', windowStart: '2026-09-01' })],
    today: TODAY,
  })
  const m = byDay(entries)
  assert.equal([...m.values()].flat().length, entries.length)
})

// ── Grid helpers, in UTC ────────────────────────────────────────────────────

test('a week runs Monday to Sunday', () => {
  const w = weekDays(new Date('2026-08-21T12:00:00Z'))   // a Friday
  assert.equal(w.length, 7)
  assert.equal(w[0], '2026-08-17')
  assert.equal(w[6], '2026-08-23')
})

test('a month grid is whole Monday-start weeks covering the month', () => {
  const d = monthDays(new Date('2026-08-21T12:00:00Z'))
  assert.equal(d.length % 7, 0, 'whole weeks only')
  assert.ok(d.includes('2026-08-01'))
  assert.ok(d.includes('2026-08-31'))
  assert.equal(d[0], '2026-07-27', 'padded back to the Monday before the 1st')
})

test('isoDay is UTC, so a Postgres DATE keeps its own day', () => {
  // A DATE arrives as UTC midnight; reading it in a local zone west of UTC would move
  // it back a day. That exact bug bit pipeline.js.
  assert.equal(isoDay(new Date('2026-08-21T00:00:00.000Z')), '2026-08-21')
  assert.equal(isoDay(null), null)
  assert.equal(isoDay('not a date'), null)
})

test('agendaSummary counts what it says it counts', () => {
  const s = agendaSummary(buildAgenda({
    orders: [so({ windowEnd: '2026-08-21' }), so({ soNumber: 'B', windowEnd: '2026-08-25' })],
    ediCancels: [{ day: '2026-06-01', partner: 'N', count: 1 }],
    arrivals: [{ day: '2026-12-01', pos: 1, units: 1 }],
    today: TODAY,
  }))
  assert.equal(s.today, 1)
  assert.equal(s.overdue, 1)
  assert.equal(s.next7, 2, 'today and the 25th; December is not in the next 7 days')
})
