// test/transferBoard.test.js — where a transfer card sits on the Orders tab.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TCOL, TCOL_ORDER, TCOL_LABEL, TCOL_IS_WORK,
  transferColumn, transferColumns, transferWorkCount, transferSettledCount,
} from '../src/model/transferBoard.js'
import { transferCard } from '../src/model/transferCard.js'
import { STAGE } from '../src/model/stages.js'
import { missionTab } from '../src/model/postCustody.js'
import { fulfilledNeverScanned } from '../src/model/postCustody.js'
import { RECEIVED } from '../src/model/transferOrder.js'

const PENDING = 'Transfer Order : Pending Fulfillment'

// The three live picked transfers, as the API returned them 2026-08-28.
const TO217 = transferCard({ toNumber: 'TO217', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7612', ifStatus: 'Picked', tracking: ['1ZC6J6100325130658'] })
const TO171 = transferCard({ toNumber: 'TO171', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7500', ifStatus: 'Picked', tracking: [] })
const TO123 = transferCard({ toNumber: 'TO123', destination: 'Office', toStatus: PENDING, ifNumber: 'IF7100', ifStatus: 'Shipped', tracking: ['1Z999'] })

test('⚠️ THE REASON THIS MODEL EXISTS: missionTab puts zero transfers on the Orders tab', () => {
  // Measured against the 14 live transfers 2026-08-28: every one of them has a
  // fulfilment, and missionTab sends a card to tab ① only when it has none. Routing
  // transfers through the sales-order rules would have left the tab Nima asked for
  // them on completely empty.
  for (const c of [TO217, TO171, TO123]) {
    const tab = missionTab({ fulfilments: c.fulfillments, custodyState: null, departed: c.stage === STAGE.SHIPPED })
    assert.notEqual(tab, 'orders', `${c.soNumber} would not have reached the Orders tab`)
  }
  // …whereas this model places all three.
  for (const c of [TO217, TO171, TO123]) assert.ok(transferColumn(c), `${c.soNumber} is placed`)
})

test('⚠️ AND the picked ones would have been ACCUSED of never being scanned out', () => {
  // A transfer is never custody-scanned — there is no Nestor hand-off, Nima packs it
  // himself. fulfilledNeverScanned is nonetheless true for all of them, so the
  // "Fulfilled — never scanned out" column would have been false 3 for 3.
  for (const c of [TO217, TO171]) {
    const f = c.fulfillments[0]
    assert.equal(fulfilledNeverScanned(f, { dcScanned: false }), true,
      `${c.soNumber} trips the sales-order accusation rule`)
  }
  // This model never routes a transfer into a custody column at all.
  const keys = transferColumns([TO217, TO171]).map((col) => col.key)
  assert.deepEqual(keys, [TCOL.PACK])
})

test('a transfer with no fulfilment is the pick signal — never its NetSuite status', () => {
  const unpicked = transferCard({ toNumber: 'TO900', destination: 'Consignment', toStatus: PENDING })
  assert.equal(unpicked.stage, STAGE.OPEN)
  assert.equal(transferColumn(unpicked), TCOL.PICK)
  // TO217 reads the SAME status and is already picked — the status cannot tell them apart.
  assert.equal(TO217.toStatus, unpicked.toStatus)
  assert.equal(transferColumn(TO217), TCOL.PACK)
})

test('packed splits on the label, because the label is the only thing left', () => {
  const unlabelled = transferCard({ toNumber: 'TO901', destination: 'Office', toStatus: PENDING, ifNumber: 'IF1', ifStatus: 'Packed', tracking: [] })
  const labelled = transferCard({ toNumber: 'TO902', destination: 'Office', toStatus: PENDING, ifNumber: 'IF2', ifStatus: 'Packed', tracking: ['1Z1'] })
  assert.equal(transferColumn(unlabelled), TCOL.LABEL)
  assert.equal(transferColumn(labelled), TCOL.SHIP)
})

test('shipped but not received is the receipt chase; received is finished', () => {
  assert.equal(transferColumn(TO123), TCOL.RECEIPT)
  const done = transferCard({ toNumber: 'TO124', destination: 'Office', toStatus: RECEIVED, ifNumber: 'IF3', ifStatus: 'Shipped', tracking: ['1Z2'] })
  assert.equal(transferColumn(done), TCOL.RECEIVED)
})

test('received transfers are HIDDEN by default and never discarded', () => {
  const done = transferCard({ toNumber: 'TO124', destination: 'Office', toStatus: RECEIVED, ifNumber: 'IF3', ifStatus: 'Shipped', tracking: ['1Z2'] })
  const cards = [TO217, done]
  assert.deepEqual(transferColumns(cards).map((c) => c.key), [TCOL.PACK])
  assert.deepEqual(transferColumns(cards, { showSettled: true }).map((c) => c.key), [TCOL.PACK, TCOL.RECEIVED])
  assert.equal(transferSettledCount(cards), 1)
})

test('columns come back in flow order: pick → pack → label → ship → chase', () => {
  const all = [
    TO123,
    transferCard({ toNumber: 'TO902', destination: 'Office', toStatus: PENDING, ifNumber: 'IF2', ifStatus: 'Packed', tracking: ['1Z1'] }),
    TO217,
    transferCard({ toNumber: 'TO900', destination: 'Consignment', toStatus: PENDING }),
    transferCard({ toNumber: 'TO901', destination: 'Office', toStatus: PENDING, ifNumber: 'IF1', ifStatus: 'Packed', tracking: [] }),
  ]
  assert.deepEqual(transferColumns(all).map((c) => c.key),
    [TCOL.PICK, TCOL.PACK, TCOL.LABEL, TCOL.SHIP, TCOL.RECEIPT])
})

test('the receipt chase is a WATCH, not work — the far end has to act', () => {
  assert.equal(TCOL_IS_WORK[TCOL.RECEIPT], false)
  assert.equal(TCOL_IS_WORK[TCOL.RECEIVED], false)
  // TO217 and TO171 are work; TO123 is waiting on someone else.
  assert.equal(transferWorkCount([TO217, TO171, TO123]), 2)
})

test('oldest first — the forgotten transfer is the one worth surfacing', () => {
  const a = transferCard({ toNumber: 'TO123', destination: 'Office', toStatus: PENDING, ifNumber: 'IFa', ifStatus: 'Shipped', tracking: ['1Z'] })
  const b = transferCard({ toNumber: 'TO191', destination: 'Consignment', toStatus: PENDING, ifNumber: 'IFb', ifStatus: 'Shipped', tracking: ['1Z'] })
  const [col] = transferColumns([b, a])
  assert.deepEqual(col.items.map((c) => c.soNumber), ['TO123', 'TO191'])
})

test('every column has a label and says "Transfer" out loud', () => {
  // A transfer sitting anonymously among customer orders is how one gets shipped to a
  // customer address — the reason transferCard refuses to fill in `customer`.
  for (const k of TCOL_ORDER) {
    assert.ok(TCOL_LABEL[k], `${k} has a label`)
    assert.match(TCOL_LABEL[k], /Transfer/)
  }
})

test('a card with no number is placed nowhere rather than drawn blank', () => {
  assert.equal(transferColumn({}), null)
  assert.equal(transferColumn(null), null)
  assert.deepEqual(transferColumns([null, {}, TO217]).map((c) => c.key), [TCOL.PACK])
})
