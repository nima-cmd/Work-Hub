// src/model/macysRouting.js — the Macy's Routing Guide, as data.
//
// Covers Macy's, Bloomingdale's and Bloomingdale's Outlet. Extracted 2026-09-15 from
// the guide Nima supplied, which is the CURRENT one: its Summary of Changes is headed
// 4/14/26.
//
// ⚠️ RULES WITH A PAGE, NOT REMEMBERED RULES — the same discipline as saksRouting.js.
// A routing guide is reissued without notice and the app must not become a second stale
// source alongside everyone's memory.
//
// ⚠️ AND THIS IS A DIFFERENT DOCUMENT FROM THE VENDOR STANDARDS. macysStandards.js holds
// Appendix H (the merchandise-side expense offsets, 2023 edition). This holds the
// TRANSPORTATION expense offsets in §12.1, which are a separate schedule with separate
// amounts. Both can fire on one shipment.

export const SOURCE = {
  guide: "Macy's Routing Guide",
  revision: '4/14/26',
  revisionSource: 'the Summary of Changes table, p4',
  covers: ["Macy's", 'macys.com', "Bloomingdale's", 'bloomingdales.com'],
  excludes: 'Canada — the MTO handles shipments originating within the United States only (p5, §1.0)',
  office: {
    name: "Macy's Transportation Office (MTO)",
    address: '4401 Sarr Parkway, Stone Mountain, GA 30083',
    email: 'shippingops@macys.com',
    hours: '8:00 AM to 6:00 PM Eastern, Monday through Friday',
    page: 2,
  },
  technology: { email: 'ECTech@macys.com', phone: '(513) 782-1222', page: 5 },
  documentKey: 'macys-routing',
}

/**
 * ⚠️ THREE DISTRIBUTION CENTRES WERE REMOVED ON 4/14/26 and the change is the top row of
 * the Summary of Changes: "Cheshire/West Johnson/Sacramento Distribution Centers
 * removed" (p4).
 *
 * Checked against our own data on extraction: one order names Cheshire —
 * SO11521, "Bloomingdale's - 0135 Cheshire Pool Stock/Customer Fulfillment Center" —
 * and it SHIPPED 2026-04-07, a week before the removal. Historical, not live. Recorded
 * anyway so a future routing to one of these is caught rather than discovered at a
 * closed dock.
 */
export const REMOVED_DCS = {
  removedOn: '2026-04-14',
  names: ['Cheshire', 'West Johnson', 'Sacramento'],
  page: 4,
  note: 'Removed in the 4/14/26 revision. Any PO still routing to one of these is a question for MTO, not a destination.',
}

export const isRemovedDc = (name) =>
  REMOVED_DCS.names.some((n) => new RegExp(n.replace(/\s+/g, '\\s*'), 'i').test(String(name ?? '')))

/**
 * ⚠️ NEVER PREPAY AND ADD. §3.0, p6, in capitals in the guide itself: "DO NOT PREPAY AND
 * ADD FREIGHT CHARGES TO THE MERCHANDISE INVOICE. Merchandise invoices that contain
 * freight charges will be paid net of freight charges."
 *
 * This is the exact OPPOSITE of the Exemplar PO we shipped on 2026-09-14, whose header
 * read Freight: Prepaid — which is why the BOL's freight term must never be a default
 * shared across partners. Same field, opposite answers, both correct for their partner.
 */
export const FREIGHT_POLICY = {
  rule: 'Collect basis or third-party bill, unless MTO pre-approves otherwise',
  neverPrepayAndAdd: true,
  consequence: 'Merchandise invoices containing freight are paid NET of freight; unapproved freight invoices are returned unpaid',
  prepaidNote: 'All prepaid shipments to a Macy\'s facility are DRIVER UNLOAD and must be delivered on or before the cancel date (p6, §4.2)',
  page: 6,
  section: '3.0',
}

/**
 * Freight charge terms by carrier — §9.1, p13.
 *
 * ⚠️ RXO IS THE ONLY THIRD-PARTY LANE, and it has its own bill-to address. Everything
 * else is Collect. server/bolPdf.js has derived exactly this (`/XLTL|RXO/ ? '3rd' :
 * 'Collect'`) since before the guide was read — correct by accident, and now checkable.
 *
 * ⚠️ FXFE WAS MISSING FROM bolAddresses.CARRIERS. The guide names "FedEx Freight – LTL
 * (FXFE or FXNL)" and we held only FXNL, so a shipment assigned FXFE resolved to no
 * carrier at all.
 */
