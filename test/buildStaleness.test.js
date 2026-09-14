// test/buildStaleness.test.js — the guard for a bundle older than its source.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStaleness, ago, GRACE_MS, WATCHED } from '../src/model/buildStaleness.js'

const T = new Date('2026-09-11T17:00:00Z').getTime()
const mins = (n) => n * 60_000
const hrs = (n) => n * 3_600_000

test('⚠️ THE REAL CASE: a two-day-old bundle served without comment', () => {
  // client/dist was built 2026-09-09 14:31; the source moved on and :3001 kept
  // serving the old bundle. Nima reported a working feature as missing.
  const r = buildStaleness({
    builtAt: '2026-09-09T21:31:00Z',
    newestSrc: '2026-09-11T17:39:00Z',
    newestFile: 'client/src/views/Crew.jsx',
    now: T,
  })
  assert.equal(r.state, 'stale')
  assert.equal(r.stale, true)
  // ⚠️ 44 hours, and it must not read as "1 day". Flooring alone halves the
  // apparent age of the very build that caused this.
  assert.equal(r.behindLabel, '1 day 20 hours')
  // The message must name the file AND both ways out — rebuild, or use :5173.
  assert.match(r.message, /Crew\.jsx/)
  assert.match(r.message, /client:build/)
  assert.match(r.message, /5173/)
})

test('⚠️ NO BUILD IS ITS OWN STATE, not "infinitely stale"', () => {
  // :3001 serving nothing is a different problem with a different fix. Reporting
  // it as a stale build sends someone to run a rebuild they have never run.
  const r = buildStaleness({ builtAt: null, newestSrc: T, now: T })
  assert.equal(r.state, 'missing')
  assert.equal(r.stale, true)
  assert.equal(r.behindMs, null, 'there is no "behind" without a build to be behind')
  assert.match(r.message, /nothing to serve/)
})

test('⚠️ UNREADABLE SOURCE TIMES REPORT UNVERIFIED, NEVER FRESH', () => {
  // [[default-is-not-an-answer]]. Treating an unreadable mtime as fresh is the
  // banner claiming the thing it cannot see.
  const r = buildStaleness({ builtAt: T, newestSrc: null, now: T })
  assert.equal(r.state, 'unknown')
  assert.equal(r.stale, false, 'unknown must not cry wolf either')
  assert.match(r.message, /unverified/)
})

test('a build finished seconds after the last edit is concurrent, not stale', () => {
  // A build reads the files it is bundling, so its output is always a moment
  // behind the newest source. Without the grace every fresh build reads stale.
  const r = buildStaleness({ builtAt: T, newestSrc: T + GRACE_MS - 1, now: T })
  assert.equal(r.state, 'fresh')
  assert.equal(r.stale, false)
  const past = buildStaleness({ builtAt: T, newestSrc: T + GRACE_MS + 1, now: T })
  assert.equal(past.state, 'stale', 'and one tick past the grace it is stale')
})

test('a build newer than every source is fresh, and says how old it is', () => {
  const r = buildStaleness({ builtAt: T - mins(20), newestSrc: T - hrs(3), now: T })
  assert.equal(r.state, 'fresh')
  assert.equal(r.behindMs, 0, 'a negative lag is clamped, never shown as "-3 hours behind"')
  assert.match(r.message, /20 minutes/)
})

test('⚠️ src/model IS WATCHED — the client imports it directly', () => {
  // The trap this nearly missed: client/src/views/Crew.jsx imports
  // ../../../src/model/characters.js, so editing only a model file changes the UI
  // while nothing under client/ moves. Watching client/ alone would have called
  // the exact build that broke today "fresh".
  assert.ok(WATCHED.includes('src/model'))
  assert.ok(WATCHED.includes('client/src'))
  assert.ok(WATCHED.includes('client/index.html'))
})

test('ago() reports whole units', () => {
  assert.equal(ago(0), 'under a minute')
  assert.equal(ago(mins(1)), '1 minute')
  assert.equal(ago(mins(59)), '59 minutes')
  assert.equal(ago(hrs(1)), '1 hour')
  assert.equal(ago(hrs(24)), '1 day', 'an exact day carries no remainder')
  assert.equal(ago(hrs(25)), '1 day 1 hour')
  assert.equal(ago(hrs(24 * 2 + 1)), '2 days 1 hour', 'never "2.04 days"')
  assert.equal(ago(hrs(24 * 9 + 5)), '9 days', 'past a week the hours stop mattering')
  assert.equal(ago(-5), 'under a minute', 'a negative span must not print "-1 minutes"')
})
