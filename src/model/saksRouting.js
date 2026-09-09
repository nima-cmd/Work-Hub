// src/model/saksRouting.js — the Saks Global routing rules, as data.
//
// Nima, 2026-09-09: "it also be nice to have these rules saved in the app for
// reference as well."
//
// Source: "Saks Global US Routing Guide", Revision 11, last updated 2026-06-01,
// covering Saks.com, Saks Fifth Avenue stores, Neiman Marcus and Bergdorf Goodman;
// plus the Exemplar Luxury Group Vendor Standards Manual §8.5 and §9. Every rule
// below carries the page it came from, so it can be re-checked when a revision
// lands — and Revision 11 replaced whatever we were working from before.
//
// ⚠️ RULES WITH A CITATION, NOT REMEMBERED RULES. The expensive failures in this
// repo have all been a confident number nobody could trace. A routing guide is
// re-issued without notice ("It is the responsibility of each vendor to regularly
// monitor this site"), so a rule the app asserts must say where it came from and
// when, or the app becomes a second stale source alongside everyone's memory.
//
// ⚠️ AND THIS FILE DECIDES NOTHING THE TMS DECIDES. Saks route everything through
// Dynamic's TMS and the TMS picks the mode and the carrier. The thresholds here are
// for TELLING SOMEONE WHAT TO EXPECT and for catching an obvious mismatch — never
// for choosing on the TMS's behalf.

export const SOURCE = {
  guide: 'Saks Global US Routing Guide',
  revision: '11',
  updated: '2026-06-01',
  banners: ['Saks Fifth Avenue', 'Saks.com', 'Neiman Marcus', 'Bergdorf Goodman'],
  standardsManual: 'Exemplar Luxury Group Vendor Standards Manual',
}

/**
 * The distribution centres, by the code that appears in the 850's ship-to.
 *
 * ⚠️ THE CODE IS ZERO-PADDED IN EDI AND BARE IN THE GUIDE. PO 0008928906 carries
 * ship-to `0510`; the guide's table says `510`. Looked up either way here, because a
 * lookup that misses returns "unknown DC" and someone types an address by hand.
 */
export const DCS = {
  510: {
    code: '510', name: 'NMG-Pinnacle Point', abbrev: 'PNDC',
    address: ['4123 Pinnacle Point Dr', 'Dallas, TX 75211'],
    // ⚠️ Jewellery goes to Suite J at the same address — a different dock, same code.
    jewelleryAddress: ['4123 Pinnacle Point Dr Suite J', 'Dallas, TX 75211'],
    receiving: 'Tue-Fri 6:30 AM - 3:30 PM',
    appointment: 'Conduit (scheduling link in the guide)',
    page: 4,
  },
  577: {
    code: '577', name: 'NMG-West Coast Service Center', abbrev: 'WCSC',
    address: ['2500 Workman Mill Road', 'Whittier, CA 90601'],
    receiving: 'Mon-Fri 3:00 AM - 3:30 PM',
    appointment: 'Email SG-Transportation@saks.com, subject "Delivery Apt Request"',
    page: 4,
  },
  560: {
    code: '560', name: 'NMG-East Coast Service Center', abbrev: 'ECDC',
    address: ['600 Research Dr', 'Pittston, PA 18640'],
    receiving: 'Mon-Fri 7 AM - 3:30 PM',
    appointment: 'Conduit',
    page: 4,
    note: 'Also the Bergdorf Goodman DC.',
  },
  517: {
    code: '517', name: 'SFA West Coast Service Center', abbrev: 'WCSC',
    address: ['2500 Workman Mill Road', 'Whittier, CA 90601'],
    receiving: 'Mon-Fri 10:00 AM - 5:00 PM',
    // ⚠️ The only DC that says delivery is REFUSED without a TMS routing, in writing.
    appointment: 'No appointment needed IF the PO is routed in Dynamic TMS — delivery is REJECTED if it is not',
    page: 5,
  },
  '072': {
    code: '072', name: 'NMG-Thomasville DC', abbrev: 'WH4',
    address: ['115 Morrison Ave', 'Thomasville, NC 27360'],
    receiving: 'Mon-Fri 7:30 AM - 3:30 PM',
    appointment: 'Email NMtickets@sun-wd.com',
    page: 5,
    // ⚠️ NCDC bypasses the TMS entirely — keyed as a special order (guide p18).
    note: 'POs for NCDC (Store 072 / DC 550) ship direct without the TMS or DTS approval.',
  },
  694: {
    code: '694', name: 'Saks Photo Studio', abbrev: 'Photo',
    address: ['250 Vesey Street - 22nd Floor', 'New York, NY 10281'],
    receiving: 'Mon-Fri 9:00 AM - 5:00 PM',
    appointment: 'None — samples are DTS and skip the TMS',
    page: 5,
  },
}

