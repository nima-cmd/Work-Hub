// test/transferCard.test.js — a transfer as a card on the board.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transferCard, transferStage, transferNextAction, needsPicking } from '../src/model/transferCard.js'
import { STAGE, NEXT_ACTION } from '../src/model/stages.js'
import { RECEIVED } from '../src/model/transferOrder.js'

const PENDING = 'Transfer Order : Pending Fulfillment'

test('⚠️ the transfer\'s OWN status cannot say whether it has been picked', () => {
  // Measured 2026-08-27: TO217, TO171 and TO155 all read "Pending Fulfillment" and all
  // three already have a picked fulfilment — one of them is in ShipStation. NetSuite
  // leaves a transfer at Pending Fulfillment until the far end RECEIVES it.
  const looksPending = { toNumber: 'TO217', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7612', ifStatus: 'Picked' }
  assert.equal(transferStage(looksPending), STAGE.PICKED, 'not OPEN, despite the status')
  assert.match(transferNextAction(looksPending), /Pack it/)
})

test('the pick signal is the ABSENCE of a fulfilment — the same rule sales orders use', () => {
  const fresh = { toNumber: 'TO999', destination: 'Consignment', toStatus: PENDING }
  assert.equal(transferStage(fresh), STAGE.OPEN)
  assert.match(transferNextAction(fresh), /Pick it — transfer to Consignment/)
})

test('shipped is NOT finished for a transfer', () => {
  // ⚠️ The far end confirming is a separate event that does not always happen, and it
  // is the whole reason Nima wanted these tracked.
  const sent = { toNumber: 'TO127', destination: 'Office', toStatus: 'Transfer Order : Pending Receipt', ifNumber: 'IF7195', ifStatus: 'Shipped' }
  assert.equal(transferStage(sent), STAGE.SHIPPED)
  assert.match(transferNextAction(sent), /chase the receipt/)

  const done = { ...sent, toStatus: RECEIVED }
  assert.equal(transferNextAction(done), '—', 'received really is finished')
})

test('a received transfer is settled, so the board can drop it', () => {
  const c = transferCard({ toNumber: 'TO190', destination: 'Consignment', toStatus: RECEIVED, ifNumber: 'IF7272', ifStatus: 'Shipped' })
  assert.equal(c.received, true)
  assert.equal(c.fulfillments[0].settled, true)
})

test('⚠️ a transfer card is never mistakable for a customer order', () => {
  // A transfer sitting anonymously among customer orders is how one gets shipped to a
  // customer address. `customer` is NULL because there is none — the destination is a
  // place, and a surface reading it as `customer` would render a place as a company.
  const c = transferCard({ toNumber: 'TO217', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7612', ifStatus: 'Picked' })
  assert.equal(c.isTransfer, true)
  assert.equal(c.customer, null)
  assert.equal(c.destination, 'Office')
  assert.equal(c.source, 'transfer')
  assert.equal(c.poNumber, null)
})

test('the card carries the same shape the board already renders', () => {
  const c = transferCard({ toNumber: 'TO217', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7612', ifStatus: 'Picked', tracking: ['1Z'] })
  for (const k of ['soNumber', 'stage', 'stageLabel', 'stageRank', 'nextAction', 'fulfillments']) {
    assert.ok(k in c, `missing ${k}`)
  }
  assert.equal(c.fulfillments[0].ifNumber, 'IF7612')
  assert.deepEqual(c.fulfillments[0].trackingNumbers, ['1Z'])
})

test('the pick list is stage-based, never status-based', () => {
  const cards = [
    transferCard({ toNumber: 'TO999', destination: 'Office', toStatus: PENDING }),
    transferCard({ toNumber: 'TO217', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7612', ifStatus: 'Picked' }),
    transferCard({ toNumber: 'TO171', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7145', ifStatus: 'Picked' }),
  ]
  // ⚠️ All three say "Pending Fulfillment". Only the one with no fulfilment needs picking.
  assert.deepEqual(needsPicking(cards).map((c) => c.soNumber), ['TO999'])
})

test('a card with no transfer number is refused rather than half-built', () => {
  assert.equal(transferCard({}), null)
  assert.equal(transferCard({ destination: 'Office' }), null)
})

test('the pick label names the destination, because that IS the job', () => {
  const c = transferCard({ toNumber: 'TO999', destination: 'Consignment', toStatus: PENDING })
  assert.match(c.stageLabel, /pick for Consignment/)
  // And an unnamed destination still reads as a sentence rather than "for null".
  const unnamed = transferCard({ toNumber: 'TO998', toStatus: PENDING })
  assert.match(unnamed.stageLabel, /an unnamed location/)
})

test('⚠️ a transfer is NEVER invoiced and NEVER paid', () => {
  // Nima, 2026-08-27: "no payment invoice needed for transfer orders so once they have
  // a label they can ship." It moves our own goods between our own locations — there
  // is nobody to bill.
  //
  // This is not wording. A sales order at PACKED is told to "Invoice / progress it"
  // and then "Follow up on payment"; a transfer inheriting those puts two steps in
  // front of him that DO NOT EXIST for this document — work invented by a shared enum.
  //
  // ⚠️ The first version of this assertion BUILT ITS REGEX OUT OF THE VALUE IT WAS
  // TESTING, so it could never fail — the same sin as the held-calendar test that
  // asserted an impossible state. It asserts the real thing now: the two sales-order
  // actions that must never appear.
  const packed = { toNumber: 'TO9', destination: 'Office', toStatus: PENDING, ifNumber: 'IF1', ifStatus: 'Packed' }
  const action = transferNextAction(packed)
  assert.doesNotMatch(action, /Invoice \/ progress/, 'the sales-order PACKED action must never appear')
  assert.doesNotMatch(action, /Follow up on payment/, 'nor the INVOICED one')
  assert.match(action, /label/i, 'the label is the only thing between packed and the door')

  // And prove the guard can fail: those strings really are what a sales order gets.
  assert.equal(NEXT_ACTION[STAGE.PACKED], 'Invoice / progress it')
  assert.equal(NEXT_ACTION[STAGE.INVOICED], 'Follow up on payment')
})

test('a packed transfer waits on the LABEL, and says so either way', () => {
  const noLabel = transferCard({ toNumber: 'TO9', destination: 'Office', toStatus: PENDING, ifNumber: 'IF1', ifStatus: 'Packed' })
  assert.equal(noLabel.labelled, false)
  assert.match(noLabel.nextAction, /Make the label/)

  const labelled = transferCard({ toNumber: 'TO9', destination: 'Office', toStatus: PENDING, ifNumber: 'IF1', ifStatus: 'Packed', tracking: ['1ZC6J610'] })
  assert.equal(labelled.labelled, true)
  assert.match(labelled.nextAction, /Ship it out/)
  assert.match(labelled.nextAction, /no invoice needed/, 'says it out loud, so nobody goes looking for one')
})

test('the lifecycle skips INVOICED and APPROVED entirely', () => {
  // pick → pack → label → ship → confirm receipt. Nothing else is reachable.
  const stages = new Set()
  for (const t of [
    { toNumber: 'T', toStatus: PENDING },
    { toNumber: 'T', toStatus: PENDING, ifNumber: 'I', ifStatus: 'Picked' },
    { toNumber: 'T', toStatus: PENDING, ifNumber: 'I', ifStatus: 'Packed' },
    { toNumber: 'T', toStatus: PENDING, ifNumber: 'I', ifStatus: 'Shipped' },
    { toNumber: 'T', toStatus: RECEIVED, ifNumber: 'I', ifStatus: 'Shipped' },
  ]) stages.add(transferStage(t))
  assert.equal(stages.has(STAGE.INVOICED), false, 'a transfer is never invoiced')
  assert.equal(stages.has(STAGE.APPROVED), false, 'and never needs approval to ship')
  assert.deepEqual([...stages].sort(), [STAGE.OPEN, STAGE.PACKED, STAGE.PICKED, STAGE.SHIPPED].sort())
})

test('⚠️ a label lives in THREE places — a transfer must read all of them', () => {
  // The label for TO217 was bought in ShipStation (1ZC6J6100325130658, $32.33) and
  // NEVER reached NetSuite, because nobody had typed it there yet. Reading only
  // fulfillments.tracking_numbers showed a shipment with no tracking and warned it
  // "cannot be traced" — hours after the label existed.
  //
  // labelEvidence.labelTracking is the merge, and it is what the push gate and
  // labelGap already read. This pins that a transfer card reflects a ShipStation-only
  // label, which is the ONLY kind a transfer can have: Nima cannot make these in
  // NetSuite at all.
  const ssOnly = transferCard({
    toNumber: 'TO217', destination: 'Office', toStatus: PENDING,
    ifNumber: 'IF7612', ifStatus: 'Packed',
    tracking: ['1ZC6J6100325130658'],   // merged upstream from ShipStation
  })
  assert.equal(ssOnly.labelled, true)
  assert.match(ssOnly.nextAction, /Ship it out/)
  assert.doesNotMatch(ssOnly.nextAction, /Make the label/, 'the label exists — do not ask for it again')
})
