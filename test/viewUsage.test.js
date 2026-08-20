import test from 'node:test'
import assert from 'node:assert/strict'
import { usageReport, verdictFor, applyVisit, humanMs, GLANCE_MS } from '../src/model/viewUsage.js'

const VIEWS = [
  { key: 'command', label: 'Command' },
  { key: 'kanban', label: 'Mission Quests' },
  { key: 'crew', label: 'Crew' },
]

test('a view that exists but was never opened still appears in the report', () => {
  // A report listing only what was used cannot answer "what is unused", which is the
  // whole question Nima asked.
  const r = usageReport({}, VIEWS)
  assert.equal(r.rows.length, 3)
  assert.equal(r.totals.neverOpened, 3)
  assert.ok(r.rows.every((x) => x.verdict === 'unused' || x.verdict === 'default'))
})

// ── The default view's opens are not a choice ────────────────────────────────

test("the landing view's opens are flagged NOT comparable", () => {
  // Command is opened by every page load, refresh and dev-server reload. Ranking that
  // against views someone deliberately clicked is the "counts something other than
  // its label" bug shape.
  const usage = { command: { opens: 400, dwellMs: 5000 }, kanban: { opens: 12, dwellMs: 600000 } }
  const r = usageReport(usage, VIEWS, { defaultView: 'command' })
  const cmd = r.rows.find((x) => x.key === 'command')
  assert.equal(cmd.isDefault, true)
  assert.equal(cmd.opensComparable, false)
  assert.equal(cmd.verdict, 'default')
  const kanban = r.rows.find((x) => x.key === 'kanban')
  assert.equal(kanban.opensComparable, true)
})

test('with no default declared, nothing is exempted', () => {
  const r = usageReport({ command: { opens: 5, dwellMs: 90000 } }, VIEWS)
  assert.equal(r.rows.find((x) => x.key === 'command').opensComparable, true)
})

// ── Dwell is the honest ranking ──────────────────────────────────────────────

test('rows rank by DWELL, not by opens', () => {
  const usage = {
    crew: { opens: 50, dwellMs: 1000 },        // opened constantly, never read
    kanban: { opens: 3, dwellMs: 1800000 },    // opened rarely, worked in for 30m
  }
  const r = usageReport(usage, VIEWS)
  assert.equal(r.rows[0].key, 'kanban', 'time spent beats times opened')
})

test('a view opened and abandoned reads as glanced, not used', () => {
  const r = usageReport({ crew: { opens: 8, dwellMs: GLANCE_MS - 1 } }, VIEWS)
  assert.equal(r.rows.find((x) => x.key === 'crew').verdict, 'glanced')
  assert.equal(r.totals.glanceOnly, 1)
})

test('avgMs is null when never opened, never a real-looking zero', () => {
  const r = usageReport({}, VIEWS)
  assert.equal(r.rows[0].avgMs, null)
})

test('avgMs is dwell per visit', () => {
  const r = usageReport({ kanban: { opens: 4, dwellMs: 40000 } }, VIEWS)
  assert.equal(r.rows.find((x) => x.key === 'kanban').avgMs, 10000)
})

// ── The 'unused' verdict must not retire a view that never had a chance ──────

test('the report carries trackedSince so unused cannot be read as unwanted', () => {
  // A view added yesterday is 'unused' and perfectly fine. Without the date beside
  // it, this word would retire it.
  const r = usageReport({ kanban: { opens: 1, dwellMs: 9999, firstAt: '2026-08-20T10:00:00Z' } }, VIEWS)
  assert.equal(r.totals.trackedSince, '2026-08-20T10:00:00Z')
})

test('trackedSince is the EARLIEST first-seen across views', () => {
  const r = usageReport({
    kanban: { opens: 1, dwellMs: 1, firstAt: '2026-08-20T10:00:00Z' },
    crew: { opens: 1, dwellMs: 1, firstAt: '2026-08-18T10:00:00Z' },
  }, VIEWS)
  assert.equal(r.totals.trackedSince, '2026-08-18T10:00:00Z')
})

