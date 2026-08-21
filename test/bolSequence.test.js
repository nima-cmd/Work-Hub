import test from 'node:test'
import assert from 'node:assert/strict'
import { bolSequenceVerdict } from '../src/model/bolSequence.js'

// A BOL number must NEVER be reused. The generator is 'NB' || nextval(bol_number_seq),
// so that guarantee holds only while the sequence is strictly above every number in
// bol_registry. It stopped being, and Nima found out by trying to make a BOL.

test('the real failure: sequence at 1731240, registry up to 1731267', () => {
  const v = bolSequenceVerdict({ lastValue: '1731240', isCalled: true, maxUsed: '1731267' })
  assert.equal(v.next, 1731241, 'the number it would have tried to mint')
  assert.equal(v.behind, true)
  assert.equal(v.collisions, 27, 'every one of the next 27 attempts collides')
  assert.equal(v.shouldBe, 1731267, 'so the next number is 1731268 — above everything minted')
})

test('⚠️ bigint arrives from pg as a STRING and must be coerced', () => {
  // '1731240' + 1 === '17312401', which is ahead of everything and would report
  // healthy while the collision kept happening.
  const v = bolSequenceVerdict({ lastValue: '1731240', isCalled: true, maxUsed: '1731267' })
  assert.equal(typeof v.next, 'number')
  assert.equal(v.next, 1731241)
})

test('healthy: the sequence is above the registry', () => {
  const v = bolSequenceVerdict({ lastValue: '1731267', isCalled: true, maxUsed: '1731267' })
  assert.equal(v.next, 1731268)
  assert.equal(v.behind, false)
  assert.equal(v.collisions, 0)
})

test('exactly level is STILL BEHIND — next would reissue the highest number', () => {
  // The off-by-one that matters: last_value 1731266 hands out 1731267, which exists.
  const v = bolSequenceVerdict({ lastValue: '1731266', isCalled: true, maxUsed: '1731267' })
  assert.equal(v.behind, true)
  assert.equal(v.collisions, 1)
})

test('is_called=false means last_value has NOT been handed out yet', () => {
  const v = bolSequenceVerdict({ lastValue: '1731268', isCalled: false, maxUsed: '1731267' })
  assert.equal(v.next, 1731268, 'it is next, not next+1')
  assert.equal(v.behind, false)
})

test('an empty registry can never be behind', () => {
  const v = bolSequenceVerdict({ lastValue: '1', isCalled: false, maxUsed: null })
  assert.equal(v.behind, false)
  assert.equal(v.maxUsed, null)
  assert.equal(v.collisions, 0)
})

test('the repair is forward-only — shouldBe never moves the sequence back', () => {
  const ahead = bolSequenceVerdict({ lastValue: '9999999', isCalled: true, maxUsed: '1731267' })
  assert.equal(ahead.shouldBe, 9999999, 'a healthy sequence is left exactly where it is')
  assert.equal(ahead.behind, false)
})