export const dcFor = (code) => DCS[String(code ?? '').replace(/^0+/, '')] ?? DCS[String(code ?? '')] ?? null

/**
 * Shipping mode thresholds (guide p6).
 *
 * ⚠️ THESE TWO DEFINITIONS LEAVE A GAP, AND A REAL SHIPMENT LANDED IN IT. Small
 * Parcel is "up to 15 cartons AND less than 150 lbs"; LTL is "more than 15 cartons
 * AND more than 150 lbs". IF7650 is 11 cartons at 266 lb — under the carton ceiling
 * and far over the weight one, so it satisfies NEITHER definition. Guessing costs the
 * full freight plus $75 per package, so `modeFor` returns `'ask-tms'` rather than
 * picking, and the guide backs that: "The TMS will instruct the vendor whether to
 * ship a small parcel, LTL, or TL based on the shipment size and weight."
 */
export const MODE_LIMITS = {
  parcel: { maxCartons: 15, maxWeightLb: 150, page: 6 },
  ltl: { minCartons: 15, minWeightLb: 150, page: 6 },
  tl: { minWeightLb: 8000, minPallets: 8, minCubicFeet: 749, page: 6 },
  parcelCarton: { maxLongestIn: 108, maxChainIn: 165, maxWeightLb: 50, page: 7 },
}

export function modeFor({ cartons, weightLb, pallets, cubicFeet } = {}) {
  const c = Number(cartons) || 0
  const w = Number(weightLb) || 0
  const t = MODE_LIMITS.tl
  if (w >= t.minWeightLb || Number(pallets) > t.minPallets || Number(cubicFeet) > t.minCubicFeet) {
    return { mode: 'TL', certain: true, reason: 'over 8,000 lb, 8 pallets or 749 cubic feet' }
  }
  if (c <= MODE_LIMITS.parcel.maxCartons && w < MODE_LIMITS.parcel.maxWeightLb) {
    return { mode: 'parcel', certain: true, reason: `${c} cartons and ${w} lb is inside 15 / 150` }
  }
  if (c > MODE_LIMITS.ltl.minCartons && w > MODE_LIMITS.ltl.minWeightLb) {
    return { mode: 'LTL', certain: true, reason: `${c} cartons and ${w} lb is over 15 / 150` }
  }
  return {
    mode: 'ask-tms', certain: false,
    reason: `${c} cartons at ${w} lb matches NEITHER definition — parcel needs <150 lb, LTL needs >15 cartons. The TMS decides; do not assume parcel because the carton count is low.`,
  }
}

/**
 * Every field the guide requires on the BOL (p13), in its own words.
 *
 * ⚠️ THE TMS CONFIRMATION NUMBER APPEARS TWICE ON THEIR SAMPLE BOL — in `CID#` and
 * again in SPECIAL INSTRUCTIONS (Appendix A, p23, both circled in red). Our VICS BOL
 * already has both boxes; what it has never had is the number to put in them, and
 * that number does not exist until the shipment is routed.
 */
