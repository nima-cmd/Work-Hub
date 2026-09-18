// test/seasonBoard.test.js — POs grouped by the season they buy for.
//
// ⚠️ THE FIXTURES ARE THE REAL BOARD, measured 2026-09-18 across the 80 open POs:
// Core 14,593 units / 37 POs · Holiday 2026 6,547 / 41 · Resort 2026 4,518 / 23 ·
// Holiday 2025 3,475 / 15. Drops from the marketing calendar: Holiday 2026-10-13,
// Resort 2026-11-10.
//
// The load-bearing tests are the two counting traps: a PO that spans seasons must
// contribute its SLICE to each (not its total), and ordered units must never be read
// as units still arriving.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seasonBoard } from '../src/model/seasonBoard.js'

const DROPS = [
  { season: 'Fall', drop: 1, on: '2026-08-18', title: 'Fall Drop 1 Launch' },
  { season: 'Fall', drop: 2, on: '2026-09-08', title: 'Fall Drop 2 Launch' },
  { season: 'Holiday', drop: 1, on: '2026-10-13', title: 'Hoilday Launch', single: true },
  { season: 'Resort', drop: 1, on: '2026-11-10', title: 'Resort Launch', single: true },
]
const TODAY = new Date('2026-09-18')

test('POs group by season, and the drop date comes off the calendar', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1785', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-08',
      mix: [{ season: 'Holiday 2026', units: 1330 }] }],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((s) => s.label === 'Holiday 2026')
  assert.equal(h.units, 1330)
  assert.equal(h.drop.on, '2026-10-13')
  assert.equal(h.daysToDrop, 25)
})

test('⚠️ a PO spanning seasons contributes its SLICE to each, never its total', () => {
  // PO1722 is Fall 2026 = 765 and Holiday 2026 = 75 — 840 units in all. Crediting 840
  // to both would report 1,680 units bought off one 840-unit PO.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1722', destination: 'Warehouse', expectedReceipt: '2026-10-01',
      mix: [{ season: 'Fall 2026', units: 765 }, { season: 'Holiday 2026', units: 75 }] }],
    drops: DROPS, today: TODAY,
  })
  assert.equal(b.seasons.find((s) => s.label === 'Fall 2026').units, 765)
  assert.equal(b.seasons.find((s) => s.label === 'Holiday 2026').units, 75)
  assert.equal(b.totals.units, 840)
  // The PO is one PO, counted once, however many seasons it appears under.
  assert.equal(b.totals.pos, 1)
})

test('⚠️ ordered units and remaining units stay apart', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1830', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-01',
      qtyOrdered: 100, qtyRemaining: 40, mix: [{ season: 'Holiday 2026', units: 100 }] }],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((s) => s.label === 'Holiday 2026')
  // The season's figure is what was BOUGHT.
  assert.equal(h.units, 100)
  // What is still owing rides on the PO and is never summed into the season.
  assert.equal(h.pos[0].remaining, 40)
  assert.equal(h.remaining, undefined)
})

test('⚠️ Core is kept, and is explicitly not a drop', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1758', destination: 'Warehouse', expectedReceipt: '2026-10-01',
      mix: [{ season: 'Core', units: 14593 }] }],
    drops: DROPS, today: TODAY,
  })
  const core = b.seasons.find((s) => s.label === 'Core')
  assert.equal(core.kind, 'evergreen')
  assert.equal(core.drop, null)
  // Not late, and not "ok" either — there is no deadline to be either side of.
  assert.equal(core.state, 'no-deadline')
  assert.equal(core.units, 14593)
})

test('⚠️ unseasoned units are a group, not a discard', () => {
  // PO1761 is 720 units on items that carry no season at all.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1761', destination: 'China', mix: [{ season: null, units: 720 }] }],
    drops: DROPS, today: TODAY,
  })
  const g = b.seasons.find((s) => s.label === 'No season on the items')
  assert.equal(g.units, 720)
  assert.equal(b.totals.units, 720)
})

