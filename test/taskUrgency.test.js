import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTaskUrgency, AGE_STALE_DAYS } from '../src/model/taskUrgency.js'

// Nima, 2026-08-05: "if the app can learn and set urgency with a manual overrid it
// be best." These lock down what "learn" means and what the override may not do.
const T0 = new Date('2026-08-05T09:00:00').getTime()
const DAY = 86400000
const ago = (d) => new Date(T0 - d * DAY).toISOString()

test('a real due date outranks everything derived', () => {
  const due = deriveTaskUrgency({ createdAt: ago(1), dueAt: new Date(T0).toISOString() }, { now: T0 })
  assert.equal(due.level, 'hi')
  assert.match(due.basis, /due now/)
})

test("an urgent linked order makes its task urgent", () => {
  // severity 3 is the app's own "act now" tier (src/model/pipeline.js).
  const u = deriveTaskUrgency({ createdAt: ago(1) }, { now: T0, linkedSeverity: 3 })
  assert.equal(u.level, 'hi')
  assert.match(u.basis, /its order/)
  // severity 2 is caution, not act-now
  assert.equal(deriveTaskUrgency({ createdAt: ago(1) }, { now: T0, linkedSeverity: 2 }).level, 'mid')
})

// ⚠️ THE BUG THIS CAUGHT ON ITS FIRST RUN. With no due dates in the data (0 of 34
// open tasks had one) and no linked severity passed in, 'hi' had no source at all —
// the scale silently collapsed to mid/lo, which is the unreachable-branch shape this
// repo keeps producing. So 'hi' must have at least one reachable route from data
// alone, and the linked-order route is it.
test("'hi' is reachable without anyone hand-setting a due date", () => {
  const fromLink = deriveTaskUrgency({ createdAt: ago(3) }, { now: T0, linkedSeverity: 3 })
  assert.equal(fromLink.level, 'hi')
  assert.equal(fromLink.override, null)   // earned, not set
})

test('age tops out at mid — old is neglect, not a deadline', () => {
  const old = deriveTaskUrgency({ createdAt: ago(90) }, { now: T0 })
  assert.equal(old.level, 'mid')          // NOT hi, however old it gets
  assert.match(old.basis, /decide or drop/)
  const stale = deriveTaskUrgency({ createdAt: ago(AGE_STALE_DAYS) }, { now: T0 })
  assert.equal(stale.level, 'mid')
  const recent = deriveTaskUrgency({ createdAt: ago(1) }, { now: T0 })
  assert.equal(recent.level, 'lo')
})

test('a recurring task is due today by construction', () => {
  const r = deriveTaskUrgency({ createdAt: ago(1), recurringKey: 'airtable' }, { now: T0 })
  assert.equal(r.level, 'mid')
  assert.match(r.basis, /recurring/)
})

test('the manual override wins, and says so', () => {
  // A task the app would call 'lo' that Nima marks urgent — his call stands.
  const up = deriveTaskUrgency({ createdAt: ago(1), urgencyOverride: 'hi' }, { now: T0 })
  assert.equal(up.level, 'hi')
  assert.equal(up.basis, 'you set this')
  assert.equal(up.derived, 'lo')          // what it would have been, kept visible

  // ...and the reverse: quieting something the app thinks is urgent.
  const down = deriveTaskUrgency({ createdAt: ago(90), urgencyOverride: 'lo' }, { now: T0, linkedSeverity: 3 })
  assert.equal(down.level, 'lo')
  assert.equal(down.derived, 'hi')

  // A junk override is ignored rather than trusted — it must not blank the scale.
  const junk = deriveTaskUrgency({ createdAt: ago(90), urgencyOverride: 'URGENT!!' }, { now: T0 })
  assert.equal(junk.level, 'mid')
  assert.equal(junk.override, null)
})

test('every result explains itself', () => {
  // An urgency nobody can explain is one nobody trusts — and it is what let the old
  // hand-set field sit at 16-of-34 'hi' with no reason attached to any of them.
  for (const t of [
    { createdAt: ago(1) }, { createdAt: ago(20) }, { createdAt: ago(8) },
    { createdAt: ago(1), recurringKey: 'k' }, { createdAt: ago(1), urgencyOverride: 'hi' },
    { createdAt: ago(1), needsType: 'reply' },
  ]) {
    const u = deriveTaskUrgency(t, { now: T0 })
    assert.ok(u.basis && u.basis.length > 3, `no basis for ${JSON.stringify(t)}`)
    assert.ok(['hi', 'mid', 'lo'].includes(u.level))
  }
})
