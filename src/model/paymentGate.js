// src/model/paymentGate.js — is payment actually blocking this shipment?
//
// Built 2026-08-04 after Nima corrected the "mark shipped" chip. It was flagging
// two boutique IFs (IF7409, IF7413) as "you forgot to mark these shipped" when
// both were deliberately held for payment. The chip's only test was "has a
// tracking number", and a label is printed AT PACK TIME — before the payment
// gate clears — so a tracking number is not evidence that anything departed.
//
// ⚠️ THE OBVIOUS FIX IS THE WRONG ONE. Gating on `invoices.shipping_status`
// (the NetSuite custom field: Pending Payment / Approved For Shipping / Shipped /
// FOB Pending Approval) would read correctly today, but that field is MAINTAINED
// BY HAND — it is the tedious work Nima wants removed, so building a dependency
// on it hard-codes the chore. Measured 2026-08-04 across 480 invoices since May:
// only 3 sat at Pending Payment and all 3 were genuinely blocked, so the field
// is accurate — the cost of it is the LABOUR, not errors.
//
// So shippability is DERIVED from objective fields instead: the terms, what is
// still owed, and the due date.
//
// The manual field survives in exactly ONE role, added 2026-08-04 once Nima
// explained what it is for: a one-way WAIVER. `Approved For Shipping` on a
// due-on-receipt invoice is the NY office saying "ship it regardless of payment",
// which is a decision no objective field can hold. It can only ever unblock —
// see `approvedToShip` below for why that keeps the dependency harmless.
//
// The rule, in Nima's words (2026-08-04): "if an invoice is net 30 45 or 60 it
// can ship, or if no payment is due … If we are however waiting for payment we
// have to check the invoice status to see if it's been paid in full and then
// manually mark the invoice as approved to ship."

// "Net 30" / "Net 45" / "Net 60" — payment comes after the goods. Also matched
// loosely because NetSuite terms are free-form label text ("2% Net 30" exists in
// other accounts); anything naming Net is a pay-later arrangement.
const NET_TERMS = /\bnet\b/i

// "No Payment Required" — 3 live invoices carry it. Nothing is ever owed.
const NO_PAYMENT = /no\s*payment/i

// "Due on receipt" is the only live terms value that demands money BEFORE the
// goods move, and it is what both held IFs carry.
export function paymentDue(terms) {
  if (!terms) return true              // unknown terms: assume money is due
  if (NO_PAYMENT.test(terms)) return false
  if (NET_TERMS.test(terms)) return false
  return true
}

// ── THE NY OVERRIDE (Nima, 2026-08-04) ───────────────────────────────────────
//
// "We also check for a manual set of the approved to ship on orders that are due
// on receipt — this is how our NY office lets us know that they want something
// shipped regardless of payment."
//
// So `shipping_status = Approved For Shipping` on a Due-on-receipt invoice is not
// bookkeeping, it is an INSTRUCTION from another office, and it is the one thing
// the derived gate cannot work out for itself: no objective field records a
// decision to waive payment.
//
// ⚠️ This does NOT reintroduce the dependency the header warns about, because it
// can only ever UNBLOCK. If nobody has touched the field — or it is stale, or the
// sync never pulled it — the answer falls back to the derived one, which is
// "blocked". The failure direction is holding goods we could have shipped, never
// shipping goods we were supposed to hold.
//
// Only the approval value counts. `Shipped` is not an approval (it describes
// something already gone, and 2 live invoices carry it with a balance still
// open); `Pending Payment` and `FOB Pending Approval` are holds, not waivers.
const APPROVED_TO_SHIP = /approved\s*for\s*shipping/i

export function approvedToShip(shipGate) {
  return APPROVED_TO_SHIP.test(String(shipGate || ''))
}

// Does payment block this shipment RIGHT NOW?
//
// ⚠️ Net terms that have gone PAST DUE still do NOT block (Nima, 2026-08-04).
// Strictly "payment is now due", but he was explicit that chasing an overdue
// invoice is not a shipping decision — it's a signal that something is wrong
// somewhere else (a payment not posted, or an 810 never sent to a partner).
// Holding goods over it would be the app inventing a policy nobody asked for.
// Overdue invoices get their own list instead — see `overdueInvoices` below.
export function paymentBlocked({ terms, amountRemaining, shipGate } = {}) {
  const owed = Number(amountRemaining ?? 0)
  if (!(owed > 0)) return false        // nothing outstanding — never blocked
  if (approvedToShip(shipGate)) return false   // NY said ship it anyway
  return paymentDue(terms)
}