test('daysSince is null when never opened rather than a huge number', () => {
  const r = usageReport({}, VIEWS, { now: Date.parse('2026-08-20T00:00:00Z') })
  assert.equal(r.rows[0].daysSince, null)
})

test('daysSince counts whole days back from now', () => {
  const r = usageReport(
    { kanban: { opens: 1, dwellMs: 5000, lastAt: '2026-08-18T00:00:00Z' } },
    VIEWS, { now: Date.parse('2026-08-20T12:00:00Z') },
  )
  assert.equal(r.rows.find((x) => x.key === 'kanban').daysSince, 2)
})

// ── The increment rule (must match the SQL that does it atomically) ──────────

test('a visit increments opens and adds dwell', () => {
  let u = {}
  u = applyVisit(u, { view: 'kanban', dwellMs: 1000, at: '2026-08-20T10:00:00Z' })
  u = applyVisit(u, { view: 'kanban', dwellMs: 2500, at: '2026-08-20T11:00:00Z' })
  assert.deepEqual(u.kanban, {
    opens: 2, dwellMs: 3500,
    firstAt: '2026-08-20T10:00:00Z', lastAt: '2026-08-20T11:00:00Z',
  })
})

test('firstAt is never overwritten by a later visit', () => {
  let u = applyVisit({}, { view: 'x', at: '2026-01-01T00:00:00Z' })
  u = applyVisit(u, { view: 'x', at: '2026-06-01T00:00:00Z' })
  assert.equal(u.x.firstAt, '2026-01-01T00:00:00Z')
  assert.equal(u.x.lastAt, '2026-06-01T00:00:00Z')
})

test('a NEGATIVE dwell is clamped, never subtracted from real recorded time', () => {
  // A negative delta means the clock moved — a laptop sleep, a timezone change.
  // Adding it would silently erase time that was actually spent.
  let u = applyVisit({}, { view: 'x', dwellMs: 60000 })
  u = applyVisit(u, { view: 'x', dwellMs: -500000 })
  assert.equal(u.x.dwellMs, 60000)
})

test('a junk dwell contributes nothing rather than NaN', () => {
  const u = applyVisit({}, { view: 'x', dwellMs: 'banana' })
  assert.equal(u.x.dwellMs, 0)
  assert.equal(u.x.opens, 1)
})

test('a visit with no view is ignored rather than stored under undefined', () => {
  assert.deepEqual(applyVisit({}, {}), {})
  assert.deepEqual(applyVisit({ a: { opens: 1 } }, { view: null }), { a: { opens: 1 } })
})

test('applyVisit does not mutate what it was given', () => {
  const before = { x: { opens: 1, dwellMs: 10 } }
  const after = applyVisit(before, { view: 'x', dwellMs: 5 })
  assert.equal(before.x.opens, 1, 'the input must be untouched')
  assert.equal(after.x.opens, 2)
})

// ── Formatting ───────────────────────────────────────────────────────────────

test('humanMs reads as a duration a person would say', () => {
  assert.equal(humanMs(0), '0s')
  assert.equal(humanMs(900), '0s')
  assert.equal(humanMs(4000), '4s')
  assert.equal(humanMs(90000), '2m')
  assert.equal(humanMs(3600000), '1h 0m')
  assert.equal(humanMs(5400000), '1h 30m')
})

test('humanMs survives junk', () => {
  assert.equal(humanMs(null), '0s')
  assert.equal(humanMs('x'), '0s')
})

test('verdictFor is coarse on purpose and covers every case', () => {
  assert.equal(verdictFor({ isDefault: true }), 'default')
  assert.equal(verdictFor({ opens: 0 }), 'unused')
  assert.equal(verdictFor({ opens: 3, dwellMs: 100 }), 'glanced')
  assert.equal(verdictFor({ opens: 3, dwellMs: 60000 }), 'used')
  assert.equal(verdictFor({}), 'unused')
})
