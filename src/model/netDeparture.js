// src/model/netDeparture.js — did a Net-terms order actually LEAVE?
//
// Nima, 2026-08-13, the day after the Net flow went in:
//
//   "for net 30 since we are marking as shipped before it departs which is a
//    departure from our other format i think we may need to manually confirm they
//    shipped out in the system on those ones. Since within netsuite in my searches
//    they are invisible to me"
//
// He is right, and this closes a hole in PR #91. That PR caught the first half —
// marked shipped with no invoice yet — and then handed the second half straight to
// `DEPARTED` on no evidence whatsoever.
//
// ── Why there is no automatic answer ────────────────────────────────────────
//
// Every departure signal the app has is now derived from the same keystroke:
//   • `fulfillments.actual_ship_date` is set when he marks shipped — which, under
//     the Net flow, happens when the LABEL is made, before anything moves.
//   • the `DEPARTED` ledger event (185 of them) is derived FROM that date, so it
//     inherits the same meaning and loses it at the same moment.
//   • a carrier label proves a label was bought, never that a truck came — the
//     rule already established in [[marked-shipped-is-not-departed]] and
//     [[ship-gate-and-ship-date]].
//
// So there is nothing left to derive from, and inventing one would be the fourth
// counter-bug shape: a mechanism no code implements. A human saw the goods go, or
// nobody did. Hence a manual marker, on the PREPPED pattern — a plain ledger event
// with no side effect on NetSuite, no stage move, and an undo.
//
// ⚠️ THE POINT IS VISIBILITY, NOT BOOKKEEPING. NetSuite now hides these orders from
// his searches the moment he marks them shipped, so if the app also calls them
// departed, NOTHING anywhere is tracking goods that are physically still here.
export const DEPARTURE_CONFIRMED = 'DEPARTURE_CONFIRMED'
export const DEPARTURE_UNCONFIRMED = 'DEPARTURE_UNCONFIRMED'

// ── The epoch ───────────────────────────────────────────────────────────────
//
// The flow changed on 2026-08-12. Orders marked shipped BEFORE that were marked at
// the moment they actually left — that was the old flow — so demanding a
// confirmation for them would invent 14 chores for goods long gone, and the list
// would open full of work nobody can do. The same epoch split that made the filing
// chip usable ([[step-7-filing-record]]).
//
// Measured 2026-08-13, and the boundary is unusually clean: of the 15 Net-terms
// boutique fulfilments reading Shipped, exactly ONE (IF7480, Joseph Wexner) is
// dated on or after the epoch. The next most recent is 6 days earlier and already
// invoiced. So this opens at 1 — his own live example — not 15.
export const NET_FLOW_EPOCH = '2026-08-12'

// Latest-event-wins, exactly like isPrepped: a marker that could only ever be set
// would make a mis-click permanent.
export function isDepartureConfirmed({ departureConfirmedAt, departureUnconfirmedAt } = {}) {
  if (!departureConfirmedAt) return false
  if (!departureUnconfirmedAt) return true
  return new Date(departureConfirmedAt) >= new Date(departureUnconfirmedAt)
}

// Is this fulfilment inside the new flow at all?
//
// Three things have to be true, and the date is the one that keeps history out.
// `shipDate` is the fulfilment's actual_ship_date — under this flow the date the
// label was made, which is exactly the date we want to test: it is when the order
// ENTERED the state, not when it left it.
export function inNetFlow({ terms, source, shipDate, netTerms }, epoch = NET_FLOW_EPOCH) {
  if (source === 'edi') return false
  if (!netTerms(terms)) return false
  if (!shipDate) return false
  return String(new Date(shipDate).toISOString().slice(0, 10)) >= epoch
}

// Does this fulfilment still owe us a "yes, it went" — i.e. is it sitting here
// looking departed to every system we have?
//
// Ordered deliberately: an order with no invoice yet is NOT this question. It is
// one step earlier (SHIPPED_AWAITING_INVOICE), and asking both at once would be
// the lump this board keeps being fixed for.
export function needsDepartureConfirm({ shipped, invoiced, confirmed } = {}) {
  return !!shipped && !!invoiced && !confirmed
}

// The sentence, naming the date it was marked shipped — because "when did this
// actually go?" is the whole question, and the ship date on the record is now the
// label date, which is precisely what makes it untrustworthy here.
//
// ⚠️ `timeZone: 'UTC'`, matching fmtDay in postCustody.js. actual_ship_date is a
// DATE-ONLY string, which Date parses as UTC midnight — so rendering it in a
// US local zone prints the day BEFORE. Caught live: IF7480, shipped 2026-08-13,
// read "Marked shipped Aug 12" on the first run. The same off-by-one that made a
// fresh NetSuite fix look stale ([[style-number-versions]]).
export function departureLabel({ shipDate, daysSince } = {}) {
  const when = shipDate
    ? new Date(shipDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null
  const age = typeof daysSince === 'number' && daysSince > 0
    ? ` — ${daysSince}d ago`
    : ''
  return `Marked shipped${when ? ` ${when}` : ''}${age}. Confirm it physically left`
}
