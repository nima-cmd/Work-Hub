import test from 'node:test'
import assert from 'node:assert/strict'
import { PULSE_INTERVAL_MS, PULSE_SOURCES, pulseChanged, pulseVersion } from '../src/model/pulse.js'

// ⚠️ WHY THIS EXISTS. Nima, 2026-08-19: the board went stale until he reloaded — a
// carton he scanned did not appear as in-possession. Polling the board itself was not an
// option: refresh() is 16 requests, ~1.5 MB and ~400 queries, so 15s polling would be
// ~96k queries an hour from ONE tab against a single vCPU. This is the cheap question
// asked instead.

test('the version is stable for the same inputs and moves for different ones', () => {
  const a = pulseVersion({ events: '10', orders: '2026-08-19T10:00:00Z', fulfillments: 'x', activity: '3' })
  const b = pulseVersion({ events: '10', orders: '2026-08-19T10:00:00Z', fulfillments: 'x', activity: '3' })
  assert.equal(a, b)
  assert.notEqual(a, pulseVersion({ events: '11', orders: '2026-08-19T10:00:00Z', fulfillments: 'x', activity: '3' }))
})

// ⚠️ THE CASE NIMA HIT. Marking something packed UPDATES a row — it does not add one.
// A count-based signal would not move; MAX(updated_at) does. Measuring something
// adjacent to the question instead of the question is this repo's recurring counter bug.
test('an in-place UPDATE changes the version', () => {
  const before = pulseVersion({ events: '10', orders: '2026-08-19T10:00:00Z' })
  const after = pulseVersion({ events: '10', orders: '2026-08-19T10:05:00Z' })
  assert.notEqual(before, after, 'an updated_at moving must change the version')
})

// ⚠️ A part going missing must not collide with a previous version — otherwise a table
// emptying reads as "nothing changed".
test('a missing part is marked, not dropped', () => {
  assert.equal(pulseVersion({ events: '10' }).split('|').length, PULSE_SOURCES.length)
  assert.notEqual(pulseVersion({ events: '10' }), pulseVersion({}))
  assert.notEqual(pulseVersion({ events: null }), pulseVersion({ events: '0' }))
  assert.notEqual(pulseVersion({ events: '' }), pulseVersion({ events: 'x' }))
})

// ⚠️ THE FIRST LOAD IS NOT A CHANGE. Without this the app would fire a full 1.5 MB
// refresh immediately after mounting, having just loaded everything.
test('unknown -> known is not a change', () => {
  assert.equal(pulseChanged(null, 'a|b|c|d'), false)
  assert.equal(pulseChanged(undefined, 'a|b|c|d'), false)
})

test('known -> different is a change; known -> same is not', () => {
  assert.equal(pulseChanged('a|b|c|d', 'a|b|c|X'), true)
  assert.equal(pulseChanged('a|b|c|d', 'a|b|c|d'), false)
})

// Each source must be a single cheap lookup — the whole premise is that asking is
// nearly free. A source that scanned a table would defeat the point.
test('every source is one MAX() lookup with no join or filter', () => {
  assert.ok(PULSE_SOURCES.length >= 3)
  for (const [key, sql] of PULSE_SOURCES) {
    assert.ok(key && typeof key === 'string')
    assert.match(sql, /^SELECT MAX\([a-z_]+\)::text AS v FROM [a-z_]+$/)
  }
})

test('the interval is paused-when-hidden friendly and not chatty', () => {
  assert.ok(PULSE_INTERVAL_MS >= 10_000, 'more often than 10s is chatty for one vCPU')
  assert.ok(PULSE_INTERVAL_MS <= 30_000, 'less often than 30s stops feeling live')
})