export const BOL_FIELDS = [
  { field: 'BOL number', source: 'we generate it', note: 'unique, never reused' },
  { field: 'TMS confirmation number', source: 'Dynamic TMS', required: true, placement: 'CID# AND Special Instructions', page: 23 },
  { field: 'Carrier SCAC', source: 'Dynamic TMS' },
  { field: 'Carrier name', source: 'Dynamic TMS' },
  { field: 'Shipper name and address', source: 'us' },
  { field: 'Consignee name and address', source: 'the DC table above' },
  { field: 'Location Authorization Number', source: 'Saks', note: 'if applicable' },
  { field: 'Date of shipment (picked up by carrier)', source: 'the TMS ready date' },
  { field: 'Department number', source: "the 850's REF*DP*", note: 'PO 0008928906 is dept 0118' },
  { field: 'PO numbers', source: 'the 850' },
  { field: 'Carton count BY PO', source: 'the floor', note: 'per PO, not just the grand total' },
  { field: 'Weight BY PO', source: 'the floor', note: 'per PO, not just the grand total' },
  { field: 'Pallet / slip indicator (Y/N)', source: 'the floor', note: 'must be INDICATED — a printed "Y  N" is not an answer' },
  { field: 'Freight charge term', source: 'the buying office', note: 'Collect or Prepaid — established at onboarding, and Logistics will not advise' },
  { field: 'Freight class', source: 'computed from density', note: 'weight / cubic feet; the vendor is liable for getting it wrong', page: 24 },
  { field: 'Bolt seal number', source: 'the floor', note: 'FTL only — no seal or no number ON the BOL means rejection at pickup', page: 11 },
]

/**
 * ⚠️ WHETHER A PACKING SLIP IS NEEDED TURNS ON WHETHER THE ASN ACTUALLY GOES OUT —
 * not on whether we call ourselves EDI-capable.
 *
 * The guide (p13): "Vendors who are EDI Compliant do not need to submit packing
 * lists, as your Advance Ship Notice (ASN) serves as your packing list." The
 * standards manual §8.5 says the same from the other side: an EDI supplier receiving
 * POs electronically is NOT required to include packing slips.
 *
 * We receive Saks 850s electronically — 15 of them, newest 2026-09-03. By that test
 * we are EDI compliant. But the last 856 we delivered to the Saks partner was
 * 2024-11-01, and to NMG 2025-02-26 with 9 still PENDING. If no ASN is transmitted
 * for a shipment then that shipment IS a non-ASN shipment whatever our capability,
 * §8.5 applies, and it carries an expense offset fee.
 *
 * So this returns the question, not a comfortable answer.
 */
export function documentsRequired({ asnWillBeSent } = {}) {
  const manifest = {
    required: true,
    // ⚠️ REQUIRED FOR ALL SHIPMENTS — this is the one that does not depend on EDI at
    // all, and the one we do not currently produce.
    why: 'Guide p13: "Master Manifest & Packing List — Required for all shipments. Must provide the manifest to the carrier at pick-up."',
    perBanner: 'One manifest per banner, each labelled with the banner name and ship-to DC',
    mustContain: ['store numbers', 'carton counts', 'PO numbers', 'banner name', 'ship-to DC'],
    page: 13,
  }
  const masterBol = {
    required: true,
    why: 'One Master BOL covers the entire shipment for a single DC, however many banners, and must reference each banner manifest.',
    page: 12,
  }
  if (asnWillBeSent === true) {
    return { manifest, masterBol, packingSlip: { required: false, why: 'The ASN serves as the packing list for EDI-compliant vendors (guide p13).' } }
  }
  if (asnWillBeSent === false) {
    return {
      manifest, masterBol,
      packingSlip: {
        required: true,
        why: 'No ASN means this is a non-ASN shipment (standards manual §8.5), which carries an expense offset fee.',
        rules: [
          'One packing slip PER PURCHASE ORDER per store',
          'Emailed IN ADVANCE to the DC contact office',
          'In a removable pouch attached to the carton',
          '"PACKING SLIP ATTACHED" on all six sides of that carton',
          'Cartons packed by store for store POs; by SKU for digital POs',
          'A carton label carrying store number, PO number and department',
          'Non-trailer shipments: the packing list AND a copy of the unsigned BOL in a pouch, one per PO',
        ],
      },
    }
  }
  return {
    manifest, masterBol,
    packingSlip: {
      required: null,
      why: 'Unknown until someone says whether an 856 will actually be transmitted for this shipment. '
         + 'We receive their 850s, but the last 856 delivered to the Saks partner was 2024-11-01.',
    },
  }
}