export const FREIGHT_TERMS = {
  TL: { terms: 'Collect', carrier: 'as assigned by Macy\'s Transportation' },
  IM: { terms: 'Collect', carrier: 'as assigned by Macy\'s Transportation' },
  FXFE: { terms: 'Collect', name: 'FedEx Freight', mode: 'LTL' },
  FXNL: { terms: 'Collect', name: 'FedEx Freight', mode: 'LTL' },
  XLTL: {
    terms: '3rd Party', name: 'RXO Logistics', mode: 'LTL',
    billTo: ["Macy's c/o RXO", 'PO Box 49069', 'Charlotte, NC 28277'],
    billToPage: 13,
  },
  DYXI: { terms: 'Collect', name: 'Dynamic LTL', mode: 'LTL' },
  PAAF: { terms: 'Collect', name: 'Pilot LTL', mode: 'LTL' },
  page: 13,
  section: '9.1',
}

/** The freight term for a SCAC, or null when the guide does not name that carrier. */
export function freightTermsFor(scac) {
  const e = FREIGHT_TERMS[String(scac ?? '').trim().toUpperCase()]
  return e && e.terms ? e : null
}

/**
 * When a PO may ship — §5.1, p7.
 *
 * ⚠️ THE INDC DATE IS AN ARRIVAL DATE, NOT A SHIP DATE: "The INDC date on your purchase
 * order is when the goods are expected to ARRIVE at the Macy's/Bloomingdales warehouse."
 * Reading it as a ship date is a week to a fortnight of error in the wrong direction.
 */
export const DEADLINES = {
  rtsBeforeIndcDays: [7, 14],
  entryBeforeRtsDays: 3,
  entryBeforeCancelDays: 3,
  ltlPickupWithinBusinessHours: 48,
  containerRequestBeforeRtsDays: [3, 14],
  newShippingLocationNoticeDays: 30,
  changesCutoff: '7:00 PM Eastern on the original entry date — after that only the BOL number can be updated (p9, §7.3)',
  page: 7,
  section: '5.1',
  indcIsArrival: true,
}

/**
 * ⚠️ LTL TOLERATES NO VARIANCE AT ALL — §7.3, p9-10.
 *
 * Truckload gets ±49 cartons, ±1,499 lb, ±249 cubic feet. Small parcel gets ±99 lb.
 * LTL gets: "No shipment alterations tolerated. Shipment information which has been
 * entered into MacysNet must match the Bill of Lading tendered to the carrier."
 *
 * That is the single most surprising line in the guide for us, because every
 * Bloomingdale's shipment we route is LTL and the app's carton counts move whenever a
 * fulfilment is re-packed.
 */
export const VARIANCE = {
  TL: { cartons: 49, weightLb: 1499, cubicFeet: 249 },
  IM: { cartons: 49, weightLb: 1499, cubicFeet: 249 },
  LTL: { cartons: 0, weightLb: 0, cubicFeet: 0, note: 'no alterations tolerated; MacysNet must match the BOL' },
  PARCEL: { weightLb: 99 },
  page: 9,
  section: '7.3',
}

/** Does a re-count still fit the tolerance for this mode? */
export function withinVariance(mode, { cartons = 0, weightLb = 0, cubicFeet = 0 } = {}) {
  const v = VARIANCE[String(mode ?? '').toUpperCase()]
  if (!v) return { known: false, why: `no variance recorded for mode "${mode}"` }
  const over = []
  if (v.cartons != null && Math.abs(cartons) > v.cartons) over.push(`${cartons} cartons against a tolerance of ${v.cartons}`)
  if (v.weightLb != null && Math.abs(weightLb) > v.weightLb) over.push(`${weightLb} lb against a tolerance of ${v.weightLb}`)
  if (v.cubicFeet != null && Math.abs(cubicFeet) > v.cubicFeet) over.push(`${cubicFeet} cu ft against a tolerance of ${v.cubicFeet}`)
  return { known: true, ok: over.length === 0, over, tolerance: v, page: VARIANCE.page }
}

/**
 * §7.7, p11 — the cube calculation MTO uses to pick the mode.
 *
 * ⚠️ THE PER-CARTON FIGURE IS ROUNDED TO TWO PLACES BEFORE IT IS MULTIPLIED, and that
 * is not a presentation choice — it is how the guide's own worked example arrives at its
 * totals. 25x21x25 is 7.5955 cube exactly; the guide writes "7.60 cube per carton =
 * 1,140 cube" for 150 cartons. Full precision gives 1,139.32.
 *
 * It matters because §12.1 charges $50 per freight bill PLUS FULL FREIGHT for
 * "inaccurate carton, cube and/or weight entered in the MacysNet shipment request". The
 * number we enter should be the number their method produces, not a more precise one
 * that disagrees with it.
 *
 * Checked against all three rows of the example: 1,140 / 625 / 118.
 */
