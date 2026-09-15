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

// ⚠️ THE PAGE, NOT JUST THE APPENDIX. Nima asked where the short-shipping rule actually
// is. It is Appendix H, **page 58**, the second row of the "Distribution Center/MIO
// Expense Offsets" table, category Shipping — verified against the PDF 2026-09-14:
//
//   "Noncompliance to purchase order U.P.C./GTIN/EAN and store distribution (i.e.,
//    substitutions, shortages, and overages by store). This may include concealed
//    inaccuracies in the EDI856 Advance Ship Notice."
//   — $50.00 per receipt and 50% cost of merchandise; $1.00 per unit for collateral
//
// The appendix runs 57-60 and its tables are split by area: p57 Technology, p58
// Distribution Center/MIO and Store Floor Ready, p59 .COM Merchandise Preparation.
export const PAGES = {
  appendix: '57-60',
  technology: 57,
  distributionCentre: 58,
  storeFloorReady: 58,
  comMerchandisePrep: 59,
  shortShip: 58,
}

/**
 * Which page of Appendix H each offset is on, verified against the PDF 2026-09-14.
 *
 * ⚠️ ONE MAP RATHER THAN A `page` ON EACH ENTRY, because the entries were transcribed
 * and the pages were checked separately — keeping them apart makes it obvious that the
 * page is a later, independent verification rather than something that came with the
 * transcription and was never confirmed.
 */