/** Deadlines, and the ones that are already measurable from an 850. */
export const DEADLINES = {
  tmsRouting: { businessDaysBeforeCancel: 3, page: 7, rule: 'All truck shipments must be routed through the TMS at least three business days prior to the cancel date.' },
  asn: { hoursBeforeArrival: [24, 48], page: 14, rule: 'The 856 must be transmitted 24-48 hours prior to arrival at the receiving location.' },
  leadTime: { averageBusinessDays: 5, page: 18, tiers: { 1: '1-2 local/adjacent', 2: '2-3 nearby', 3: '3-4 central or southeast', 4: '4-5 west coast, upper midwest, northeast, mountain', 5: '5-7+ remote (AK, HI)' } },
}

/**
 * The prohibitions. Each one is a chargeback, and the first is one only WE can catch.
 *
 * ⚠️ WE MINT THE BOL NUMBERS, so the app is the only system that can see two BOLs
 * heading for the same destination on the same or consecutive business days before
 * they are printed. Nothing at Saks tells us; it arrives as a freight chargeback.
 */
export const PROHIBITED = [
  { rule: 'Multiple BOLs to the same destination on the same or consecutive business days', consequence: 'freight chargeback', page: 6, appCanCatch: true },
  { rule: 'Separating pallets by banner or by PO instead of by shipping destination', consequence: 'non-compliance chargeback', page: 15, appCanCatch: false },
  { rule: 'Mixing cartons for different servicing DCs in one shipment', consequence: 'non-compliance chargeback', page: 15, appCanCatch: true },
  { rule: 'Floor-loaded trailers — all truck deliveries must be palletised', consequence: 'refused at the DC', page: 10, appCanCatch: false },
  { rule: 'Double-stacked pallets for SFA, Saks.com, Neiman Marcus or Bergdorf Goodman', consequence: 'non-compliance', page: 10, appCanCatch: false },
  { rule: 'Shipping air or direct-to-store without written Store Ops approval and an authorization number on the air bill', consequence: 'full freight cost plus a penalty of at least $75', page: 18, appCanCatch: true },
  { rule: 'Small parcel orders shipped on Saks’ freight account instead of ours', consequence: 'full freight chargeback plus $75 per package', page: 8, appCanCatch: false },
]

export const PALLET = { sizeIn: [40, 48], maxHeightIn: 72, shrinkWrapTurns: 3, doubleStack: false, page: 10 }

/**
 * ⚠️ THE AUDIT PROGRAM IS WHY A MISSING CARTON IS NOT A SMALL PROBLEM. §9.1: an item
 * error rate of 2% or higher puts us on the Vendor Audit Program at $1,000 per month
 * for a minimum of three months, and it takes three consecutive months at 99.5%
 * accuracy to get off. The audit compares the ASN (or packing slip) against the
 * GS1-128 label at store/style/colour/size/quantity level against the PHYSICAL units.
 *
 * IF7650 currently declares 11 cartons and has 10.
 */
export const AUDIT = {
  itemErrorRateTrigger: 0.02,
  feePerMonth: 1000,
  minimumMonths: 3,
  exitRequirement: 'three consecutive receipt months at 99.5% error-free',
  page: '§9.1',
  basis: 'ASN or packing slip vs the GS1-128 label vs the physical units, at store/style/colour/size/quantity level',
}

export const CONTACTS = {
  shippingAndRouting: 'sg-transportation@saks.com',
  compliance: 'compliance@saks.com',
  chargebacks: 'compliance@saks.com',
  edi: 'edi@saks.com',
  tms: 'csrsupport@dynamiconline.com',
  directToStoreApproval: ['kristan.rodriguez@saks.com', 'Silvia.Arnold@saks.com'],
  chargebackDisputeWindowDays: 60,
  chargebackSystem: 'QLogitek IMS',
}