export function cubeFor(cartons = []) {
  let total = 0
  for (const c of cartons) {
    const l = Number(c.length) || 0, w = Number(c.width) || 0, h = Number(c.height) || 0
    const n = Number(c.count ?? 1) || 0
    // ⚠️ A carton with no dimensions is SKIPPED rather than counted as zero volume — a
    // shipment whose cube quietly excludes a box is the inaccurate-cube offset.
    if (!l || !w || !h) continue
    const perCarton = Math.round(((l * w * h) / 1728) * 100) / 100
    total += perCarton * n
  }
  return Math.round(total * 100) / 100
}

/** The per-carton cube as the guide writes it — rounded to two places. */
export const cubePerCarton = (l, w, h) => Math.round(((l * w * h) / 1728) * 100) / 100

/** §11.0, p13-14 — pallets. */
export const PALLET = {
  grade: 'GMA Grade A (#1) only — Grade B and Grade C are unacceptable',
  sizeIn: [40, 48],
  entry: '4-way',
  maxHeightIn: 96,
  shrinkWrapped: true,
  overhangAllowed: false,
  doubleStack: false,
  palletsOnlyWhen: 'LTL transit mode, and only when MTO authorised it',
  maxPallets: { FXFE: 8, FXNL: 8, other: 10 },
  weightOnBol: 'the pallet weight must show as a separate line item in the Carrier Information field of the BOL',
  unauthorisedUse: { amount: 500, per: 'occurrence', what: 'pallets used when assigned a trailerload or intermodal appointment' },
  doubleStacked: { amount: 500, per: 'occurrence' },
  page: 13,
  section: '11.0',
}

/** §8.0, p11 — seals. */
export const SEALS = {
  requiredFor: 'all non-LTL shipments',
  type: 'bolt seals only — tin or plastic are unacceptable',
  appliedBy: 'the vendor; seals cannot be provided to the driver to seal the load',
  loggedOn: 'the Bill of Lading',
  multiStop: 'record BOTH the seal removed and the new seal applied',
  page: 11,
  section: '8.0',
}

/** §9.0, p11-12 — what must be true of the BOL itself. */
export const BOL_RULES = [
  { rule: 'Every BOL has a unique number, transmitted on the EDI 856, and the shipment info must exactly match the 856', page: 11 },
  { rule: "Macy's and Bloomingdale's divisions shipping one day from one location to a single final destination DC must be combined onto ONE BOL", page: 12 },
  { rule: 'Every PO in the shipment is noted in the body of the BOL with ALL PO numbers, TOTAL carton count and the weight for each PO', page: 12 },
  { rule: 'The authorization/appointment number from MacysNet must appear in the "Special Instructions" box', page: 12 },
  { rule: 'Do NOT add an expected delivery date or declare value on the BOL', page: 12 },
  { rule: 'The GS1-128 label should reflect the BOL when the BOL is available', page: 12 },
  { rule: 'Freight terms must be clearly noted on each BOL, along with the trailer and seal number', page: 12 },
  { rule: 'Printed BOLs wherever possible; a handwritten bill must be legible and free of whiteout or strikeouts', page: 12 },
  // ⚠️ The master BOL's number is deliberately NOT on the 856 — the underlying per-DC
  // BOL numbers are. Getting that backwards breaks the ASN for every DC in the load.
  { rule: 'A Master BOL is required when one authorization covers multiple final destination DCs via the 1:1 Merge Center network, and its number is NOT transmitted on the EDI 856', page: 11 },
]

/** §13.1, p18 — the three 1:1 Merge Centers, verbatim. */
export const MERGE_CENTERS = {
  CA: { label: 'Mega-Merge CA', street: '12801 Excelsior Drive', city: 'Santa Fe Springs', state: 'CA', zip: '90670' },
  NC: { label: 'High Point 1:1 Merge Center c/o Dynamic', street: '1124 Elon Place', city: 'High Point', state: 'NC', zip: '27260' },
  NJ: { label: 'Mega-Merge NJ', street: '270 Daniels Way', city: 'Burlington', state: 'NJ', zip: '08016' },
  page: 18,
}

/**
 * §12.1, p15-16 — TRANSPORTATION expense offsets.
 *
 * ⚠️ A DIFFERENT SCHEDULE FROM APPENDIX H. macysStandards.js holds the merchandise-side
 * offsets; these are the freight-side ones, and several are "$50 per freight bill PLUS
 * VENDOR PAYS FULL FREIGHT" — where the freight is the larger half and is not a number
 * this file can know.
 */
