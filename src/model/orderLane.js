// src/model/orderLane.js — WHICH SHAPE IS THIS ORDER?
//
// Nima, 2026-08-20, giving the grouping model in his own words:
//
//   "1-OC-PO-SO-IF-IN for orders that match the po and are ordered directly.
//    2-PO - general stock — these are the ats order and such, nothing directly linked
//      so a purchase order. the PO adds to our pool for which we pull our sales order
//      units. meaning these look like SO-IF-INV (ats).
//    3- Boutiques are strange since we will have oc for a bunch grouped under one PO
//      but there's no direct connection and the PO may have more or less units then we
//      need. the PO to oc connection is what matters here … OC-SO-IF-INV."
//
// This turns that into a classifier, so a trace can group an order's documents by the
// role they play in ITS shape rather than showing one flat list for every order.
//
// ── What the data said when this was measured (2026-08-20, all 322 tracked) ──
//
//   193  EDI, non-ATS, no OC        → their PO is the anchor
//    60  boutique, non-ATS, has OC  → OC-anchored (his lanes 1 AND 3)
//    40  boutique, ATS, no OC       → pulled from the pool. Exactly his lane 2.
//    29  boutique, non-ATS, no OC   → fits NONE of his lanes
//
// ⚠️ THERE IS A FOURTH LANE HE DID NOT LIST, and it is 60% of the board. His three
// lanes all answer "where did the UNITS come from" (supply). EDI answers a different
// question — where the DEMAND came from — and its anchor is the partner's own PO off
// their 850, not our OC and not our factory PO. Without it most orders have no home.
//
// ⚠️ HIS LANES 1 AND 3 ARE NOT DISTINGUISHABLE TODAY, and this file does not pretend
// otherwise. Telling "the PO was ordered directly for this OC" from "several OCs sit
// under one PO" requires the OC↔PO link, and that edge barely exists:
// `purchase_orders.linked_oc` is populated on 0 of 1,436 rows and the app's own
// `oc_po_links` holds 5. So both collapse into OC_ANCHORED and the lane says so.
// Splitting them on a guess would put a shape on screen nobody entered — the
// default-is-not-an-answer rule.
//
// ⚠️ "PO" IS TWO DIFFERENT THINGS. `orders.po_number` is the CUSTOMER's PO to us;
// `purchase_orders.po_number` is OURS to the factory. Measured: zero overlapping
// values across all 322 orders. Every lane below names which one it means, and any
// surface printing one must too.

export const LANES = {
  EDI: {
    key: 'edi',
    label: 'EDI order',
    shape: 'their PO → SO → IF → INV',
    anchor: 'theirPo',
    anchorLabel: 'their PO',
    blurb: 'The partner sent an 850. Their own PO number is the anchor, and the ASN and '
      + 'invoice go back out against it.',
  },
  OC_ANCHORED: {
    key: 'oc_anchored',
    label: 'Confirmed order',
    shape: 'OC → SO → IF → INV',
    anchor: 'oc',
    anchorLabel: 'OC',
    // Deliberately ONE lane covering his 1 and 3 — see the header.
    blurb: 'Sold against an order confirmation. Whether its factory PO was ordered '
      + 'directly for it, or it shares one with other OCs, is not something we can '
      + 'currently tell — the OC↔PO link is unpopulated.',
  },
  STOCK: {
    key: 'stock',
    label: 'From stock',
    shape: 'SO → IF → INV',
    anchor: null,
    anchorLabel: null,
    blurb: 'Available to sell — the units came out of the pool our factory POs stock, '
      + 'so no purchase order is linked to this order and none should be.',
  },
  UNCONFIRMED: {
    key: 'unconfirmed',
    label: 'Presold, no confirmation',
    shape: 'SO → IF → INV',
    anchor: null,
    anchorLabel: null,
    // Not a bug on its own. Measured 29, and they include the FOB-China lane (Eve
    // Group, location 'China') and in-house NAGHEDI orders, which are plausibly
    // their own flows rather than missing paperwork. Named honestly instead of being
    // forced into a lane it does not belong to.
    blurb: 'Presold rather than from stock, but no order confirmation is linked. Either '
      + 'entered straight as a sales order, or part of a flow that does not use an OC.',
  },
}

