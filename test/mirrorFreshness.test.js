// test/mirrorFreshness.test.js — is a table another repo owns still being written?
//
// `weaver_netsuite_item` holds every customs tariff code and is filled by ~/src/weaver.
// Nothing in Work-Hub maintains it. If that program stops, our codes silently age onto
// paperwork that goes to a carrier.
//
// ⚠️ THE LOAD-BEARING TESTS ARE THE TWO KINDS OF EMPTY. A mirror that was never
// populated and one that stopped last month need different sentences — the first is a
// setup nobody finished, the second is something that broke.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mirrorFreshness, MIRROR_WARN_DAYS, MIRROR_STALE_DAYS } from '../src/model/mirrorFreshness.js'

const NOW = new Date('2026-09-18T12:00:00Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()

test('refreshed today reads fresh', () => {
  const r = mirrorFreshness({ newestAt: daysAgo(0), now: NOW })
  assert.equal(r.state, 'fresh')
  assert.equal(r.ageDays, 0)
  assert.match(r.why, /refreshed today/)
})

test('a few days old is worth mentioning but is not an alarm', () => {
  const r = mirrorFreshness({ newestAt: daysAgo(MIRROR_WARN_DAYS), now: NOW })
  assert.equal(r.state, 'aging')
  assert.equal(r.ageDays, MIRROR_WARN_DAYS)
})

test('⚠️ past the stale threshold it says the other program may have STOPPED', () => {
  const r = mirrorFreshness({ newestAt: daysAgo(MIRROR_STALE_DAYS + 5), now: NOW })
  assert.equal(r.state, 'stale')
  assert.match(r.why, /may have stopped/)
  // And it dates the data, so a reader knows what the codes on the form actually are.
  assert.match(r.why, /2026-09-0/)
})

test('⚠️ an EMPTY table is its own state, not infinitely stale', () => {
  // A mirror never populated here and one that broke are different problems. This repo
  // hit the never-populated shape four times in one session.
  const r = mirrorFreshness({ newestAt: null, now: NOW })
  assert.equal(r.state, 'never')
  assert.equal(r.ageDays, null)
  assert.match(r.why, /has never populated it here/)
  assert.notEqual(r.state, 'stale')
})

test('⚠️ a FUTURE timestamp is reported, not rounded into a green tick', () => {
  // Two programs writing one database can disagree about the clock, and "fresher than
  // now" is a symptom worth seeing.
  const r = mirrorFreshness({ newestAt: new Date(NOW + 86400000).toISOString(), now: NOW })
  assert.equal(r.state, 'unknown')
  assert.match(r.why, /timestamp in the future/)
})

test('an unreadable timestamp says so rather than reading as fresh', () => {
  const r = mirrorFreshness({ newestAt: 'not a date', now: NOW })
  assert.equal(r.state, 'unknown')
  assert.match(r.why, /unreadable timestamp/)
})

test('the label and owner appear in the sentence, so the fix is obvious', () => {
  const r = mirrorFreshness({
    newestAt: daysAgo(30), now: NOW,
    label: 'the item catalogue', owner: 'the weaver sync',
  })
  assert.match(r.why, /the item catalogue/)
  assert.match(r.why, /the weaver sync/)
})

test('thresholds are ordered — warn before stale', () => {
  assert.ok(MIRROR_WARN_DAYS < MIRROR_STALE_DAYS)
})