// Why it's clear to ship — for the UI to say something specific rather than
// just suppressing a chip. Null when payment IS blocking.
export function clearedReason({ terms, amountRemaining, shipGate } = {}) {
  const owed = Number(amountRemaining ?? 0)
  if (!(owed > 0)) return 'paid in full'
  if (NO_PAYMENT.test(terms || '')) return 'no payment required'
  if (NET_TERMS.test(terms || '')) return `${String(terms).trim()} — not due yet`
  // Named as a decision, not as a state: this row IS owed money and due, and the
  // only reason it can move is that a person said so. Worth reading as such on
  // the screen, because it is the one clearance nothing objective backs up.
  if (approvedToShip(shipGate)) return 'approved to ship despite balance (NY office)'
  return null
}

// ── the overdue list (Nima's ask, secondary priority) ────────────────────────
//
// "While it doesn't directly fall into our job it's nice to know if an invoice
// is overdue in payment. It would let us know if something is wrong either in
// payment being posted, or … if there needs to be an inquiry into an 810 or
// invoice not sent."
//
// So this is a DIAGNOSTIC, not a work queue: an overdue invoice means either the
// money arrived and wasn't posted, or we never actually asked for it. On the EDI
// lane the second case is checkable — an overdue partner invoice whose 810 never
// reached the partner is "we never billed them", which is the claim the 810 chip
// was previously unable to support (see the note in asn-resend-vs-exposure:
// whether those invoices were paid was not checkable from Neon at the time).
//
// `ediInvoiceDelivered` is a predicate the caller supplies (inv number → boolean
// | null). null = unknown/not an EDI invoice, and is reported as unknown rather
// than being counted as a missing 810 — an absent record is not evidence.
export function overdueInvoices(invoices = [], { today = new Date(), ediInvoiceDelivered } = {}) {
  const now = today instanceof Date ? today : new Date(today)
  const day = 86_400_000
  const out = []

  for (const inv of invoices) {
    const owed = Number(inv.amountRemaining ?? 0)
    if (!(owed > 0)) continue                    // paid — nothing to chase
    // "No Payment Required" with a balance is not a debt. Live: INV11336 carried
    // $79.86 at 33 days and would have read as overdue money owed to us.
    if (NO_PAYMENT.test(inv.terms || '')) continue
    if (!inv.dueDate) continue                   // no due date: can't call it late
    const due = new Date(inv.dueDate)
    if (!Number.isFinite(due.getTime())) continue
    const daysOverdue = Math.floor((now - due) / day)
    if (daysOverdue <= 0) continue               // not due yet

    // Was the 810 ever delivered to the partner? Only meaningful on EDI.
    const delivered = typeof ediInvoiceDelivered === 'function'
      ? ediInvoiceDelivered(inv.invNumber)
      : null

    out.push({
      invNumber: inv.invNumber,
      soNumber: inv.soNumber ?? null,
      customer: inv.customer ?? null,
      source: inv.source ?? null,
      terms: inv.terms ?? null,
      dueDate: inv.dueDate,
      amountRemaining: owed,
      daysOverdue,
      // The point of the list: which inquiry does this row call for?
      //   'never-billed'   — EDI, and no 810 ever reached the partner. Ask why.
      //   'chase-payment'  — we DID bill them, or it's boutique (where no 810
      //                      exists to check). Payment or posting is the
      //                      question, not the document.
      //   'unknown-810'    — EDI but we hold no 810 record either way.
      //   'unknown-source' — we don't know which lane this invoice is on, so we
      //                      can't say whether an 810 was even owed.
      //
      // ⚠️ An unknown source must NOT default to 'chase-payment' — that asserts
      // we billed them. It happens constantly: `source` comes from the joined
      // order, and 1,015 invoices legitimately carry a NULL so_number because
      // their order sits outside the 30-day window (by design, since PR #40).
      // First live run classified all 70 rows as 'chase-payment' purely through
      // this default.
      inquiry: delivered === false ? 'never-billed'
        : delivered === true ? 'chase-payment'
          : inv.source === 'edi' ? 'unknown-810'
            : inv.source ? 'chase-payment' : 'unknown-source',
    })
  }

  out.sort((a, b) => b.daysOverdue - a.daysOverdue)
  return out
}

export function overdueSummary(rows = []) {
  return {
    count: rows.length,
    amount: rows.reduce((n, r) => n + r.amountRemaining, 0),
    neverBilled: rows.filter((r) => r.inquiry === 'never-billed').length,
    unknown810: rows.filter((r) => r.inquiry === 'unknown-810').length,
    unknownSource: rows.filter((r) => r.inquiry === 'unknown-source').length,
    chasePayment: rows.filter((r) => r.inquiry === 'chase-payment').length,
    oldestDays: rows.reduce((m, r) => Math.max(m, r.daysOverdue), 0),
  }
}
