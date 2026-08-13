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
//
// ── ⚠️ A DEAD NETSUITE LABEL IS NOT EVIDENCE EITHER (Nima, 2026-08-13) ────────
//
// NetSuite made a WRONG label for IF7486 and will not let him void or replace it —
// the same wall as IF7453, whose tracking reverts on edit. So the box carried a
// tracking number that will never be used, and the push gate refused ShipStation
// with "already has 1 label — ShipStation's job is done". That hold is deliberately
// outside `force`'s reach, and rightly: a second LIVE label is a double charge and a
// wrong number on the ASN.
//
// But the hold rested on a false premise — that a label which EXISTS is a label that
// will be USED. ShipStation has a void button and NetSuite does not, so NetSuite's
// dead labels had no way to be said out loud.
//
// `dead_label` is that button, by hand: a human names one tracking number as
// unusable, with a reason. It then stops counting as evidence here — which is the
// single place the push gate, labelGap and the ASN all read. The rule itself is
// untouched: nothing is inferred, nothing is automatic, and a live label still ends
// the question. See scripts/../server for the endpoint; the marker is reversible.

// Merge the two sources into one de-duplicated list. Order is NetSuite first
// because it is the system of record; ShipStation adds what NetSuite hasn't been
// told yet.
export function labelTracking({ nsTracking = null, ssTracking = null, deadTracking = null } = {}) {
  // Compared on the trimmed string, the same normalisation the merge below uses —
  // a marker that fails to match its own tracking number would silently do nothing,
  // which is the failure mode this whole module exists to prevent.
  const dead = new Set(toList(deadTracking).map((t) => String(t).trim()).filter(Boolean))
  const out = []
  for (const src of [nsTracking, ssTracking]) {
    for (const t of toList(src)) {
      const v = String(t).trim()
      if (v && !dead.has(v) && !out.includes(v)) out.push(v)
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

// The tracking numbers a human has marked dead, for the fulfilment in the OUTER
// query. Same shape and same reason as SHIPSTATION_TRACKING_SQL: written once so
// every consumer reads the identical rule.
//
// ⚠️ No backticks — interpolated into template-literal SQL in server/queries.js,
// where a backtick closes the string and 500s the whole API.
export const DEAD_LABEL_SQL =
  '(SELECT ARRAY_AGG(dl.tracking_number) FROM dead_label dl ' +
  'WHERE dl.if_number = f.if_number)'

function toList(v) {
  if (v == null) return []
  if (Array.isArray(v)) return v
  return [v]
}
