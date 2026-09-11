// src/model/macysStandards.js — Macy's / Bloomingdale's expense offsets, as data.
//
// Nima asked what a short ship costs with Bloomingdale's the same day four orders
// went out short on PO 1236143. The answer was in a document sitting unread in Drive.
//
// Source: "Macy's 2023 Vendor Standards", Appendix H — Expense Offsets, pages 57-60.
// Bloomingdale's is a Macy's division (see src/model/bolAddresses.js) and this
// document governs both.
//
// ── ⚠️ THEY ARE NOT CALLED CHARGEBACKS, AND THAT IS WHY NOBODY FOUND THEM ───
//
// Macy's term is EXPENSE OFFSET. Searching this document for "chargeback" finds the
// word only in passing references to the Macysnet portal; the schedule itself never
// uses it. A search for the word everyone says out loud misses the section that
// prices everything.
//
// ── ⚠️ A SHORTAGE IS PRICED ON THE GOODS, NOT AS A FLAT FEE ─────────────────
//
// This is the difference that matters, and it is not the shape Exemplar's schedule
// has. Exemplar charges $500 per incident for a short ship (§12.3). Macy's charges:
//
//   "$50.00 per receipt and 50% cost of merchandise; $1.00 per unit for collateral"
//
// Fifty per cent of the merchandise. On a partner whose orders are split across 24
// stores, a shortage in one SKU is not a $500 problem — it scales with what was not
// shipped. Assuming Exemplar's numbers here would understate it by an order of
// magnitude.
//
// ⚠️ AND THE SAME LINE COVERS SUBSTITUTIONS AND OVERAGES. "Noncompliance to purchase
// order U.P.C./GTIN/EAN and store distribution (i.e., substitutions, shortages, and
// overages by store)" is ONE offset covering all three — so the SN41262/SN41263
// substitution found on the Exemplar order would be priced the same way here.

export const SOURCE = {
  document: "Macy's 2023 Vendor Standards",
  appendix: 'H — Expense Offsets',
  pages: '57-60',
  covers: ["Macy's", "Bloomingdale's", "Bloomingdale's Outlet"],
  documentKey: 'bloomingdales-vendor-standards',
  // ⚠️ THE EDITION IS 2023 AND THE ROUTING GUIDE IN THIS REPO CITES "rev 4/14/26".
  // A three-year-old standards document alongside a current routing guide is exactly
  // the case partnerDocuments.js's review cadence exists for — confirm this is still
  // the live edition before quoting a figure back to anyone.
  edition: '2023',
  verifyBeforeQuoting: true,
  portal: 'Macysnet.com — the Expense Offset and Invoice Chargeback Descriptions document needs a sign-on',
}

/**
 * Appendix H, verbatim. `per` names what each amount multiplies.
 *
 * ⚠️ MOST LINES ARE A RECEIPT FEE **AND** A PER-UNIT OR PER-CARTON AMOUNT, not one or
 * the other. Reading only the left-hand number understates almost every line here —
 * the same trap as Exemplar's minimum-charge column.
 */
export const OFFSETS = {
  // ── Technology ──
  gs1Unusable: {
    category: 'GS1 128', section: 'H',
    what: 'No or unusable label — label quality, or missing pack-level data in the EDI856',
    perCarton: 8.5,
  },
  gs1Placement: {
    category: 'GS1 128', section: 'H',
    what: 'Incorrect location on carton, incorrect format, or missing human-readable division/PO/store',
    perCarton: 5, minPerReceipt: 50,
  },
  gs1FobDept: {
    category: 'GS1 128', section: 'H',
    what: 'No or wrong FOB and/or department',
    perReceipt: 50, perCarton: 0.75,
  },
  asnMissing: {
    category: 'EDI856', section: 'H',
    what: 'No, unusable or inaccurate EDI856 at time of merchandise processing; not in production for EDI856',
    perCarton: 8.5, minPerReceipt: 100,
  },
  asnLate: {
    category: 'EDI856', section: 'H',
    what: 'Late EDI856, or failure to consolidate stores for the same PO/shipment on one BOL/EDI856',
    perReceipt: 100,
  },
  invoiceEdi: {
    category: 'EDI810', section: 'H',
    what: 'Not in production for EDI810; inaccurate/missing BOL; multiple invoices for the same store/PO/BOL',
    perInvoice: 10,
  },

  // ── Distribution Centre ──
  wrongLocation: {
    category: 'Shipping', section: 'H',
    what: 'Merchandise shipped to the wrong location',
    perReceipt: 250, perCarton: 10, plusFreight: true,
  },
  /**
   * ⚠️ THE ONE THAT PRICES TODAY'S SHORT SHIPMENTS, AND IT IS A PERCENTAGE.
   */
  poNoncompliance: {
    category: 'Shipping', section: 'H',
    what: 'Noncompliance to purchase order U.P.C./GTIN/EAN and store distribution (i.e., substitutions, shortages, and overages by store). May include concealed inaccuracies in the EDI856.',
    perReceipt: 50,
    pctOfMerchandise: 0.5,
    perUnitCollateral: 1,
    covers: ['shortage', 'substitution', 'overage'],
  },
  masterPack: {
    category: 'Master pack', section: 'H',
    what: 'Outer cartons not labelled master pack; missing or inaccurate GS1 128 on inner cartons',
    perReceipt: 5, perInnerCarton: 0.5,
  },
  integrityAudit: {
    category: 'Integrity Audit', section: 'H',
    what: 'Removal from the cross-dock programme (i.e. 100% audit)',
    perReceipt: 50, perUnit: 1,
    // ⚠️ PO 1236143 IS XDOCK. Losing cross-dock is not a one-off fee — it changes how
    // every future shipment is received, and it is priced per unit.
    note: 'Cross-dock removal applies per receipt AND per unit, on every shipment thereafter.',
  },

  // ── Store floor ready (a sample — the full list is pages 58-59) ──
  ticketing: {
    category: 'U.P.C./Ticketing', section: 'H',
    what: 'Missing, wrong or poor-quality U.P.C. ticket; ticket affixed improperly; missing or inaccurate retail',
    perReceipt: 50, perUnit: 0.75, minPerReceipt: 50,
  },
  hanger: {
    category: 'Hanger', section: 'H',
    what: 'Missing or incorrect hanger, or hangers seeded in the box rather than in the garment',
    perReceipt: 50, perUnit: 0.75, minPerReceipt: 50,
  },
}

