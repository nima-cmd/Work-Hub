import test from 'node:test'
import assert from 'node:assert/strict'
import {
  summarizeTransfer, verdictFor, MONTHLY_LIMIT_BYTES, fmtBytes,
} from '../src/model/transferMeter.js'

const MB = 1024 ** 2
const GB = 1024 ** 3

// ⚠️ THE SITUATION THIS EXISTS FOR. On 2026-08-14 Neon emailed that we were at 84%
// (4.2 GB) of 5 GB — on the FOURTEENTH. Exceeding it SUSPENDS the compute, so the
// deployed app stops. The first anyone knew was the email.

test('the real 2026-08-14 situation reads as critical, not as "84% is fine"', () => {
  const s = summarizeTransfer(
    [{ day: '2026-08-01', source: 'deploy', bytes: 4.2 * GB, queries: 1 }],
    { today: '2026-08-14' })
  assert.equal(s.verdict.level, 'critical')
  // 4.2 GB over 14 days = 300 MB/day; 0.8 GB left is under 3 days, with 17 to go.
  assert.ok(s.daysLeftAtRate < 3)
  assert.match(s.verdict.headline, /SUSPENDS the compute/)
})

// ⚠️ THE POINT OF THE PROJECTION. The same percentage means opposite things depending
// on the date — 84% on the 14th suspends the database mid-month, 84% on the 30th
// lands fine. A checker keyed on percentage would have said "warn" for both.
test('the same 84% is critical mid-month and merely a warning at month end', () => {
  const rows = [{ day: '2026-08-01', source: 'deploy', bytes: 4.2 * GB, queries: 1 }]
  // Day 14: 300 MB/day, 0.8 GB left — runs dry around the 17th, with two weeks of
  // month to go. The database stops.
  const mid = summarizeTransfer(rows, { today: '2026-08-14' })
  assert.equal(mid.verdict.level, 'critical')
  // Day 30: the same 84%, but only 140 MB/day, so it lands at ~4.3 GB and never
  // suspends. Still worth a warning — it is close — but NOT the same emergency, and
  // a checker keyed on percentage alone would have called these identical.
  const late = summarizeTransfer(rows, { today: '2026-08-30' })
  assert.equal(late.verdict.level, 'warn')
  assert.ok(late.projected < late.limitBytes)
  assert.ok(mid.daysLeftAtRate < 3 && late.daysLeftAtRate > 5)
})

test('a comfortable month is not nagged about', () => {
  const s = summarizeTransfer(
    [{ day: '2026-09-01', source: 'deploy', bytes: 200 * MB, queries: 400 }],
    { today: '2026-09-15' })
  assert.equal(s.verdict.level, 'ok')
})

test('already over reads as exceeded and says what that means', () => {
  const s = summarizeTransfer([{ day: '2026-08-01', source: 'deploy', bytes: 6 * GB, queries: 1 }],
    { today: '2026-08-20' })
  assert.equal(s.verdict.level, 'exceeded')
  assert.equal(s.remaining, 0)
  assert.match(s.verdict.headline, /suspends/i)
})

// ⚠️ THE WHOLE QUESTION on 2026-08-14 was WHO was burning it — the deployed app, the
// unattended cron, or development. A total cannot answer that, so the split is not
// optional.
test('the source split is what makes the number actionable', () => {
  const s = summarizeTransfer([
    { day: '2026-08-13', source: 'local', bytes: 250 * MB, queries: 4000 },
    { day: '2026-08-13', source: 'deploy', bytes: 40 * MB, queries: 900 },
    { day: '2026-08-14', source: 'local', bytes: 200 * MB, queries: 3000 },
    { day: '2026-08-14', source: 'cron', bytes: 30 * MB, queries: 500 },
  ], { today: '2026-08-14' })
  assert.deepEqual(s.bySource.map((x) => x.source), ['local', 'deploy', 'cron'])
  assert.equal(s.bySource[0].bytes, 450 * MB)   // development, by a mile
})

test('only the current month counts — last month is not our problem', () => {
  const s = summarizeTransfer([
    { day: '2026-07-30', source: 'deploy', bytes: 4 * GB, queries: 1 },
    { day: '2026-08-02', source: 'deploy', bytes: 100 * MB, queries: 1 },
  ], { today: '2026-08-14' })
  assert.equal(s.used, 100 * MB)
  assert.equal(s.verdict.level, 'ok')
})

// ⚠️ Our count excludes TLS and wire framing, so it is a LOWER BOUND. When Neon's own
// figure is known it must win, because Neon's number is the one that suspends the
// database — ours is only for attribution.
test('a figure from Neon replaces our estimate as the baseline', () => {
  const rows = [{ day: '2026-08-01', source: 'local', bytes: 500 * MB, queries: 10 }]
  const guess = summarizeTransfer(rows, { today: '2026-08-14' })
  assert.equal(guess.isEstimate, true)

  const known = summarizeTransfer(rows, { today: '2026-08-14', knownUsed: 4.2 * GB })
  assert.equal(known.isEstimate, false)
  assert.equal(known.used, 4.2 * GB)
  assert.equal(known.verdict.level, 'critical')
  assert.equal(known.measured, 500 * MB)   // ours is still reported, as attribution
})

test('every summary carries the caveat that it is not the bill', () => {
  assert.match(summarizeTransfer([], { today: '2026-08-14' }).caveat, /Neon's console is the authority/)
})

test('no data is not an alarm', () => {
  const s = summarizeTransfer([], { today: '2026-08-14' })
  assert.equal(s.used, 0)
  assert.equal(s.verdict.level, 'ok')
  assert.deepEqual(s.bySource, [])
})

test('bytes read as human sizes', () => {
  assert.equal(fmtBytes(4.2 * GB), '4.20 GB')
  assert.equal(fmtBytes(300 * MB), '300.0 MB')
  assert.equal(fmtBytes(null), '—')
})

test('the limit is the Free plan figure', () => {
  assert.equal(MONTHLY_LIMIT_BYTES, 5 * GB)
})

test('verdictFor needs no rows — it is the rule, not the data', () => {
  assert.equal(verdictFor({ used: 0, projected: 0, limitBytes: 5 * GB }).level, 'ok')
})
