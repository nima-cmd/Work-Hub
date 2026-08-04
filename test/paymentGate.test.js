import test from 'node:test'
import assert from 'node:assert/strict'
import {
  paymentDue, paymentBlocked, clearedReason, approvedToShip,
  overdueInvoices, overdueSummary,
} from '../src/model/paymentGate.js'
import { buildPipeline } from '../src/model/pipeline.js'
import { STAGE } from '../src/model/stages.js'

// The four terms values live in NetSuite today (480 invoices since 2026-05).
test('paymentDue: net terms and no-payment-required never demand money up front', () => {
  assert.equal(paymentDue('Net 30'), false)
  assert.equal(paymentDue('Net 45'), false)
  assert.equal(paymentDue('Net 60'), false)
  assert.equal(paymentDue('No Payment Required'), false)
  assert.equal(paymentDue('Due on receipt'), true)
})

test('paymentDue: unknown terms assume money is due (the safe direction)', () => {
  assert.equal(paymentDue(null), true)
  assert.equal(paymentDue(''), true)
})

test('paymentDue matches Net loosely, since terms are free-form label text', () => {
  assert.equal(paymentDue('2% Net 30'), false)
  assert.equal(paymentDue('NET60'), true) // no word boundary — not a Net term
})

// The live rows that exposed the bug.
test('paymentBlocked: the two real held IFs block, the shipped ones do not', () => {
  // IF7413 → INV11361, IF7409 → INV11413: due on receipt, money owed.
  assert.equal(paymentBlocked({ terms: 'Due on receipt', amountRemaining: 158 }), true)
  assert.equal(paymentBlocked({ terms: 'Due on receipt', amountRemaining: 2225.6 }), true)
  // IF7288 → INV11411: due on receipt but PAID.
  assert.equal(paymentBlocked({ terms: 'Due on receipt', amountRemaining: 0 }), false)
  // IF7408 → INV11412: Net 30 with $3,900 outstanding — shipped, correctly.
  assert.equal(paymentBlocked({ terms: 'Net 30', amountRemaining: 3900 }), false)
})

test('paymentBlocked: nothing owed is never blocked, whatever the terms', () => {
  assert.equal(paymentBlocked({ terms: null, amountRemaining: 0 }), false)
  assert.equal(paymentBlocked({ terms: 'Due on receipt', amountRemaining: null }), false)
})

// Nima, 2026-08-04: chasing an overdue invoice is not a shipping decision, so a
// net-terms invoice that has gone past due must still be shippable. Holding it
// would be the app inventing a policy nobody asked for.
test('paymentBlocked: net terms PAST DUE still do not block', () => {
  assert.equal(paymentBlocked({ terms: 'Net 30', amountRemaining: 3900 }), false)
})

test('clearedReason names why it may ship, and is null when blocked', () => {
  assert.equal(clearedReason({ terms: 'Due on receipt', amountRemaining: 0 }), 'paid in full')
  assert.equal(clearedReason({ terms: 'No Payment Required', amountRemaining: 50 }), 'no payment required')
  assert.equal(clearedReason({ terms: 'Net 45', amountRemaining: 50 }), 'Net 45 — not due yet')
  assert.equal(clearedReason({ terms: 'Due on receipt', amountRemaining: 158 }), null)
})

// ── the NY waiver, at the gate itself ────────────────────────────────────────
//
// "We also check for a manual set of the approved to ship on orders that are due
// on receipt — this is how our NY office lets us know that they want something
// shipped regardless of payment" (Nima, 2026-08-04).
test('approvedToShip: only the approval value waives, and it does so one-way', () => {
  assert.equal(approvedToShip('Approved For Shipping'), true)
  assert.equal(approvedToShip('approved for shipping'), true)
  // The other three live values are holds or history, never waivers.
  assert.equal(approvedToShip('Pending Payment'), false)
  assert.equal(approvedToShip('FOB Pending Approval'), false)
  assert.equal(approvedToShip('Shipped'), false)
  assert.equal(approvedToShip(null), false)
})

test('paymentBlocked: the NY waiver releases a due-on-receipt hold', () => {
  const owing = { terms: 'Due on receipt', amountRemaining: 90654.4 }
  assert.equal(paymentBlocked(owing), true)
  assert.equal(paymentBlocked({ ...owing, shipGate: 'Approved For Shipping' }), false)
  // The values that are NOT the waiver must leave the hold exactly as it was.
  assert.equal(paymentBlocked({ ...owing, shipGate: 'Pending Payment' }), true)
  assert.equal(paymentBlocked({ ...owing, shipGate: 'FOB Pending Approval' }), true)
})

