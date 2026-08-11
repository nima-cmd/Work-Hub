// src/model/labelEvidence.js — does this fulfilment have a carrier label, from
// ANY source we can see?
//
// ⚠️ WHY THIS EXISTS (found 2026-08-11, hours after shipping the push it breaks).
// A label can live in three places, and until now the app only read one:
//
//   1. NetSuite — `TrackingNumberMap`, which the live sync copies into
//      `fulfillments.tracking_numbers`. This is the only place NetSuite exposes
//      IF tracking at all (`transaction.trackingnumbers` is not a queryable
//      field), and it is where a label bought inside NetSuite lands.
//   2. ShipStation — `shipstation_order.tracking_number`, written by the
//      read-only harvest after a human buys the label there.
//   3. Nobody — the label exists on paper only. IF7412 is this case: a real FedEx
//      label, `TrackingNumberMap` empty, so no system knows. Nothing here can fix
//      that, and `PACKED_NO_LABEL` already says it honestly.
//
// The live defect: IF7507's three ShipStation labels were in (2) and NOT (1), so
// `labelCount` read 0 and the fulfilment still looked unlabelled — to the push
// gate that is meant to prevent a second label, and to labelGap's "needs a label"
// chip. Both surfaces asked one source a question that has two answers.
//
// A VOIDED ShipStation label is not evidence — that is the whole point of
// voiding — so the caller must exclude voided rows (see SHIPSTATION_TRACKING_SQL).

// Merge the two sources into one de-duplicated list. Order is NetSuite first
// because it is the system of record; ShipStation adds what NetSuite hasn't been
// told yet.
export function labelTracking({ nsTracking = null, ssTracking = null } = {}) {
  const out = []
  for (const src of [nsTracking, ssTracking]) {
    for (const t of toList(src)) {
      const v = String(t).trim()
      if (v && !out.includes(v)) out.push(v)
    }
  }
  return out
}

// How many labels this box carries, from any source. The number the push gate and
// labelGap both key on, so they can no longer disagree about the same box.
export function labelCount(sources = {}) {
  return labelTracking(sources).length
}

export function isLabelled(sources = {}) {
  return labelCount(sources) > 0
}

// Non-voided ShipStation tracking for the fulfilment in the OUTER query, as a
// Postgres array. Written once here so the push candidates and the labelGap feed
// cannot drift — the two-copies shape this repo keeps getting bitten by.
//
// ⚠️ No backticks: this is interpolated into template-literal SQL in
// server/queries.js, where a backtick closes the string and 500s the whole API.
export const SHIPSTATION_TRACKING_SQL =
  '(SELECT ARRAY_AGG(so.tracking_number) FROM shipstation_order so ' +
  "WHERE so.if_number = f.if_number AND so.tracking_number IS NOT NULL " +
  'AND NOT COALESCE(so.voided, false))'

function toList(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  return [v]
}