const L = LANES

/**
 * Which lane is this order in?
 *
 * Reads only OBSERVED fields — `source`, `is_ats`, and the presence of an OC — and
 * never infers one from another. `is_ats` is the field that was dead on all 282
 * orders once (see fieldAssumptions.js), so `null` is treated as UNKNOWN here rather
 * than as false: an order whose ATS flag never arrived must not be reported as
 * presold-with-no-confirmation, which is the lane that reads like a problem.
 */
export function laneFor(order = {}) {
  const source = String(order.source || '').toLowerCase()
  const hasOc = !!(order.ocNumber || order.oc_number)
  const isAts = order.isAts ?? order.is_ats ?? null

  // EDI first, and on SOURCE — not on "has a customer PO", which boutiques also have
  // (30 of 89 of them do). The 850 is what makes it this lane.
  if (source === 'edi') return L.EDI
  // An OC is a fact, so it settles the lane whatever the ATS flag says.
  if (hasOc) return L.OC_ANCHORED
  if (isAts === true) return L.STOCK
  if (isAts === false) return L.UNCONFIRMED
  // ATS unknown and no OC: we genuinely cannot place it. Return null so callers show
  // "unknown" rather than a lane that sounds like a finding.
  return null
}

export const laneKey = (order) => laneFor(order)?.key || null

/**
 * The anchor document for an order's group — the thing its whole chain hangs off.
 * Returns { docType, docNumber, label } or null.
 *
 * ⚠️ 'THEIR_PO' is a distinct docType from 'PO' on purpose. `orders.po_number` is the
 * customer's PO and `purchase_orders.po_number` is ours; they share no values, and a
 * single 'PO' type would let a trace hop from a customer's PO number into our factory
 * PO table and render a document that has nothing to do with the order.
 */
export function anchorFor(order = {}) {
  const lane = laneFor(order)
  if (!lane?.anchor) return null
  if (lane.anchor === 'oc') {
    const oc = order.ocNumber || order.oc_number
    return oc ? { docType: 'OC', docNumber: String(oc), label: 'OC' } : null
  }
  const po = order.poNumber || order.po_number
  return po ? { docType: 'THEIR_PO', docNumber: String(po), label: 'their PO' } : null
}

/**
 * Where does a document sit relative to the order — upstream of it, the order itself,
 * or downstream? This is what lets a trace GROUP instead of listing, which is the
 * whole point: Nima asked for organization and specifically for the same thing not to
 * appear twice in different places.
 */
export const ROLES = {
  upstream: { key: 'upstream', label: 'Where it came from' },
  order: { key: 'order', label: 'The order' },
  downstream: { key: 'downstream', label: 'What came out of it' },
  work: { key: 'work', label: 'Mail & tasks' },
}

const ROLE_BY_TYPE = {
  OC: 'upstream',
  THEIR_PO: 'upstream',
  PO: 'upstream',
  SO: 'order',
  IF: 'downstream',
  INV: 'downstream',
  TRACK: 'downstream',
  EMAIL: 'work',
  TASK: 'work',
}

export const roleFor = (docType) => ROLE_BY_TYPE[String(docType || '').toUpperCase()] || 'work'

/** Group cards into the four roles, dropping empty groups, in a fixed reading order. */
export function groupByRole(cards = []) {
  const order = ['upstream', 'order', 'downstream', 'work']
  const bucket = new Map(order.map((k) => [k, []]))
  for (const c of cards) bucket.get(roleFor(c.docType))?.push(c)
  return order
    .map((k) => ({ ...ROLES[k], cards: bucket.get(k) }))
    .filter((g) => g.cards.length)
}
