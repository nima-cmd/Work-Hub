// src/model/closeReady.js — can this BOL be closed out?
//
// Nima, 2026-08-05: "letting us know if the orderful ASN been sent that the
// shipment can be marked as shipped."
//
// The partner ACCEPTING the 856 is the outside world agreeing the shipment
// exists. That is the strongest confirmation this board can get — stronger than
// anything we assert about ourselves, because we cannot fake it.
//
// ⚠️ EVIDENCE ONLY. Nothing here closes anything. `ok` lights the existing
// manual button; deciding automatically is a call Nima hasn't made, and the day
// this was written already showed what a confident automatic state change costs
// when the signal turns out to mean something else (see
// src/model/orderEvents.js on marking shipped, which is NOT a departure).
//
// ⚠️ BOTH halves must agree, and neither alone is enough:
//   · 856 accepted but NetSuite still has open IFs → `asnAheadOfNetsuite`
//     already tells you to go mark them. Closing here would hide that.
//   · IFs shipped but no 856 → that is the announcement gap the ASN carton
//     check owns, and closing would bury a chargeback risk.
//
// It lives in the model, not inline in the query layer, for the reason this
// repo keeps relearning: pure logic written inline never gets a test, and
// labelGap.js and custody.js both had to be extracted after being wrong.

export function closeReadiness({ shippedAt = null, ackStatus = null, hasAsn = false, netsuiteConfirmed = false } = {}) {
  // Already archived — there is nothing left to decide.
  if (shippedAt) return null

  const asnOk = ackStatus === 'ACCEPTED'
  if (asnOk && netsuiteConfirmed) {
    return { ok: true, why: '856 accepted by the partner and NetSuite calls every IF shipped' }
  }

  const missing = []
  if (!hasAsn) missing.push('no 856 on file yet')
  else if (!asnOk) missing.push(`856 is ${String(ackStatus || 'unacknowledged').toLowerCase()}`)
  if (!netsuiteConfirmed) missing.push('NetSuite has IFs not marked shipped')
  return { ok: false, why: missing.join(' · ') }
}