test('the lane breakdown is built from this season\'s slices', () => {
  const b = seasonBoard({
    pos: [
      { poNumber: 'PO-A', destination: 'Warehouse Bulk : Nordstrom', mix: [{ season: 'Holiday 2026', units: 200 }] },
      { poNumber: 'PO-B', destination: 'Virtual Warehouse', mix: [{ season: 'Holiday 2026', units: 900 }] },
      { poNumber: 'PO-C', destination: 'China', mix: [{ season: 'Holiday 2026', units: 500 }] },
    ],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((s) => s.label === 'Holiday 2026')
  assert.equal(h.units, 1600)
  // ⚠️ 1,600 bought, but the FOB 500 never enters our warehouse.
  assert.equal(h.arriving, 1100)
  assert.deepEqual(h.lanes.map((l) => l.lane), ['retail', 'partner', 'fob'])
})

test('a PO expected after its drop is late, and the PO is named', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-LATE', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-20',
      mix: [{ season: 'Holiday 2026', units: 300 }] }],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((s) => s.label === 'Holiday 2026')
  assert.equal(h.state, 'late')
  assert.equal(h.late[0].poNumber, 'PO-LATE')
  assert.equal(h.late[0].risk.days, 7)
})

test('⚠️ a restock has no deadline even when its season has a drop', () => {
  // dropRisk refuses to judge a restock against a launch — Summer stock arriving in
  // September is replenishment, not a missed date.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1820', destination: 'Virtual Warehouse', expectedReceipt: '2026-11-20',
      confirmed: { reason: 'restock' }, mix: [{ season: 'Holiday 2026', units: 70 }] }],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((s) => s.label === 'Holiday 2026')
  assert.equal(h.risks[0].risk.state, 'no-deadline')
  assert.equal(h.late.length, 0)
})

test('seasons sort by deadline, and the no-deadline groups fall to the back', () => {
  const b = seasonBoard({
    pos: [
      { poNumber: 'PO-1', destination: 'Warehouse', mix: [{ season: 'Core', units: 14593 }] },
      { poNumber: 'PO-2', destination: 'Warehouse', mix: [{ season: 'Resort 2026', units: 4518 }] },
      { poNumber: 'PO-3', destination: 'Warehouse', mix: [{ season: 'Holiday 2026', units: 6547 }] },
      { poNumber: 'PO-4', destination: 'Warehouse', mix: [{ season: 'Holiday 2025', units: 3475 }] },
    ],
    drops: DROPS, today: TODAY,
  })
  // Holiday (10-13) then Resort (11-10); Core and the 2025 season have no drop and
  // sort after both, biggest first.
  assert.deepEqual(b.seasons.map((s) => s.label),
    ['Holiday 2026', 'Resort 2026', 'Core', 'Holiday 2025'])
})

test('a program is not folded into a season', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-X', destination: 'Warehouse', mix: [{ season: 'Curated Shop 2026', units: 250 }] }],
    drops: DROPS, today: TODAY,
  })
  const g = b.seasons.find((s) => s.label === 'Curated Shop 2026')
  assert.equal(g.kind, 'program')
  assert.equal(g.program, 'Curated Shop')
  assert.equal(g.drop, null)
})

// ── The two bugs the first live run exposed (2026-09-18) ─────────────────────

test('⚠️ a past season\'s POs are restocks, NOT 227 days late', () => {
  // Caught on live data: the board reported 45 late POs, of which 34 were seasons whose
  // drop had already happened. dropRisk's restock guard keys on `reason`, and `reason`
  // came only from doc_seasons — which holds ONE row for the whole database — so the
  // guard was unreachable for 79 of 80 POs.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-SPRING', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-01',
      mix: [{ season: 'Spring 2026', units: 215 }] }],
    drops: [{ season: 'Spring', drop: 1, on: '2026-02-04', title: 'Spring Drop 1 Launch' }],
    today: TODAY,
  })
  const s = b.seasons.find((x) => x.label === 'Spring 2026')
  assert.equal(s.late.length, 0)
  assert.equal(s.risks[0].risk.state, 'no-deadline')
  // The reason was inferred, and says so.
  assert.equal(s.risks[0].reason, 'restock')
  assert.equal(s.risks[0].reasonSuggested, true)
  assert.match(s.risks[0].reasonWhy, /was \d+ days ago/)
})