/**
 * ⚠️ A RATE ROSE AND THE DOCUMENT SAYS SO ON ITS FIRST PAGE. "Effective July 1, 2023,
 * certain expense offsets increase from .60/unit to .75/unit." Recorded because a
 * figure quoted from an older copy of this same document would be 20% light.
 */
export const RATE_CHANGES = [
  { effective: '2023-07-01', from: 0.60, to: 0.75, applies: 'certain per-unit expense offsets' },
]

/**
 * What a non-compliant receipt is likely to cost.
 *
 * @param key            an OFFSETS key
 * @param merchandiseUsd the cost of the NON-COMPLIANT merchandise, for percentage lines
 *
 * ⚠️ IT RETURNS null FOR A PERCENTAGE LINE WITH NO VALUE GIVEN, never zero. "50% cost
 * of merchandise" with the merchandise unknown is an unknown cost, and printing $50
 * (the receipt fee alone) would understate a short ship by whatever the goods are
 * worth — which on the live case is most of the number.
 */
export function offsetFor(key, { receipts = 1, cartons = 0, units = 0, invoices = 0, merchandiseUsd = null } = {}) {
  const o = OFFSETS[key]
  if (!o) return null
  let total = 0
  const parts = []
  if (o.perReceipt) { total += o.perReceipt * receipts; parts.push(`$${o.perReceipt}/receipt x ${receipts}`) }
  if (o.perCarton) { total += o.perCarton * cartons; parts.push(`$${o.perCarton}/carton x ${cartons}`) }
  if (o.perInnerCarton) { total += o.perInnerCarton * cartons; parts.push(`$${o.perInnerCarton}/inner carton x ${cartons}`) }
  if (o.perUnit) { total += o.perUnit * units; parts.push(`$${o.perUnit}/unit x ${units}`) }
  if (o.perInvoice) { total += o.perInvoice * invoices; parts.push(`$${o.perInvoice}/invoice x ${invoices}`) }
  if (o.minPerReceipt) total = Math.max(total, o.minPerReceipt * receipts)

  if (o.pctOfMerchandise) {
    if (merchandiseUsd == null) {
      return {
        ...o, key, estimate: null, known: total, parts,
        unknown: `plus ${o.pctOfMerchandise * 100}% of the merchandise cost, which was not supplied`,
        note: 'This line is dominated by the percentage. The flat part alone is not the exposure.',
      }
    }
    const pct = o.pctOfMerchandise * merchandiseUsd
    total += pct
    parts.push(`${o.pctOfMerchandise * 100}% of $${merchandiseUsd.toFixed(2)} = $${pct.toFixed(2)}`)
  }
  return { ...o, key, estimate: Math.round(total * 100) / 100, parts, unknown: null }
}

/**
 * ⚠️ EXEMPLAR'S NUMBERS DO NOT TRANSFER, AND THE GAP IS AN ORDER OF MAGNITUDE.
 * Kept as data so the difference is checkable rather than remembered.
 */
export const VS_EXEMPLAR = {
  shortShip: {
    exemplar: { amount: 500, per: 'incident', section: '12.3' },
    macys: { perReceipt: 50, pctOfMerchandise: 0.5, section: 'H' },
    why: 'Exemplar is a flat per-incident fee; Macy\'s is a receipt fee PLUS half the value of the merchandise. On a wholesale-priced handbag order the percentage is almost the whole exposure.',
  },
}
