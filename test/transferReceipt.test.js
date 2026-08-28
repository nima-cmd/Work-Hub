// test/transferReceipt.test.js — did the transfer actually arrive?
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  OUTCOME, isOutcome, validateReceipt, receiptState, receiptHeadline, receiptsByTransfer,
} from '../src/model/transferReceipt.js'
import { transferCard } from '../src/model/transferCard.js'
import { transferColumn, transferColumns, transferSettledCount, TCOL } from '../src/model/transferBoard.js'
import { RECEIVED } from '../src/model/transferOrder.js'
import { STAGE } from '../src/model/stages.js'

const PENDING = 'Transfer Order : Pending Fulfillment'
const CLOSED = 'Transfer Order : Closed'
const PENDING_RECEIPT = 'Transfer Order : Pending Receipt'

test('⚠️ "Closed" RESOLVES TO UNKNOWN — it is never derived either way', () => {
  // Nima, asked directly whether Closed means arrived: "im not fully sure closed can be
  // abandoned it could also be partially shippedd and the rest of the units abandoned".
  // Two different situations wearing one label. Deriving "received" would mark real
  // goods as arrived; deriving "abandoned" would drop a real shipment off the chase
  // list. Both wrong in the other case — so neither is derived.
  const s = receiptState({ toStatus: CLOSED, receipt: null })
  assert.equal(s.received, false)
  assert.equal(s.settled, false)   // still chaseable — a person has to answer
  assert.equal(receiptHeadline({ toStatus: CLOSED }), 'not confirmed received')
  // TO191 therefore stays on the chase list until someone says otherwise.
  const to191 = transferCard({ toNumber: 'TO191', destination: 'Consignment', toStatus: CLOSED, ifNumber: 'IF7274', ifStatus: 'Shipped', tracking: ['1Z'] })
  assert.equal(transferColumn(to191), TCOL.RECEIPT)
})

test('NetSuite Received is evidence; its absence is evidence of nothing', () => {
  assert.equal(receiptState({ toStatus: RECEIVED }).received, true)
  assert.equal(receiptState({ toStatus: RECEIVED }).source, 'netsuite')
  // ⚠️ The wording rule: never "not delivered" when nobody has confirmed either way.
  assert.equal(receiptHeadline({ toStatus: PENDING_RECEIPT }), 'not confirmed received')
})

test('an ENTERED receipt settles it exactly as NetSuite would', () => {
  const receipt = { outcome: OUTCOME.RECEIVED, receivedOn: '2026-08-20', note: 'Maria confirmed' }
  const s = receiptState({ toStatus: PENDING_RECEIPT, receipt })
  assert.equal(s.received, true)
  assert.equal(s.settled, true)
  assert.equal(s.source, 'entered')
  assert.equal(s.on, '2026-08-20')
  assert.match(receiptHeadline({ toStatus: PENDING_RECEIPT, receipt }), /received 2026-08-20 — entered by hand/)
})

test('⚠️ WRITTEN OFF IS SETTLED BUT NOT RECEIVED — the goods never arrived', () => {
  // Saying "received" here would be a lie in the one record that exists to catch stock
  // that never turned up.
  const receipt = { outcome: OUTCOME.NOT_COMING, receivedOn: '2026-08-28', note: 'remainder abandoned' }
  const s = receiptState({ toStatus: CLOSED, receipt })
  assert.equal(s.received, false)
  assert.equal(s.settled, true)
  assert.match(receiptHeadline({ toStatus: CLOSED, receipt }), /nothing coming/)
})

test('a written-off transfer leaves the chase list into its own column, not "received"', () => {
  const card = transferCard({
    toNumber: 'TO191', destination: 'Consignment', toStatus: CLOSED,
    ifNumber: 'IF7274', ifStatus: 'Shipped', tracking: ['1Z'],
    receipt: { outcome: OUTCOME.NOT_COMING, receivedOn: '2026-08-28', note: null },
  })
  assert.equal(card.received, false)
  assert.equal(card.settled, true)
  assert.equal(transferColumn(card), TCOL.NOT_COMING)
  // ⚠️ NOT the received column — those are opposite facts.
  assert.notEqual(transferColumn(card), TCOL.RECEIVED)
})

