// test/slipExceptions.test.js — the two things this container does that need a person.
//
// Nima, 2026-09-14: "we dont want to automate the reponses but we want to account for
// them so we can fix them in the app."
//
// The fixture is the live shape of "59 cartons LCL to LA": a straps-CHOCOLATE line on
// PO1758 that nobody purchased, and SN02262NB-CHOCOLATE on PO1747 at 54 against 53
// remaining.
import test from 'node:test'
import assert from 'node:assert/strict'
import { slipExceptions, applyDecisions, exceptionKey, resolutionsFor, suggestedFor } from '../src/model/slipExceptions.js'
import { buildNetsuiteExport } from '../src/model/inventoryTransferCsv.js'

const PO_LINES = [
  { poNumber: '1747', sku: 'SN02262NB-CHOCOLATE', item_line_position: 1, qty_ordered: 100, qty_received: 47, final_destination: 'Warehouse' },
  { poNumber: '1758', sku: 'SN03011LD-MOCHA', item_line_position: 1, qty_ordered: 40, qty_received: 0, final_destination: 'Warehouse' },
]
const container = () => ({
  containerNum: '59 cartons LCL to LA', containerDate: '2026.8.17',
  skuTotals: [
    { poNumber: '1747', sku: 'SN02262NB-CHOCOLATE', units: 54 },
    { poNumber: '1758', sku: 'SN03011LD-MOCHA', units: 40 },
  ],
  nonMerchandise: [{ poNumber: '1758', sku: 'straps-CHOCOLATE', units: 5 }],
  unitCount: 94,
})

const STRAP = exceptionKey({ kind: 'non-merchandise', poNumber: '1758', sku: 'straps-CHOCOLATE' })
const OVER = exceptionKey({ kind: 'excess-shipped', poNumber: '1747', sku: 'SN02262NB-CHOCOLATE' })

const rowsOf = (r) => r.csv.trim().split('\n').slice(1).map((l) => l.split(','))
const qtyIn = (r, sku, col) => rowsOf(r).filter((x) => x[col.sku] === sku).map((x) => Number(x[col.qty]))

test('both things are found, and each is a question rather than an answer', () => {
  const ex = slipExceptions(container(), PO_LINES)
  assert.deepEqual(ex.map((e) => e.kind).sort(), ['excess-shipped', 'non-merchandise'])
  assert.ok(ex.every((e) => e.required), 'both need a decision')
  assert.ok(ex.every((e) => e.resolutions.length >= 2), 'and each offers real alternatives')
})

test('⚠️ A SUGGESTION IS NEVER PRE-APPLIED — nothing is decided until someone decides', () => {
  // The whole point. Both of these already had an automatic answer that happened to
  // be right, which is exactly what made them invisible.
  const plan = applyDecisions(container(), PO_LINES, {})
  assert.equal(plan.unresolved.length, 2)
  assert.equal(plan.adjustments.length, 0, 'and nothing has been done to the quantities')
  assert.equal(suggestedFor('non-merchandise'), 'leave-off', 'a suggestion exists…')
  assert.equal(plan.container.skuTotals.length, 2, '…and was not acted on')
})

test('⚠️ AN UNANSWERED EXCEPTION BLOCKS BOTH FILES, even when both files are clean', async () => {
  // A strap left off both CSVs produces two perfectly valid files and one undecided
  // question. Neither builder's own `blocked` can see that — only the plan can.
  const built = await buildNetsuiteExport(container(), PO_LINES, { decisions: {} })
  assert.equal(built.blocked, true)
  assert.equal(built.unresolved.length, 2)
})

test('⚠️ NO decisions AT ALL IS THE OLD BEHAVIOUR — callers that predate this do not start blocking', async () => {
  const built = await buildNetsuiteExport(container(), PO_LINES, {})
  assert.deepEqual(built.unresolved, [])
})

test('leave-off: the strap is on neither file, and it is recorded as a decision', async () => {
  const built = await buildNetsuiteExport(container(), PO_LINES,
    { decisions: { [STRAP]: 'leave-off', [OVER]: 'receive-all' } })
  assert.ok(!built.itemReceipt.csv.includes('straps-CHOCOLATE'))
  assert.ok(!built.transfer.csv.includes('straps-CHOCOLATE'))
  const a = built.adjustments.find((x) => x.key === STRAP)
  assert.equal(a.resolution, 'leave-off')
  assert.match(a.effect, /kept off both files/)
})

test('receive-it: the strap is folded back in, and its lack of a PO line is then REPORTED, not invented', async () => {
  // The honest outcome of disagreeing with the suggestion: it becomes an unmatched
  // line, which is a fact about the PO rather than a guess about the SKU.
  const built = await buildNetsuiteExport(container(), PO_LINES,
    { decisions: { [STRAP]: 'receive-it', [OVER]: 'receive-all' } })
  assert.ok(built.itemReceipt.unmatchedLines.some((l) => l.sku === 'straps-CHOCOLATE'))
  assert.ok(!built.itemReceipt.csv.includes('straps-CHOCOLATE'), 'never receivable against a line that does not exist')
  assert.ok(built.transfer.heldBack.some((l) => l.sku === 'straps-CHOCOLATE'), 'and it cannot move either')
})