// The whole reason the waiver is safe to depend on: an absent, stale or never-
// synced field falls back to the derived answer, and the derived answer HOLDS.
// The failure direction is a shipment parked one cycle too long, never a shipment
// that leaves without authorization.
test('paymentBlocked: a missing gate never loosens the derived hold', () => {
  for (const shipGate of [null, undefined, '', 'anything else']) {
    assert.equal(paymentBlocked({ terms: 'Due on receipt', amountRemaining: 158, shipGate }), true)
  }
})

test('clearedReason names the waiver as a decision, not a state', () => {
  assert.equal(
    clearedReason({ terms: 'Due on receipt', amountRemaining: 158, shipGate: 'Approved For Shipping' }),
    'approved to ship despite balance (NY office)',
  )
})

// ── the overdue diagnostic ───────────────────────────────────────────────────

const TODAY = new Date('2026-08-04T12:00:00Z')

test('overdueInvoices: only past-due, still-owed rows appear', () => {
  const rows = overdueInvoices([
    { invNumber: 'INV1', amountRemaining: 100, dueDate: '2026-07-01' }, // overdue
    { invNumber: 'INV2', amountRemaining: 100, dueDate: '2026-09-01' }, // not due
    { invNumber: 'INV3', amountRemaining: 0, dueDate: '2026-07-01' },   // paid
    { invNumber: 'INV4', amountRemaining: 100, dueDate: null },         // no due date
  ], { today: TODAY })
  assert.deepEqual(rows.map((r) => r.invNumber), ['INV1'])
  assert.equal(rows[0].daysOverdue, 34)
})

test('overdueInvoices sorts oldest-first', () => {
  const rows = overdueInvoices([
    { invNumber: 'A', amountRemaining: 1, dueDate: '2026-08-01' },
    { invNumber: 'B', amountRemaining: 1, dueDate: '2026-05-01' },
  ], { today: TODAY })
  assert.deepEqual(rows.map((r) => r.invNumber), ['B', 'A'])
})

// The whole point of the list: which inquiry does a row call for?
test('overdueInvoices distinguishes never-billed from chase-payment', () => {
  const invs = [
    { invNumber: 'INV_SENT', amountRemaining: 10, dueDate: '2026-07-01', source: 'edi' },
    { invNumber: 'INV_STUCK', amountRemaining: 10, dueDate: '2026-07-01', source: 'edi' },
    { invNumber: 'INV_NO810', amountRemaining: 10, dueDate: '2026-07-01', source: 'edi' },
    { invNumber: 'INV_SHOP', amountRemaining: 10, dueDate: '2026-07-01', source: 'boutique' },
  ]
  const delivered = (n) => (n === 'INV_SENT' ? true : n === 'INV_STUCK' ? false : null)
  const rows = overdueInvoices(invs, { today: TODAY, ediInvoiceDelivered: delivered })
  const by = Object.fromEntries(rows.map((r) => [r.invNumber, r.inquiry]))
  assert.equal(by.INV_SENT, 'chase-payment')   // billed — payment/posting question
  assert.equal(by.INV_STUCK, 'never-billed')   // 810 never reached them
  assert.equal(by.INV_NO810, 'unknown-810')    // no record either way — say so
  assert.equal(by.INV_SHOP, 'chase-payment')   // boutique: no 810 exists to check
})

// An absent 810 record must never be reported as a missing document.
// `source` comes from the joined order, and 1,015 invoices legitimately have no
// order row (out-of-window). Defaulting those to 'chase-payment' asserted we had
// billed them — it mislabelled all 70 rows on the first live run.
test('overdueInvoices: an unknown source is unknown, not assumed billed', () => {
  const rows = overdueInvoices(
    [{ invNumber: 'INV_ORPHAN', amountRemaining: 10, dueDate: '2026-07-01', source: null }],
    { today: TODAY, ediInvoiceDelivered: () => null },
  )
  assert.equal(rows[0].inquiry, 'unknown-source')
})

// A balance on "No Payment Required" is not a debt. INV11336 carried $79.86 at
// 33 days and read as overdue money owed to us.
test('overdueInvoices excludes No Payment Required, balance or not', () => {
  const rows = overdueInvoices(
    [{ invNumber: 'INV_NPR', amountRemaining: 79.86, dueDate: '2026-07-01', terms: 'No Payment Required' }],
    { today: TODAY },
  )
  assert.deepEqual(rows, [])
})

test('overdueInvoices: no 810 record is unknown, not never-billed', () => {
  const rows = overdueInvoices(
    [{ invNumber: 'INV9', amountRemaining: 10, dueDate: '2026-07-01', source: 'edi' }],
    { today: TODAY, ediInvoiceDelivered: () => null },
  )
  assert.equal(rows[0].inquiry, 'unknown-810')
})

