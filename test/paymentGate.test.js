import test from 'node:test'
import assert from 'node:assert/strict'
import {
  paymentDue, paymentBlocked, clearedReason, overdueInvoices, overdueSummary,
} from '../src/model/paymentGate.js'

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