/**
 * Run a shipment against the rules and report what is missing or wrong.
 *
 * ⚠️ IT REPORTS, IT DOES NOT DECIDE. Every finding names the rule and its page so it
 * can be argued with — including against a newer revision of the guide than the one
 * this file was written from.
 */
export function checkSaksShipment(s = {}, { today = new Date() } = {}) {
  const findings = []
  const add = (severity, what, detail, page) => findings.push({ severity, what, detail, page })

  const dc = dcFor(s.dcCode)
  if (!dc) add('blocking', 'Unknown DC', `Ship-to "${s.dcCode}" is not one of ${Object.keys(DCS).join(', ')} — do not type an address by hand.`, 4)

  if (!s.tmsConfirmation) {
    add('blocking', 'No TMS confirmation number',
      'The BOL cannot be completed without it; it belongs in CID# and Special Instructions. Route the shipment in Dynamic TMS first.', 23)
  }
  if (!s.freightTerms) {
    add('blocking', 'Freight terms unknown',
      'Collect or Prepaid changes the BOL, who books the delivery appointment, and whether chargeback code 905 applies. Established at onboarding by the buying office — Logistics will not advise.', 6)
  }

  if (s.cancelAfter) {
    const due = businessDaysBefore(s.cancelAfter, DEADLINES.tmsRouting.businessDaysBeforeCancel)
    const now = isoDay(today)
    if (!s.tmsConfirmation && due && now && now > due) {
      add('blocking', 'Past the TMS routing deadline',
        `Cancel date ${isoDay(s.cancelAfter) ?? s.cancelAfter} required routing by ${due} (3 business days prior). Today is ${now}.`,
        DEADLINES.tmsRouting.page)
    }
  }

  const m = modeFor(s)
  if (!m.certain) add('warn', 'Shipping mode is ambiguous', m.reason, MODE_LIMITS.parcel.page)

  if (s.cartonsDeclared != null && s.cartonsActual != null && s.cartonsDeclared !== s.cartonsActual) {
    add('blocking', 'Carton count does not match',
      `The shipment declares ${s.cartonsDeclared} cartons and ${s.cartonsActual} exist. The Vendor Audit Program compares the ASN against the physical units; a 2% item error rate costs $${AUDIT.feePerMonth}/month for at least ${AUDIT.minimumMonths} months.`,
      AUDIT.page)
  }

  if (m.mode === 'TL' && !s.sealNumber) {
    add('blocking', 'No bolt seal number',
      'A full truckload going direct to a Saks DC must be sealed and the seal number written on the BOL, or it is rejected at the point of pickup.', 11)
  }
  if (s.palletIndicator == null) {
    add('warn', 'Pallet / slip indicator not set', 'The BOL requires Y or N to be indicated, not both printed.', 13)
  }

  return {
    dc,
    mode: m,
    findings,
    blocking: findings.filter((f) => f.severity === 'blocking'),
    source: SOURCE,
  }
}

/**
 * ⚠️ RETURNS NULL ON A BAD DATE RATHER THAN THROWING. This is called on
 * `cancelAfter`, which arrives from an 850 — so a malformed one would have taken the
 * whole shipment check down instead of reporting one unusable field. Found by the
 * test that asked for the null.
 */
const isoDay = (d) => {
  const x = d instanceof Date ? d : new Date(`${String(d ?? '').slice(0, 10)}T00:00:00Z`)
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10)
}

/**
 * N business days before a date, skipping weekends.
 *
 * ⚠️ HOLIDAYS ARE NOT KNOWN HERE, so this can only ever be the OPTIMISTIC deadline.
 * Said plainly rather than silently: a guide that says "three business days" over a
 * holiday week means an earlier date than this returns, never a later one.
 */
export function businessDaysBefore(date, n) {
  const iso = isoDay(date)
  if (!iso) return null
  const d = new Date(`${iso}T00:00:00Z`)
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1)
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) left--
  }
  return d.toISOString().slice(0, 10)
}