test('overdueSummary totals money and separates the never-billed count', () => {
  const rows = overdueInvoices([
    { invNumber: 'A', amountRemaining: 100, dueDate: '2026-07-01', source: 'edi' },
    { invNumber: 'B', amountRemaining: 250, dueDate: '2026-06-01', source: 'edi' },
  ], { today: TODAY, ediInvoiceDelivered: (n) => (n === 'A' ? false : true) })
  const s = overdueSummary(rows)
  assert.equal(s.count, 2)
  assert.equal(s.amount, 350)
  assert.equal(s.neverBilled, 1)
  assert.equal(s.oldestDays, 64)
})

// ── the invoiced stage (src/model/pipeline.js) ───────────────────────────────
//
// The regression these cover: on the live sync NO order could leave PACKED,
// because the only code that promoted an invoiced order keyed off a `stage`
// field that only the retired CSV mappers set. Measured live 2026-08-04: 0 of
// 238 orders at INVOICED or APPROVED, while 4 packed-and-invoiced orders read
// "need an invoice" AND "held for payment" at the same time.

test('an invoice number promotes an order out of PACKED even with no stage on the record', () => {
  const orders = buildPipeline([
    // Exactly the live shape: a fulfilment says packed, the invoice record
    // carries payment evidence and NO stage of its own.
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', terms: 'Due on receipt', amountRemaining: 158 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

test('payment blocking keeps an invoiced order at INVOICED, never APPROVED', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    // The hand-set field agrees here, but it is not what decides: money is owed on
    // Due-on-receipt, and the derived gate is what holds the order (#47).
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', shippingStatus: 'Pending Payment',
      terms: 'Due on receipt', amountRemaining: 2225.6 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

// ── the NY waiver ────────────────────────────────────────────────────────────
//
// ⚠️ THIS CASE USED TO ASSERT THE OPPOSITE, and the old assertion was in this
// file: a hand-set `Approved For Shipping` on a due-on-receipt invoice with money
// owed was expected to stay at INVOICED, on the reasoning that the derived gate
// must always beat the hand-maintained field. Nima's answer (2026-08-04) says
// that field is not bookkeeping in this one position — it is how the NY office
// instructs the warehouse to ship regardless of payment. #47's rule was right
// about the field never BLOCKING, and wrong about it never WAIVING.
test('the NY office can waive the hold: Approved For Shipping ships a due-on-receipt order', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', shippingStatus: 'Approved For Shipping',
      terms: 'Due on receipt', amountRemaining: 90654.4 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.APPROVED)
})

test('the waiver only ever unblocks — it never promotes an unpacked order', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Picked' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', shippingStatus: 'Approved For Shipping',
      terms: 'Due on receipt', amountRemaining: 500 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

test('a waiver on ONE invoice does not speak for another invoice still holding', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', shippingStatus: 'Approved For Shipping',
      terms: 'Due on receipt', amountRemaining: 900 },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV2', shippingStatus: 'Pending Payment',
      terms: 'Due on receipt', amountRemaining: 158 },
  ], { today: new Date('2026-08-04') })
  // Per-invoice, not folded: were the gate read off the order's first non-empty
  // shippingStatus, INV1's waiver would have released INV2's hold.
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

test('cleared payment on a packed order reaches APPROVED', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', terms: 'Net 30', amountRemaining: 5000 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.APPROVED) // net terms never block
})

test('cleared payment does NOT reach APPROVED before the goods are packed', () => {
  const orders = buildPipeline([
    // An invoice can precede its fulfilment. Without the packed guard this order
    // would read "Approved for shipping · Ship it out" while still being picked.
    { source: 'if', stage: STAGE.PICKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Picked' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', terms: 'Net 30', amountRemaining: 5000 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

test('ONE unpaid invoice on a multi-invoice SO holds the whole order', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', terms: 'Due on receipt', amountRemaining: 0 },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV2', terms: 'Due on receipt', amountRemaining: 900 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.INVOICED)
})

test('with no terms or balance the hand-set field still decides (the CSV path)', () => {
  const csv = (shippingStatus) => buildPipeline([
    { source: 'csv', stage: STAGE.INVOICED, soNumber: 'SO1', invoice: 'INV1', shippingStatus },
  ], { today: new Date('2026-08-04') })[0].stage
  assert.equal(csv('Approved For Shipping'), STAGE.APPROVED)
  assert.equal(csv('Pending Payment'), STAGE.INVOICED)
})

test('nothing promotes an order that has no invoice at all', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.PACKED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Packed' },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.PACKED) // the honest "need an invoice" case
})

test('SHIPPED is never walked backwards by an unpaid invoice', () => {
  const orders = buildPipeline([
    { source: 'if', stage: STAGE.SHIPPED, soNumber: 'SO1', ifNumber: 'IF1', ifStatus: 'Shipped',
      actualShipDate: '2026-07-14' },
    { source: 'inv', soNumber: 'SO1', invoice: 'INV1', terms: 'Due on receipt', amountRemaining: 6887 },
  ], { today: new Date('2026-08-04') })
  assert.equal(orders[0].stage, STAGE.SHIPPED)
})