test('an entered receipt stops the card asking to be chased', () => {
  const before = transferCard({ toNumber: 'TO123', destination: 'Office', toStatus: PENDING_RECEIPT, ifNumber: 'IF6886', ifStatus: 'Shipped', tracking: ['1Z'] })
  assert.match(before.nextAction, /chase the receipt/)
  const after = transferCard({
    toNumber: 'TO123', destination: 'Office', toStatus: PENDING_RECEIPT, ifNumber: 'IF6886', ifStatus: 'Shipped', tracking: ['1Z'],
    receipt: { outcome: OUTCOME.RECEIVED, receivedOn: '2026-08-28', note: null },
  })
  assert.doesNotMatch(after.nextAction, /chase/)
  assert.equal(after.stage, STAGE.SHIPPED)
  assert.equal(transferColumn(after), TCOL.RECEIVED)
})

test('both finished columns hide behind the SAME toggle, and the count says so', () => {
  const got = transferCard({ toNumber: 'TO01', destination: 'Office', toStatus: PENDING_RECEIPT, ifNumber: 'IF1', ifStatus: 'Shipped', tracking: ['1Z'], receipt: { outcome: OUTCOME.RECEIVED, receivedOn: '2026-08-01' } })
  const gone = transferCard({ toNumber: 'TO02', destination: 'Office', toStatus: CLOSED, ifNumber: 'IF2', ifStatus: 'Shipped', tracking: ['1Z'], receipt: { outcome: OUTCOME.NOT_COMING, receivedOn: '2026-08-02' } })
  const open = transferCard({ toNumber: 'TO03', destination: 'Office', toStatus: PENDING_RECEIPT, ifNumber: 'IF3', ifStatus: 'Shipped', tracking: ['1Z'] })
  const cards = [got, gone, open]
  // ⚠️ 2, not 1 — a toggle saying "1 finished, hidden" while hiding two is the
  // counts-something-other-than-its-label shape.
  assert.equal(transferSettledCount(cards), 2)
  assert.deepEqual(transferColumns(cards).map((c) => c.key), [TCOL.RECEIPT])
  assert.deepEqual(transferColumns(cards, { showSettled: true }).map((c) => c.key),
    [TCOL.RECEIPT, TCOL.RECEIVED, TCOL.NOT_COMING])
})

test('validate names its own reason, never a bare false', () => {
  const ok = { toNumber: 'TO1', outcome: OUTCOME.RECEIVED, receivedOn: '2026-08-20' }
  assert.equal(validateReceipt(ok), null)
  assert.match(validateReceipt({ ...ok, toNumber: ' ' }), /transfer number/)
  assert.match(validateReceipt({ ...ok, outcome: 'maybe' }), /outcome must be/)
  assert.match(validateReceipt({ ...ok, receivedOn: '20 Aug' }), /YYYY-MM-DD/)
  assert.match(validateReceipt({ ...ok, receivedOn: '2026-13-45' }), /not a real date/)
  assert.match(validateReceipt({ ...ok, note: 42 }), /must be text/)
})

test('⚠️ a FUTURE receipt is a plan, not a record', () => {
  const r = { toNumber: 'TO1', outcome: OUTCOME.RECEIVED, receivedOn: '2026-09-30' }
  assert.match(validateReceipt(r, { today: '2026-08-28' }), /in the future/)
  // Back-dating IS allowed — the far end often confirms days late.
  assert.equal(validateReceipt({ ...r, receivedOn: '2026-08-01' }, { today: '2026-08-28' }), null)
  // Today itself is fine.
  assert.equal(validateReceipt({ ...r, receivedOn: '2026-08-28' }, { today: '2026-08-28' }), null)
})

test('isOutcome rejects anything not one of the two', () => {
  assert.ok(isOutcome(OUTCOME.RECEIVED) && isOutcome(OUTCOME.NOT_COMING))
  for (const v of ['', null, undefined, 'received ', 'RECEIVED', true, 0]) assert.equal(isOutcome(v), false)
})

test('receipts index on the transfer number, case-insensitively, from either column shape', () => {
  const m = receiptsByTransfer([
    { to_number: 'to191', outcome: OUTCOME.NOT_COMING, received_on: '2026-08-28', note: 'x' },
    { toNumber: 'TO123', outcome: OUTCOME.RECEIVED, receivedOn: '2026-08-20' },
    { to_number: '  ', outcome: OUTCOME.RECEIVED },
  ])
  assert.equal(m.size, 2)
  assert.equal(m.get('TO191').outcome, OUTCOME.NOT_COMING)
  assert.equal(m.get('TO123').receivedOn, '2026-08-20')
})

test('a NetSuite Received always wins over anything entered', () => {
  // If NetSuite confirms, that is the harder evidence and nothing entered can contradict it.
  const s = receiptState({ toStatus: RECEIVED, receipt: { outcome: OUTCOME.NOT_COMING, receivedOn: '2026-08-01' } })
  assert.equal(s.received, true)
  assert.equal(s.source, 'netsuite')
})