test('⚠️ receive-all: THE EXTRA UNIT REACHES THE TRANSFER TOO', async () => {
  // A receipt that takes 54 with a transfer that moves 53 leaves one unit received in
  // China and never moved — worse than not receiving it at all.
  const built = await buildNetsuiteExport(container(), PO_LINES,
    { decisions: { [STRAP]: 'leave-off', [OVER]: 'receive-all' } })
  assert.equal(built.blocked, false)
  assert.deepEqual(qtyIn(built.itemReceipt, 'SN02262NB-CHOCOLATE', { sku: 4, qty: 6 }), [54])
  assert.deepEqual(qtyIn(built.transfer, 'SN02262NB-CHOCOLATE', { sku: 8, qty: 9 }), [54])
  assert.equal(built.itemReceipt.acceptedExcess.length, 1)
})

test('⚠️ receive-remaining: BOTH files drop to 53, and the orphaned unit is stated', async () => {
  const built = await buildNetsuiteExport(container(), PO_LINES,
    { decisions: { [STRAP]: 'leave-off', [OVER]: 'receive-remaining' } })
  assert.equal(built.blocked, false)
  assert.deepEqual(qtyIn(built.itemReceipt, 'SN02262NB-CHOCOLATE', { sku: 4, qty: 6 }), [53])
  assert.deepEqual(qtyIn(built.transfer, 'SN02262NB-CHOCOLATE', { sku: 8, qty: 9 }), [53])
  assert.equal(built.itemReceipt.overReceives.length, 0, 'no longer over — the quantity itself changed')
  assert.match(built.adjustments.find((x) => x.key === OVER).effect, /in no NetSuite record/)
})

test('⚠️ hold-line: the SKU leaves BOTH files, not just the receipt', async () => {
  const built = await buildNetsuiteExport(container(), PO_LINES,
    { decisions: { [STRAP]: 'leave-off', [OVER]: 'hold-line' } })
  assert.equal(built.blocked, false)
  assert.ok(!built.itemReceipt.csv.includes(',54,'))
  assert.ok(!built.transfer.csv.includes('SN02262NB-CHOCOLATE'))
  assert.equal(built.adjustedUnitCount, 40, 'and the count says what the files carry')
})

test('⚠️ A DECISION IS PER LINE — one acceptance never speaks for another PO', async () => {
  // The boolean it replaces said yes to every over-receive on the container at once.
  const c = container()
  c.skuTotals.push({ poNumber: '1758', sku: 'SN03011LD-MOCHA', units: 0 })
  const two = { ...c, skuTotals: [
    { poNumber: '1747', sku: 'SN02262NB-CHOCOLATE', units: 54 },
    { poNumber: '1758', sku: 'SN03011LD-MOCHA', units: 45 },
  ] }
  const other = exceptionKey({ kind: 'excess-shipped', poNumber: '1758', sku: 'SN03011LD-MOCHA' })
  const built = await buildNetsuiteExport(two, PO_LINES,
    { decisions: { [STRAP]: 'leave-off', [OVER]: 'receive-all' } })
  assert.equal(built.blocked, true, 'the second over-receive is still unanswered')
  assert.deepEqual(built.unresolved.map((e) => e.key), [other])
})

test('⚠️ nothing-remaining OFFERS NOTHING — a re-imported container has no button', () => {
  const done = [{ poNumber: '1747', sku: 'SN02262NB-CHOCOLATE', item_line_position: 1, qty_ordered: 100, qty_received: 100, final_destination: 'Warehouse' }]
  const ex = slipExceptions({ ...container(), nonMerchandise: [] }, done)
  assert.equal(ex.length, 1)
  assert.equal(ex[0].kind, 'nothing-remaining')
  assert.deepEqual(resolutionsFor('nothing-remaining'), [])
  assert.equal(ex[0].required, false, 'not "awaiting a decision" — there is no decision to make')
})

test('⚠️ AN UNKNOWN RESOLUTION THROWS, never falls back to the suggestion', () => {
  assert.throws(() => applyDecisions(container(), PO_LINES, { [STRAP]: 'ignore-it' }), /not a resolution/)
})

test('a decision for an exception this parse no longer has is simply not applied', () => {
  const plan = applyDecisions({ ...container(), nonMerchandise: [] }, PO_LINES, { [STRAP]: 'leave-off', [OVER]: 'receive-all' })
  assert.deepEqual(plan.unresolved, [])
  assert.equal(plan.adjustments.length, 1)
})
