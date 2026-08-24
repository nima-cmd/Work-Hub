// src/model/pushReport.js — combining two ShipStation push passes into one report.
//
// The Routing button pushes TWO lanes in one click (Nima, 2026-08-24: "we expected in
// routing when we pushed to shipstation that it would push that order as well as the
// bloomingdales it pushed"):
//
//   · FREIGHT — built from routing shipments and a BOL
//   · PARCEL  — built from a fulfilment plus a live NetSuite address and service
//
// ⚠️ THIS IS A MODULE BECAUSE OF WHAT THE OBVIOUS VERSION DOES. The freight pass
// returns its own `pushed`, `failed` and `results`. Spreading it and adding the parcel
// numbers only to `candidates` — the natural way to write it — leaves `pushed`
// reporting ONE lane under a label that now covers two. That is a counter that counts
// something other than what it says, the second shape in CLAUDE.md's list, and it
// would have been committed in the act of fixing an unreachable branch.
//
// So every total is recomputed from both sides, here, where it can be tested.

/**
 * @param freight  the routing-shipment pass: { pushed, failed, results, skipped, … }
 * @param parcel   the parcel-lane pass, same shape (or null when it did not run)
 * @param extra    fields only the caller knows (scope, shipments, seen, locationHeld)
 */
export function mergePushReports(freight = {}, parcel = null, extra = {}) {
  const p = parcel || {}
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    ...freight,
    ...extra,
    // ⚠️ AFTER the spreads, always. Both objects above carry these keys, and letting
    // either win is the whole bug this file exists to prevent.
    pushed: n(freight.pushed) + n(p.pushed),
    failed: n(freight.failed) + n(p.failed),
    candidates: n(freight.candidates) + n(p.candidates),
    recorded: n(freight.recorded) + n(p.recorded),
    results: [...(freight.results || []), ...(p.results || [])],
    // Both lanes' refusals, each keeping its own reason — a merged list with the
    // reasons stripped would say "8 skipped" and answer no question at all.
    skipped: [...(freight.skipped || []), ...(p.skipped || [])],
    // ⚠️ Named sub-report, so a total nobody expected can always be attributed to a
    // lane. A combined number with no breakdown is how "why did it push that?" becomes
    // unanswerable.
    parcelLane: parcel
      ? { candidates: n(p.candidates), pushed: n(p.pushed), seen: n(p.seen), skipped: (p.skipped || []).length }
      : null,
  }
}
