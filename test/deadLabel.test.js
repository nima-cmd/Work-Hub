import test from 'node:test'
import assert from 'node:assert/strict'
import { labelTracking, labelCount, isLabelled, DEAD_LABEL_SQL } from '../src/model/labelEvidence.js'
import { shipstationEligibility, HOLD } from '../src/model/shipstationEligible.js'

// IF7486, live 2026-08-13: one NetSuite label, wrong, and NetSuite will not replace it.
const NS = '1ZC6J6100316720788'

test('a dead label stops counting as evidence', () => {
  assert.equal(labelCount({ nsTracking: [NS] }), 1)
  assert.equal(labelCount({ nsTracking: [NS], deadTracking: [NS] }), 0)
  assert.equal(isLabelled({ nsTracking: [NS], deadTracking: [NS] }), false)
})

test('only the named number dies — an IF can carry several', () => {
  const t = labelTracking({ nsTracking: [NS, '1ZC6J6100999999999'], deadTracking: [NS] })
  assert.deepEqual(t, ['1ZC6J6100999999999'])
})

test('a dead ShipStation label is excluded too, from either source', () => {
  assert.deepEqual(labelTracking({ ssTracking: ['1Z18GE010320563727'], deadTracking: ['1Z18GE010320563727'] }), [])
})

// The marker is matched on the trimmed string, the same normalisation the merge
// uses. A marker that failed to match its own number would silently do nothing —
// the exact failure mode this module exists to prevent.
test('whitespace does not stop a marker matching', () => {
  assert.equal(labelCount({ nsTracking: [` ${NS} `], deadTracking: [NS] }), 0)
  assert.equal(labelCount({ nsTracking: [NS], deadTracking: [` ${NS} `] }), 0)
})

test('marking a label dead does not invent one', () => {
  assert.equal(labelCount({ nsTracking: null, deadTracking: [NS] }), 0)
  assert.deepEqual(labelTracking({ deadTracking: [NS] }), [])
})

// ── the gate this exists to unblock ──────────────────────────────────────────
const if7486 = (over = {}) => ({
  status: 'Packed', carrier: 'UPS', shipMethodName: 'UPS Ground',
  country: 'US', hasAddress: true, ...over,
})

test('IF7486 as it stood: refused with ALREADY_LABELLED', () => {
  const v = shipstationEligibility(if7486({ labelCount: labelCount({ nsTracking: [NS] }) }))
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.ALREADY_LABELLED)
})

// ⚠️ With the label declared dead the count is 0, so the row falls through to the
// NEXT question rather than being waved through. `Packed` with no usable label is
// PACKED_NO_LABEL — which is the honest answer and still needs a human.
test('once the label is dead the gate stops saying "already labelled"', () => {
  const v = shipstationEligibility(if7486({ labelCount: labelCount({ nsTracking: [NS], deadTracking: [NS] }) }))
  assert.notEqual(v.hold, HOLD.ALREADY_LABELLED)
  // Without the marker being DECLARED, a Packed box with no label is still held —
  // that row needs a human, and no one has spoken for it.
  assert.equal(v.hold, HOLD.PACKED_NO_LABEL)
})

// ⚠️ The case the whole marker exists for. IF7486 is PACKED, so clearing
// ALREADY_LABELLED alone left it stuck on PACKED_NO_LABEL. But that hold means "the
// premise failed, a human must look" — and the dead_label row IS that human. Safe by
// construction: reaching it requires labelCount === 0, so there is no live label.
test('a PACKED box whose label was declared dead can be pushed', () => {
  const v = shipstationEligibility(if7486({
    labelCount: labelCount({ nsTracking: [NS], deadTracking: [NS] }), deadLabelCount: 1,
  }))
  assert.equal(v.push, true)
  assert.equal(v.serviceCode, 'ups_ground')
  assert.equal(v.hold, null)
})

test('a declared-dead label does not wave through a non-UPS carrier', () => {
  const v = shipstationEligibility(if7486({
    shipMethodName: 'FedEx Ground', labelCount: 0, deadLabelCount: 1,
  }))
  assert.equal(v.push, false)
  assert.equal(v.hold, HOLD.CARRIER_NOT_SET_UP)
})

// The double-label rule is untouched: a LIVE label still ends the question, and
// killing a DIFFERENT number does not help.
test('a live label still ends the question', () => {
  const v = shipstationEligibility(if7486({
    status: 'Picked',
    labelCount: labelCount({ nsTracking: [NS], deadTracking: ['1ZSOMETHINGELSE'] }),
  }))
  assert.equal(v.hold, HOLD.ALREADY_LABELLED)
})

test('a Picked fulfilment whose only label is dead becomes pushable', () => {
  const v = shipstationEligibility(if7486({
    status: 'Picked', labelCount: labelCount({ nsTracking: [NS], deadTracking: [NS] }),
  }))
  assert.equal(v.push, true)
  assert.equal(v.serviceCode, 'ups_ground')
})

// ⚠️ Interpolated into template-literal SQL in server/queries.js, where a backtick
// closes the string and 500s the entire API. This has bitten the repo before.
test('the SQL fragment carries no backtick', () => {
  assert.equal(DEAD_LABEL_SQL.includes('`'), false)
  assert.match(DEAD_LABEL_SQL, /dead_label/)
})