export const OFFSET_PAGES = {
  gs1Unusable: 57, gs1Placement: 57, gs1FobDept: 57,
  asnMissing: 57, asnLate: 57, invoiceEdi: 57,
  wrongLocation: 58, poNoncompliance: 58, masterPack: 58, integrityAudit: 58,
  ticketing: 58, hanger: 58,
}

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
  const base = OFFSETS[key]
  if (!base) return null
  // The page is attached here so every quoted figure can cite one.
  const o = { ...base, page: OFFSET_PAGES[key] ?? null }
  let total = 0
  const parts = []
  if (o.perReceipt) { total += o.perReceipt * receipts; parts.push(`$${o.perReceipt}/receipt x ${receipts}`) }
  if (o.perCarton) { total += o.perCarton * cartons; parts.push(`$${o.perCarton}/carton x ${cartons}`) }
  if (o.perInnerCarton) { total += o.perInnerCarton * cartons; parts.push(`$${o.perInnerCarton}/inner carton x ${cartons}`) }
  if (o.perUnit) { total += o.perUnit * units; parts.push(`$${o.perUnit}/unit x ${units}`) }
  if (o.perInvoice) { total += o.perInvoice * invoices; parts.push(`$${o.perInvoice}/invoice x ${invoices}`) }
  // ⚠️ COLLATERAL WAS STORED AND NEVER ADDED. `poNoncompliance` carries
  // `perUnitCollateral: 1` straight from p58 — "$1.00 per unit for collateral" — and
  // this function simply did not look at it, so every shortage estimate came out short
  // by exactly $1 a unit. On the live Bloomingdale's cut that is $70 missing from a
  // figure quoted to decide whether to ship. A field the calculator ignores is worse
  // than one that was never extracted: it reads as covered.
  if (o.perUnitCollateral) {
    total += o.perUnitCollateral * units
    parts.push(`$${o.perUnitCollateral}/unit collateral x ${units}`)
  }
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
  // ⚠️ "AND FREIGHT" IS UNBOUNDED AND MUST NOT ROUND TO ZERO. p58 charges wrong-location
  // merchandise $250/receipt AND $10/carton AND the freight — and the freight is whatever
  // it cost, which we cannot know here. Reported as an unknown add-on the way the
  // merchandise percentage is, rather than silently omitted from a total that then looks
  // complete.
  if (o.plusFreight) {
    return {
      ...o, key, estimate: Math.round(total * 100) / 100, parts, known: total,
      unknown: 'plus the freight cost itself, which is not known here',
      note: 'The estimate is the fixed part only. The freight on a refused/misrouted shipment is usually the larger half.',
    }
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

/**
 * ⚠️ THE PORTAL, AND IT WANTS SAFARI.
 *
 * Nima, 2026-09-14: "https://macysnet.com is the link to the portal and that needs to be
 * opned in safari if possible." Recorded as HIS instruction, not a browser-compat fact
 * we established — the app surfaces the note so nobody wastes twenty minutes on a
 * portal that half-works in Chrome.
 */
export const PORTAL = {
  name: 'MacysNet',
  url: 'https://macysnet.com',
  urlSource: 'Nima, 2026-09-14',
  browser: 'Safari',
  browserNote: 'Nima: open it in Safari if possible.',
  holds: 'the Expense Offset and Invoice Chargeback Descriptions document, which needs a sign-on — so the fee text below is from the 2023 Vendor Standards PDF, not from the portal.',
}

/**
 * The pre-ship checklist for Macy's and Bloomingdale's.
 *
 * ⚠️ IT IS BUILT FROM THE VENDOR STANDARDS ONLY, AND IT SAYS SO. `partnerDocuments`
 * records four Macy's-side documents and exactly ONE is extracted — this one. The
 * ROUTING GUIDE (`macys-routing`), the Bloomingdale's Routing Guide
 * (`bloomingdales-routing`) and the Store-to-DC listing are all `rulesIn: null`, unread.
 *
 * So this is not the Exemplar checklist's equal and must not look like it. Exemplar's
 * covers routing, packing, labelling, documents, palletising and after-ship because the
 * Routing Guide AND the Manual were both read. This one covers what Appendix H PRICES —
 * which is real and is most of the money — and names the gap rather than implying
 * completeness. A checklist that looks finished is worse than a short one that admits
 * what it has not read.
 *
 * ⚠️ AND THE EDITION IS UNCONFIRMED. SOURCE.verifyBeforeQuoting is true: this is the
 * 2023 Vendor Standards, while the routing guide sitting beside it in Drive is marked
 * rev 4/14/26. Every figure here is quoted with that caveat attached.
 */
export function macysShipmentChecklist({ cartons = 1, receipts = 1, units = 0, merchandiseUsd = null, asnWillBeSent = true } = {}) {
  const money = (key, opts = {}) => {
    const f = offsetFor(key, { cartons, receipts, units, merchandiseUsd, ...opts })
    return f?.estimate != null ? `$${f.estimate.toLocaleString()}` : (f?.unknown || '')
  }
  // ⚠️ NAMESPACED, BECAUSE `gs1-placement` EXISTS IN BOTH CHECKLISTS. Exemplar's is
  // §12.1 at $10/carton with a $250 minimum; this one is Appendix H at $5/carton with a
  // $50 minimum per receipt. Different requirements, different money, same natural name.
  //
  // A shipment is one partner or the other, so today the two could not cross-tick — but
  // that is luck, not design, and `preship_check` rows are keyed on the step alone. A
  // prefix makes the stored row say which checklist it came from and makes the clash
  // impossible rather than merely unlikely.
  const step = (key, phase, what, detail, offsetKey, opts = {}) => ({
    key: `macys:${key}`, phase, what, detail,
    offset: offsetKey ? { ...OFFSETS[offsetKey], key: offsetKey, cost: money(offsetKey) } : null,
    ...opts,
  })

  const steps = [
    step('ship-what-the-po-says', 'before', 'Ship exactly what the PO says, by store',
      'Shortages, substitutions and overages BY STORE are one offset — and it is the expensive one. '
      + 'It is a receipt fee PLUS half the value of the merchandise, so the percentage is almost the whole exposure on a wholesale handbag order.',
      'poNoncompliance', { theExpensiveOne: true }),
    step('master-pack', 'before', 'Respect master pack quantities',
      'Breaking a master pack is its own offset, separate from the shortage above.',
      'masterPack'),

    step('gs1-on-every-carton', 'label', 'A readable GS1-128 on every carton',
      'Label quality, and the pack-level data behind it. A label that will not scan is charged per carton.',
      'gs1Unusable'),
    step('gs1-placement', 'label', 'Correct placement, format, and human-readable division / PO / store',
      'The human-readable block is part of the requirement, not decoration.',
      'gs1Placement'),
    step('gs1-fob-dept', 'label', 'FOB and department on the carton',
      'Its own small per-carton offset on top of the placement one.',
      'gs1FobDept'),
    step('ticketing', 'label', 'U.P.C. ticketing correct',
      'Charged per receipt with a floor, so one bad batch costs the same as many.',
      'ticketing'),
    step('hanger', 'label', 'Hanger requirements met',
      'Per receipt with a floor. Not applicable to every product, but it is priced when it is.',
      'hanger'),

    step('right-location', 'route', 'Ship to the location the PO says',
      'Wrong-location freight is charged per carton — and unlike most of these, the app can see the DC it was routed to.',
      'wrongLocation', { appCanCatch: true }),

    asnWillBeSent
      ? step('asn-on-time', 'documents', 'Transmit the 856 ASN, on time',
          'Late is charged per receipt; missing is charged per carton with a floor. Two different offsets for the same document.',
          'asnLate')
      : step('asn-missing', 'documents', 'No 856 will be sent — this is the expensive lane',
          'Missing ASN is per carton with a minimum per receipt.',
          'asnMissing'),
    step('invoice-edi', 'after', 'Send the 810 by EDI',
      'A non-EDI invoice is charged per invoice.',
      'invoiceEdi'),
    step('integrity-audit', 'after', 'Expect the integrity audit',
      'Charged per receipt when the audit finds a discrepancy — it is the check behind the shortage offset above.',
      'integrityAudit'),
  ]

  return {
    source: SOURCE,
    portal: PORTAL,
    steps,
    phases: ['before', 'route', 'label', 'documents', 'after'],
    // ⚠️ NAMED, NOT IMPLIED. See the docblock: three of the four Macy's-side documents
    // in partnerDocuments are unread, and a checklist that does not say so reads as
    // complete.
    // ⚠️ THE ROUTING GUIDE IS READ NOW — src/model/macysRouting.js, rev 4/14/26. What
    // remains unread is the Bloomingdale's-specific guide and the Store-to-DC listing.
    notCovered: [
      'The Bloomingdale\'s Routing Guide (bloomingdales-routing) — unread.',
      'The Store-to-DC listing — unread; src/model/bolAddresses.js carries DC addresses harvested from routing notifications instead.',
    ],
    caveat: SOURCE.verifyBeforeQuoting
      ? `Figures are from the ${SOURCE.edition} ${SOURCE.document}, Appendix ${SOURCE.appendix}. Confirm the edition before quoting — the routing guide beside it in Drive is marked rev 4/14/26.`
      : null,
  }
}
