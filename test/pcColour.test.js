import test from 'node:test'
import assert from 'node:assert/strict'
import { PC, PC_COLOR, PC_LABEL } from '../src/model/postCustody.js'

// Nima, 2026-08-14, quoting the board's own labels back: "needs label or a routing to
// have the title in blue, awaiting invoice should be yellow, awaiting payment red,
// invoice it to release should be purple, confirm it left should be green."
test('the five states he named carry the colours he asked for', () => {
  assert.equal(PC_COLOR[PC.NEEDS_LABEL_OR_ROUTING], 'blue')
  assert.equal(PC_COLOR[PC.AWAITING_INVOICE], 'yellow')
  assert.equal(PC_COLOR[PC.AWAITING_PAYMENT], 'red')
  assert.equal(PC_COLOR[PC.SHIPPED_AWAITING_INVOICE], 'purple')
  assert.equal(PC_COLOR[PC.SHIPPED_AWAITING_DEPARTURE], 'green')
})

// ⚠️ Only those five. Colouring states he did not mention would dilute the ones that
// mean something — a board where everything is coloured is one where nothing stands out.
test('no other state is coloured', () => {
  assert.equal(Object.keys(PC_COLOR).length, 5)
  for (const k of [PC.DEPARTED, PC.NEEDS_MARK_PACKED, PC.NEEDS_MARK_SHIPPED, PC.FOB_PICKUP, PC.EDI_NEEDS_PACK]) {
    assert.equal(PC_COLOR[k], undefined)
  }
})

// ⚠️ Colour reinforces the label; it is never the only signal. Every coloured state
// must still have words, so the board stays readable without relying on hue.
test('every coloured state still says what it is in words', () => {
  for (const k of Object.keys(PC_COLOR)) assert.ok(PC_LABEL[k] && PC_LABEL[k].length > 3)
})

test('the mapping keys are real states, not typos', () => {
  const known = new Set(Object.values(PC))
  for (const k of Object.keys(PC_COLOR)) assert.ok(known.has(k), `${k} is not a PC state`)
})
