// src/model/transferOrder.js — a transfer order as work we track.
//
// Nima, 2026-08-27: "we will ship to office or to consignment through transfer orders
// we right now have no way to track them ... its genuinely work we want to track its
// not a container being shipped to us in the shape of a transfer order."
//
// That last clause is the whole rule. NetSuite holds 187 transfer orders and most of
// them are the thing he is NOT asking for — stock moving INTO the warehouse. Measured
// 2026-08-27:
//
//   Warehouse          79      inbound to us
//   Virtual Warehouse  59      internal
//   Nordstrom          15   \
//   Bloomingdale's     12    >  partner locations — real, but not what he named
//   Shopbop             6   /
//   Office             10      ← tracked
//   Consignment         4      ← tracked
//   Saint Bernard       1
//   Offsite Storage     1
//
// ⚠️ THIS IS AN ENTERED LIST, NOT AN INFERRED RULE, and it has to be. Direction is not
// derivable: `transaction.location` — the FROM side — is not queryable on a transfer
// order, returning zero rows even when selected alone (the same shape as
// item.baseprice). Only the destination is observable, so "is this outbound work" can
// only be answered by naming the destinations, and Nima named two.
//
// ⚠️ Widening this is a decision, never a guess. The 33 partner-location transfers are
// deliberately excluded until he says otherwise; adding them silently would put freight
// on a shared calendar that nobody asked to see there.

/** The destinations Nima named. Compared case-insensitively, trimmed. */
export const TRACKED_DESTINATIONS = ['Office', 'Consignment']

const norm = (s) => String(s || '').trim().toLowerCase()

/** Is a transfer to this destination work we track? */
export function isTrackedDestination(destination) {
  const d = norm(destination)
  return !!d && TRACKED_DESTINATIONS.some((t) => norm(t) === d)
}

/**
 * ⚠️ An UNKNOWN destination is NOT tracked, and is not an error either. A new location
 * appearing in NetSuite is a thing to tell Nima about, not a thing to start publishing
 * to a shared calendar on our own initiative.
 */
export function trackedTransfers(rows = []) {
  return rows.filter((r) => isTrackedDestination(r.destination))
}

/** Destinations we saw that we do not track — so a new one can be reported, not lost. */
export function untrackedDestinations(rows = []) {
  const seen = new Map()
  for (const r of rows) {
    if (isTrackedDestination(r.destination)) continue
    const d = String(r.destination || '(none)').trim() || '(none)'
    seen.set(d, (seen.get(d) || 0) + 1)
  }
  return [...seen.entries()].map(([destination, count]) => ({ destination, count }))
    .sort((a, b) => b.count - a.count)
}

// NetSuite states, as its own status strings render them.
export const RECEIVED = 'Transfer Order : Received'

/**
 * Has it arrived at the far end?
 *
 * ⚠️ NetSuite's "Received" is the OTHER END confirming, which is exactly the thing Nima
 * says does not always happen ("sometimes they dont receive on their end"). So this is
 * evidence of receipt when present and NOT evidence of anything when absent — an
 * unreceived transfer may well have arrived. Anything reporting on it has to say
 * "not confirmed received", never "not delivered".
 */
export const isReceived = (status) => norm(status) === norm(RECEIVED)

/** One line for a surface. Names the destination, because that IS the shipment. */
export function transferHeadline({ toNumber, destination, status } = {}) {
  const where = destination || 'an unnamed location'
  return isReceived(status)
    ? `${toNumber} → ${where} · received`
    : `${toNumber} → ${where} · not confirmed received`
}


// ── Where a transfer's scanned paperwork is filed ───────────────────────────
//
// Nima, 2026-08-27: "its fine to go under boutiques as Naghedi for Office and
// Consignment for Consignment."
//
// ⚠️ AN ENTERED MAPPING, not a derivation. The destination is a NetSuite location name
// and the folder is what a person expects to find in Drive; "Office" would read as
// someone else's boutique sitting among 37 real ones, so he named it Naghedi — our own
// goods, under our own name. Nothing computes that, and nothing should try.
const FILING_FOLDER = {
  office: 'Naghedi',
  consignment: 'Consignment',
}

/**
 * The Boutiques/<folder>/ a transfer's paperwork belongs under.
 *
 * ⚠️ Returns null for anything unmapped, and the caller must SKIP rather than invent a
 * folder. scanFiling.js already holds that line for boutique slips — "a slip in the
 * wrong place is harder to find than one that was never filed and said so" — and a
 * transfer to a new destination is exactly when that matters.
 */
export function transferFilingFolder(destination) {
  return FILING_FOLDER[norm(destination)] || null
}