test('⚠️ a season whose drop has passed is not "ok"', () => {
  // "ok" reads as "this season will make its launch" — about a launch nobody can still
  // miss. The verdicts decide the state, not the mere existence of a drop date.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-SPRING', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-01',
      mix: [{ season: 'Spring 2026', units: 215 }] }],
    drops: [{ season: 'Spring', drop: 1, on: '2026-02-04', title: 'Spring Drop 1 Launch' }],
    today: TODAY,
  })
  const s = b.seasons.find((x) => x.label === 'Spring 2026')
  assert.ok(s.drop, 'the drop date still exists')
  assert.equal(s.state, 'no-deadline')
  assert.notEqual(s.state, 'ok')
})

test('a season whose drop is still ahead DOES judge its POs', () => {
  // The guard must not swallow the real finding: Holiday 2026 is 25 days out, and a PO
  // landing after it is genuinely late.
  const b = seasonBoard({
    pos: [
      { poNumber: 'PO-OK', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-01',
        mix: [{ season: 'Holiday 2026', units: 100 }] },
      { poNumber: 'PO-LATE', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-20',
        mix: [{ season: 'Holiday 2026', units: 100 }] },
    ],
    drops: DROPS, today: TODAY,
  })
  const h = b.seasons.find((x) => x.label === 'Holiday 2026')
  assert.equal(h.state, 'late')
  assert.deepEqual(h.late.map((l) => l.poNumber), ['PO-LATE'])
  assert.equal(h.risks.find((r) => r.poNumber === 'PO-OK').reason, 'launch')
})

test('⚠️ a confirmed reason still outranks the calendar', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-C', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-20',
      confirmed: { reason: 'launch' }, mix: [{ season: 'Holiday 2026', units: 100 }] }],
    drops: DROPS, today: TODAY,
  })
  const r = b.seasons.find((x) => x.label === 'Holiday 2026').risks[0]
  assert.equal(r.reason, 'launch')
  assert.equal(r.reasonSuggested, false)
  assert.equal(r.reasonConfident, true)
})

test('⚠️ an order link makes it a re-order, which has no drop deadline', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-LINKED', destination: 'Warehouse Bulk : Nordstrom',
      expectedReceipt: '2026-10-20', orderLinks: [{ docType: 'SO', docNumber: 'SO123' }],
      mix: [{ season: 'Holiday 2026', units: 100 }] }],
    drops: DROPS, today: TODAY,
  })
  const r = b.seasons.find((x) => x.label === 'Holiday 2026').risks[0]
  assert.equal(r.reason, 'reorder')
  assert.equal(r.risk.state, 'no-deadline')
})

test('⚠️ a due date that has passed is withheld from the verdict', () => {
  // PO1747 was due 2026-07-01 and still owes units on 2026-09-18. The board announced
  // "expected 2026-07-01, 104 days before Hoilday Launch" — a reassuring sentence
  // computed from a date that went by 79 days ago. 34 of 80 open POs are past due.
  const b = seasonBoard({
    pos: [{ poNumber: 'PO1747', destination: 'Virtual Warehouse', expectedReceipt: '2026-07-01',
      mix: [{ season: 'Holiday 2026', units: 350 }] }],
    drops: DROPS, today: TODAY,
  })
  const r = b.seasons.find((s) => s.label === 'Holiday 2026').risks[0]
  assert.equal(r.overdue, 79)
  // No prediction is offered off a date that has gone by.
  assert.equal(r.risk.state, 'unknown')
  assert.match(r.risk.why, /nothing says when it arrives/)
  assert.doesNotMatch(r.risk.why, /104 days before/)
  assert.equal(b.totals.overdue, 1)
})

test('a due date still ahead is used exactly as before', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-FUTURE', destination: 'Virtual Warehouse', expectedReceipt: '2026-10-01',
      mix: [{ season: 'Holiday 2026', units: 100 }] }],
    drops: DROPS, today: TODAY,
  })
  const r = b.seasons.find((s) => s.label === 'Holiday 2026').risks[0]
  assert.equal(r.overdue, null)
  assert.equal(r.risk.state, 'ok')
  assert.match(r.risk.why, /12 days before/)
})

test('⚠️ an overdue PO is counted once however many seasons it spans', () => {
  const b = seasonBoard({
    pos: [{ poNumber: 'PO-MULTI', destination: 'Warehouse', expectedReceipt: '2026-07-01',
      mix: [{ season: 'Holiday 2026', units: 100 }, { season: 'Resort 2026', units: 50 }] }],
    drops: DROPS, today: TODAY,
  })
  assert.equal(b.totals.overdue, 1)
})
