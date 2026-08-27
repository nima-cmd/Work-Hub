// test/transferCard.test.js — a transfer as a card on the board.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transferCard, transferStage, transferNextAction, needsPicking } from '../src/model/transferCard.js'
import { STAGE } from '../src/model/stages.js'
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
