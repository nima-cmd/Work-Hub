import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REFRESH_STEPS, REFRESH_STEP_TOTAL, refreshProgress } from '../src/model/netsuiteRefreshSteps.js'

// The denominator of a progress bar is a promise about how much work there is.
// If an emitter stops firing, the bar silently stops before 100%; if one fires a
// key the list never got, the bar freezes at whatever came before. Neither shows
// up as a failure anywhere — the pull still succeeds — so the two sides are
// checked against each other mechanically rather than by eye.
const EMITTERS = ['src/ingest/netsuiteSync.js', 'server/queries.js']
const emittedKeys = () => {
  const found = new Set()
  for (const f of EMITTERS) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    for (const m of src.matchAll(/onStep\?\.\(\s*'([a-zA-Z]+)'\s*\)/g)) found.add(m[1])
    // fetchOrderLifecycle's six pulls pass their key as run()'s LAST argument —
    // greedy on purpose, since the middle argument is itself a call with parens.
    for (const m of src.matchAll(/await run\(.*,\s*'([a-zA-Z]+)'\)/g)) found.add(m[1])
  }
  return found
}

test('refreshSteps: every step in the list is actually emitted by the sync', () => {
  const emitted = emittedKeys()
  const missing = REFRESH_STEPS.map((s) => s.key).filter((k) => !emitted.has(k))
  assert.deepEqual(missing, [], `steps in the total that nothing reports: ${missing.join(', ')}`)
})

test('refreshSteps: every key the sync emits is in the list', () => {
  const known = new Set(REFRESH_STEPS.map((s) => s.key))
  const stray = [...emittedKeys()].filter((k) => !known.has(k))
  assert.deepEqual(stray, [], `emitted keys the bar cannot place: ${stray.join(', ')}`)
})

test('refreshSteps: the total is the list, so a label and its count cannot drift apart', () => {
  assert.equal(REFRESH_STEP_TOTAL, REFRESH_STEPS.length)
  // Every step reports the same total — the bug shape where a percentage is
  // computed against a hardcoded denominator someone forgot to update.
  for (const s of REFRESH_STEPS) assert.equal(refreshProgress(s.key).total, REFRESH_STEP_TOTAL)
})

test('refreshSteps: keys are unique — a step emitted twice would rewind the bar', () => {
  const keys = REFRESH_STEPS.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('refreshSteps: every step carries a phase and a label short enough for the button', () => {
  for (const s of REFRESH_STEPS) {
    assert.ok(s.phase, `${s.key} has no phase`)
    assert.ok(s.label, `${s.key} has no label`)
    // The sub-line renders "<label> · nn/nn" inside a header button. Labels are
    // deliberately nouns, not sentences — the phase carries the verb.
    assert.ok(s.label.length <= 16, `${s.key}'s label "${s.label}" will clip`)
  }
})

test('refreshSteps: the bar fills to work FINISHED, never counting the step in flight', () => {
  const first = refreshProgress('orders')
  assert.equal(first.done, 0)
  assert.equal(first.percent, 0) // the first query has gone out; nothing has come back
  assert.equal(first.label, 'orders')

  const last = refreshProgress(REFRESH_STEPS[REFRESH_STEPS.length - 1].key)
  assert.equal(last.done, REFRESH_STEP_TOTAL - 1)
  assert.ok(last.percent < 100) // 100% is only ever the finished result, not a step
})

test('refreshSteps: progress is monotonic in list order', () => {
  let prev = -1
  for (const s of REFRESH_STEPS) {
    const p = refreshProgress(s.key)
    assert.ok(p.percent >= prev, `${s.key} went backwards`)
    prev = p.percent
  }
})

test('refreshSteps: an unknown key holds still rather than guessing a position', () => {
  // A step that isn't in the plan the total came from cannot be placed against
  // it, and inventing a position is how a bar starts reporting a number that
  // means nothing. null leaves the last real step on screen.
  assert.equal(refreshProgress('somethingElse'), null)
  assert.equal(refreshProgress(undefined), null)
  assert.equal(refreshProgress(null), null)
})
