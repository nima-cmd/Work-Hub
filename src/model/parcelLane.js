// src/model/parcelLane.js — which EDI partners ship SMALL PARCEL, not freight.
//
// ⚠️ THE GAP THIS EXISTS TO CLOSE (Nima, 2026-08-11): "we never need to generate
// a BOL for Shopbop and we were about to do one today", and "it would be nice if
// the shopbop would show up in shipstation to make the label".
//
// ShopBop falls between the app's two label lanes and so had neither:
//
//   · the BOUTIQUE push is gated on `orders.source = 'boutique'`, and ShopBop is
//     classified EDI (src/model/source.js — EDI is ShopBop, Nordstrom,
//     Bloomingdale's), so a ShopBop fulfilment never reached the ShipStation
//     candidate list at all;
//   · the EDI push builds only from a ROUTING SHIPMENT, which mints a BOL number
//     — the one document ShopBop must never receive from us.
//
// So the partner is EDI by CHANNEL and parcel by LANE, and those are different
// questions. `deriveSource` stays exactly as it is (the whole pipeline keys on
// it); this module answers the second question on its own.
//
// ── ShopBop's own rules (Vendor Operations Manual, July 2026, §7.3) ──────────
// Under 500 lb is small parcel: UPS Ground, THIRD-PARTY billed to ShopBop's
// account 1135EW. Over 500 lb is LTL/TL, where **Source Alliance** issues the
// BOL — "You may only use the BOLs provided by Source Alliance". Either way the
// BOL is never ours to make.
//
// Verified live 2026-08-11 on IF7507 / SO12446 / PO POJ00391387: NetSuite
// already carries `UPS® Ground` + third-party `1135EW`, and
// shipstationEligibility returns `{push:true, ups_ground, third_party 1135EW}`.
// Nothing about the billing or service needed building — only the lane.

// ONE list, two consumers. The JS predicate and the SQL fragment are both
// derived from it rather than written twice — a rule spelled out in two places
// is the shape that has drifted every time it has been tried in this repo
// (labelGap's label/count pair, getShipDepartures' second copy of the bay).
const PARCEL_PARTNER_NAMES = ['shopbop']

const PARCEL_PATTERNS = PARCEL_PARTNER_NAMES.map((n) => new RegExp(n, 'i'))

// The same rule for the candidate query in server/queries.js, which selects on
// `orders o` and cannot import a regex. Names only — no interpolation of caller
// input ever reaches this string.
export const PARCEL_LANE_SQL =
  '(' + PARCEL_PARTNER_NAMES
    .map((n) => "o.customer ILIKE '%" + n + "%' OR o.location ILIKE '%" + n + "%'")
    .join(' OR ') + ')'

// Does this order ship as small parcel despite being an EDI partner?
// Keyed on customer + location, the same two fields deriveSource reads, so a
// partner named in either place resolves the same way.
export function isParcelLane({ customer, location } = {}) {
  const s = `${location || ''} ${customer || ''}`
  return PARCEL_PATTERNS.some((re) => re.test(s))
}

// May we generate a Bill of Lading for this order?
//
// ⚠️ Live evidence that this needs to be a RULE and not a convention: BOL
// NB1731262 was minted for PO POJ00384244 — a ShopBop order — and recorded under
// partner "Bloomingdale's", because partnerForDc resolves any non-numeric DC to
// Bloomingdale's and ShopBop's DC is `SBX2`. `bol_generated_at` was null, so no
// paper was ever printed, but the number was assigned and the card invited a
// routing. Nima caught it on the way to doing it again.
export function bolAllowed(order = {}) {
  return !isParcelLane(order)
}

// Why the routing surface refuses, in the partner's own terms. Returned instead
// of a bare false so the card can say what to do INSTEAD — a refusal with no
// alternative is how the last lane-gap sent someone looking for a missing button.
export function noBolReason({ customer, location } = {}) {
  if (!isParcelLane({ customer, location })) return null
  return 'ShopBop never takes our BOL — under 500 lb it is UPS Ground parcel on their account 1135EW; over 500 lb Source Alliance issues the BOL. Make the UPS label in ShipStation.'
}