export const TRANSPORT_OFFSETS = {
  noEdi214: { what: 'Vendor failed to provide required information to carrier for EDI 214', amount: 50, per: 'freight bill' },
  noEdi240: { what: 'Vendor failed to provide package level detail for EDI 240', amount: 50, per: 'package' },
  unauthorizedCarrier: { what: "Used a carrier not authorized by Macy's Transportation", amount: 50, per: 'freight bill', plusFullFreight: true },
  inaccurateEntry: { what: 'Inaccurate carton, cube and/or weight entered in the MacysNet shipment request', amount: 50, per: 'freight bill', plusFullFreight: true },
  unauthorizedPallets: { what: 'Pallets used when assigned a trailerload or intermodal appointment', amount: 500, per: 'occurrence' },
  doubleStackedPallets: { what: 'Double-stacked pallets when authorised to ship on pallets', amount: 500, per: 'occurrence' },
  airWithoutAuth: { what: 'Shipped air freight without MTO authorization', amount: 50, per: 'freight bill', plusFullFreight: true },
  duplicateRts: { what: 'Multiple shipment requests with a Ready to Ship date of the same or consecutive days, same origin to same destination', amount: 50, per: 'freight bill', plusFullFreight: true },
  ltlPickupNotScheduled: { what: 'Did not contact the LTL carrier to schedule pickup within 48 business hours of the assigned pickup date', amount: 50, per: 'freight bill', plusFullFreight: true },
  splitShipments: { what: 'Multiple shipments to the same final destination DC for the same purchase order', amount: 50, per: 'freight bill', plusFullFreight: true, exception: 'volume loads requiring multiple trailers' },
  inaccurateBol: { what: 'Inaccurate Bill of Lading, including not using a Master BOL when applicable', amount: 50, per: 'freight bill', plusFullFreight: true },
  notReadyDetention: { what: 'Detention — shipment not ready at the designated day/time', amount: 50, per: 'freight bill', plusCarrierFee: true, freeTime: 'LTL excludes the first hour; truckload live load excludes the first two; drop trailer has NO free time' },
  accessorials: { what: 'Carrier-assessed unauthorized additional services (driver assist, layover, liftgate, redelivery, out-of-hours pickup, deadhead, team drivers, temperature control)', amount: 50, per: 'freight bill', plusCarrierFee: true },
  page: 15,
  section: '12.1',
}

/**
 * ⚠️ "ALL ORDERS ARE EXPECTED TO SHIP COMPLETE. Backorders are subject to expense
 * offsets and freight charges." (p16, under the offsets table.)
 *
 * This is the routing guide's own statement of the thing macysStandards prices at
 * $50/receipt + 50% of the merchandise + $1/unit collateral (Appendix H, p58). Recorded
 * here because a reader in the routing guide should not have to already know that.
 */
export const SHIP_COMPLETE = {
  rule: 'All orders are expected to ship complete. Backorders are subject to expense offsets and freight charges.',
  pricedIn: 'macysStandards.js OFFSETS.poNoncompliance — Vendor Standards Appendix H, p58',
  page: 16,
}

/** §12.2, p17 — who counts and loads. */
export const DRIVER_COUNT = {
  rule: 'The vendor counts and loads ALL cartons. Drivers are not authorized to assist in loading or counting, and every shipment is a "shipper count" regardless of what the BOL says.',
  palletisedException: 'For authorised palletised freight the driver counts PALLETS only and signs the BOL as pallet count and STC (said to contain) cartons — e.g. "5 pallets STC 150 cartons".',
  page: 17,
  section: '12.2',
}

/** §6.2, p8 — who schedules the LTL pickup depends on the carrier. */
export const LTL_PICKUP = {
  FXFE: 'the vendor contacts FedEx Freight to schedule — local terminal or 866-393-4585',
  FXNL: 'the vendor contacts FedEx Freight to schedule — local terminal or 866-393-4585',
  XLTL: 'the vendor initiates the pickup; see the key information section of the routing notification email',
  RDWY: 'the vendor initiates the pickup; see the key information section of the routing notification email',
  default: 'the designated carrier schedules the pickup from the routing notification email',
  withinBusinessHours: 48,
  page: 8,
  section: '6.2',
}

export function ltlPickupActionFor(scac) {
  const k = String(scac ?? '').trim().toUpperCase()
  return { scac: k || null, action: LTL_PICKUP[k] || LTL_PICKUP.default, page: LTL_PICKUP.page }
}
