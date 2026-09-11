// src/model/exemplarStandards.js — the Exemplar Vendor Standards Manual, as a
// checklist with a price on every line.
//
// Nima, 2026-09-11: "we want our routing to link to the vendor standard guide for
// reference but we also want it to guide us through the process and make sure we hit
// every requirement."
//
// Source: "Exemplar Luxury Group Vendor Standards Manual", August 2026, read end to
// end. Companion to src/model/saksRouting.js, which holds the US Routing Guide
// (rev 11, 2026-06-01). The Manual incorporates the Routing Guide by reference; where
// they overlap, the Manual is the governing document.
//
// ⚠️ EXEMPLAR LUXURY GROUP IS THE NEW NAME FOR SAKS GLOBAL, and the Manual says so on
// page 3. Anything still keyed on "Saks Global" is reading a name they have stopped
// using — the 850's own terms text already says "PLACED BY EXEMPLAR LUXURY GROUP LLC".
//
// ⚠️ AND THE MANUAL IS REISSUED WITHOUT NOTICE: "Exemplar Luxury Group reserves the
// right to revise this Manual at any time" and "The standards provided in the most
// recent version of this Manual will supersede any previous communications." So every
// rule below carries its section and page. When a new edition lands, diff it — do not
// re-read 49 pages, and do not trust a rule here that has no citation.

export const SOURCE = {
  manual: 'Exemplar Luxury Group Vendor Standards Manual',
  edition: 'August 2026',
  file: 'ELG Vendor Standards [8.6.26]_thap.pdf',
  formerly: 'Saks Global',
  banners: ['Neiman Marcus', 'Saks Fifth Avenue', 'Bergdorf Goodman'],
  routingGuide: 'Saks Global US Routing Guide rev 11 (2026-06-01) — see src/model/saksRouting.js',
  portal: 'Inbound Management System (IMS) — login via compliance@saks.com',
  disputeWindowDays: 60,
  // The document lives in Drive — src/model/partnerDocuments.js holds the link.
  // ⚠️ That entry also records what `file` above quietly says: these rules were read
  // from a 4pdf.net CONVERSION of the Manual, not the original PDF beside it.
  documentKey: 'exemplar-standards-2026-08',
}

/**
 * §12 Compliance Offset Fees, verbatim.
 *
 * ⚠️ THE MINIMUM CHARGE IS THE REAL NUMBER, not the per-unit amount. Almost every
 * carton violation is "$10.00 per carton, $250.00 minimum" — so one mislabelled
 * carton costs $250, not $10, and 25 cartons also cost $250. Reading the left-hand
 * column alone understates a single slip by 25x.
 */
export const FEES = {
  // 12.1 Carton labeling and packaging
  storeMissing: { sfa: '41', nmg: '301', what: 'Store # and name missing/incorrect on GS1-128 or carton', amount: 10, per: 'carton', min: 250, section: '12.1' },
  poMissing: { sfa: '53', nmg: '302', what: 'PO # incorrect or missing on GS1 or carton', amount: 10, per: 'carton', min: 250, section: '12.1' },
  gs1NotScannable: { sfa: '54', nmg: '304', what: 'GS1-128 label not scannable', amount: 10, per: 'carton', min: 250, section: '12.1' },
  dcDeptFormat: { sfa: '55', nmg: '355', what: 'No/incorrect format — DC, Dept or Suite # on GS1 or carton', amount: 10, per: 'carton', min: 250, section: '12.1' },
  gs1Missing: { sfa: '56', nmg: '356', what: 'Missing GS1-128 label on carton', amount: 10, per: 'carton', min: 250, section: '12.1' },
  gs1Placement: { sfa: '58', nmg: '303', what: 'GS1-128 label placement incorrect', amount: 10, per: 'carton', min: 250, section: '12.1' },
  notPredist: { sfa: '25', nmg: '305', what: 'Merchandise not pre-distributed by store', amount: 10, per: 'carton', min: 250, section: '12.1' },
  insufficientPackaging: { sfa: '113', nmg: '313', what: 'Insufficient packaging', amount: 10, per: 'carton', min: 250, section: '12.1' },
  unauthorizedPacking: { sfa: '308', nmg: '308', what: 'Unauthorized packing material (hay, straw, newspaper, printed material)', amount: 10, per: 'carton', min: 250, section: '12.1' },
  cartonWeight: { sfa: '311', nmg: '311', what: 'Carton weight exceeds max', amount: 10, per: 'carton', min: 250, section: '12.1' },
  cartonSize: { sfa: '312', nmg: '312', what: 'Carton size exceeds max', amount: 10, per: 'carton', min: 250, section: '12.1' },
  noSecurityTape: { sfa: '208', nmg: '309', what: 'No security tape', amount: 10, per: 'carton', min: 250, section: '12.1' },
  noCartonInsert: { sfa: '210', nmg: '310', what: 'No carton insert', amount: 10, per: 'carton', min: 250, section: '12.1' },

  // 12.3 EDI / ASN / shipment accuracy
  asnMissingLate: { sfa: '78/76', nmg: '501', what: 'Missing or late ASN', amount: 500, per: 'ASN', min: null, section: '12.3' },
  asnWrongDc: { sfa: '70', nmg: '502', what: 'Incorrect DC location on ASN', amount: 500, per: 'ASN', min: null, section: '12.3' },
  asnWrongStore: { sfa: '71', nmg: '503', what: 'Incorrect store/DC location on ASN', amount: 500, per: 'ASN', min: null, section: '12.3' },
  skuNotOnAsn: { sfa: '40', nmg: '509', what: 'SKU not on ASN/shipment', amount: 50, per: 'carton', min: 250, section: '12.3' },
  // ⚠️ THESE TWO SAY "EDI/NON-EDI" IN THE MANUAL'S OWN WORDS. Being non-EDI is not a
  // shelter from them — short-shipping costs $500 an incident either way.
  shortShipped: { sfa: '37', nmg: '510', what: 'Vendor short shipped (EDI/NON-EDI)', amount: 500, per: 'incident', min: 250, section: '12.3' },
  overShipped: { sfa: '36', nmg: '511', what: 'Vendor over shipped (EDI/NON-EDI)', amount: 500, per: 'incident', min: 250, section: '12.3' },
  invalid856: { sfa: '74', nmg: '513', what: 'Invalid/incorrect 856 data or format', amount: 250, per: 'ASN', min: null, section: '12.3' },
  missing810: { sfa: '215', nmg: '517', what: 'Missing 810 invoice', amount: 250, per: 'PO', min: null, section: '12.3' },
  substituted: { sfa: '42', nmg: null, what: 'Substituted merchandise (Saks only)', amount: 500, per: 'incident', min: null, section: '12.3' },
  auditProgram: { sfa: '130', nmg: null, what: 'Vendor Audit Program (Saks only)', amount: 1000, per: 'month', min: null, section: '12.3' },

  // 12.4 Packing slip — the non-EDI lane's own fees
  psNotOnCarton: { sfa: '342', nmg: '601', what: 'Packing slip not on carton', amount: 10, per: 'carton', min: 250, section: '12.4' },
  psMissingInfo: { sfa: '27', nmg: '602', what: 'Missing packing slip information', amount: 10, per: 'carton', min: 250, section: '12.4' },
  psInaccurate: { sfa: '30', nmg: '603', what: 'Inaccurate packing slip information', amount: 10, per: 'carton', min: 250, section: '12.4' },
  psNoLoadNumber: { sfa: '24', nmg: '604', what: 'No load number on packing slip', amount: 10, per: 'carton', min: 250, section: '12.4' },

  // 12.5 Purchase order
  poEarly: { sfa: '02', nmg: '701', what: 'PO shipped early', amount: 250, per: 'PO', min: null, section: '12.5' },
  poLate: { sfa: '03', nmg: '702', what: 'PO late / cancelled / closed', amount: 250, per: 'PO', min: null, section: '12.5' },
  misdirected: { sfa: '160', nmg: '703', what: 'Misroute — misdirected', amount: 25, per: 'carton', min: 250, section: '12.5' },

  // 12.6 Palletization
  notSegregatedByDc: { sfa: '170', nmg: '170', what: 'Merchandise not segregated (palletized) by DC#', amount: 10, per: 'carton', min: 250, section: '12.6' },
  improperShrinkwrap: { sfa: '171', nmg: '171', what: 'Improper shrinkwrap — cartons individually shrink wrapped', amount: 10, per: 'carton', min: 250, section: '12.6' },
  wrongPalletType: { sfa: '172', nmg: '172', what: 'Wrong pallet type / not in good condition', amount: 10, per: 'carton', min: 250, section: '12.6' },
  wrongPalletSize: { sfa: '173', nmg: '173', what: 'Incorrect pallet size', amount: 10, per: 'carton', min: 250, section: '12.6' },
  palletHeight: { sfa: '174', nmg: '174', what: 'Not stacked to correct height', amount: 10, per: 'carton', min: 250, section: '12.6' },
  palletLabel: { sfa: '175', nmg: '175', what: 'Pallet not labeled correctly', amount: 10, per: 'carton', min: 250, section: '12.6' },
  cartonOverhang: { sfa: '176', nmg: '176', what: 'Cartons overhang the pallet within an inch', amount: 10, per: 'carton', min: 250, section: '12.6' },
  baseNotSolid: { sfa: '177', nmg: '177', what: 'Base cartons not solid to support upper cartons', amount: 10, per: 'carton', min: 250, section: '12.6' },
  posMixedOnPallet: { sfa: '179', nmg: '179', what: "Separation of PO's on a pallet", amount: 10, per: 'carton', min: 250, section: '12.6' },

  // 12.9 Transportation — the expensive ones
  unauthorizedDts: { sfa: '160', nmg: 'T01', what: 'Unauthorized direct-to-store shipment', amount: 25, per: 'carton', min: 250, section: '12.9' },
  unauthorizedCarrier: { sfa: '906/933', nmg: 'T02', what: 'Freight charges for unauthorized carrier', amount: null, formula: 'cost of freight + $75 processing fee', section: '12.9' },
  // ⚠️ THE ONE THIS APP CAN PREVENT ON ITS OWN, because we mint the BOL numbers.
  multipleBols: { sfa: '950/951', nmg: 'T06', what: 'Multiple BOLs on same/consecutive business days to the same destination', amount: null, formula: 'cost of freight + $75 processing fee', section: '12.9', appCanCatch: true },
  poNotOnBol: { sfa: '954', nmg: 'T08', what: 'Valid PO not listed on BOL or carrier freight invoice', amount: 25, per: 'carton', min: 250, section: '12.9', appCanCatch: true },
  missingBoltSeal: { sfa: '955', nmg: 'T10', what: 'Improperly secured load — missing BOLT seal', amount: 200, per: 'shipment', min: null, section: '12.9', appCanCatch: true },
  wrongShipTo: { sfa: '967', nmg: 'T16', what: 'Wrong ship-to info on the BOL or carrier label', amount: 75, per: 'shipment', min: null, section: '12.9', appCanCatch: true },
  portalDcCartonCount: { sfa: '968', nmg: 'T17', what: 'Incomplete or inaccurate DC or carton count entered into the consolidator portal', amount: 150, per: 'shipment', min: null, section: '12.9' },
  portalCubicFeet: { sfa: '969', nmg: 'T18', what: 'Incomplete or inaccurate cubic feet entered into the consolidator portal', amount: 250, per: 'shipment', min: null, section: '12.9' },
  // ⚠️ $300 PER PO, and it is the single most likely fee on a shipment nobody routed.
  notBookedInTms: { sfa: '945', nmg: 'T22', what: 'Failure to book the shipment in the Saks TMS', amount: 300, per: 'PO', min: null, section: '12.9', appCanCatch: true },
  prepayAgreement: { sfa: '905', nmg: 'T24', what: 'Freight agreement — prepay', amount: null, formula: 'cost of freight + $75 processing fee', section: '12.9' },
  routingInstructions: { sfa: '930/936', nmg: 'T25', what: 'Failure to follow routing instructions', amount: null, formula: 'cost of freight + $75 processing fee', section: '12.9' },
  noBolToCarrier: { sfa: '978', nmg: 'T26', what: 'No BOL provided to the carrier', amount: 250, per: 'shipment', min: null, section: '12.9', appCanCatch: true },
}

/** What one violation actually costs on a shipment of this size. */
export function feeFor(key, { cartons = 1, pos = 1, shipments = 1, months = 1 } = {}) {
  const f = FEES[key]
  if (!f) return null
  if (f.formula) return { ...f, estimate: null, note: f.formula }
  const n = f.per === 'carton' ? cartons : f.per === 'PO' ? pos : f.per === 'month' ? months : shipments
  const raw = (f.amount || 0) * n
  // ⚠️ THE MINIMUM IS A FLOOR, NOT AN ALTERNATIVE. One bad carton is $250, not $10.
  return { ...f, estimate: f.min != null ? Math.max(raw, f.min) : raw, raw, units: n }
}

/** §8.1 carton specification (page 35). */
export const CARTON = {
  lengthIn: [9, 36], widthIn: [9, 24], heightIn: [4, 30], weightLb: [5, 50],
  newCartonsOnly: true, recycledAllowed: false,
  insertTopAndBottom: true,
  securityTape: 'Security packing tape top and bottom, H format recommended. Clear or solid plastic tape is NOT acceptable.',
  reshipperExempt: true,
  page: 35,
}

/** §8.4 palletization (pages 37-38). */
export const PALLET = {
  sizeIn: [48, 40], type: '4-way', maxHeightIn: 72,
  shrinkWrapTurns: 3, wrapIndividually: false, overhangAllowed: false,
  oneOrderPerPallet: true,
  label: ['Exemplar operating company name/address', 'PO number', 'Department number',
          'Store number and abbreviation', 'Number of cartons on the pallet'],
  multiPoPlacard: 'PO number - carton count',
  page: 37,
}

/** §8.2 GS1-128 placement (page 36). Applies to EDI AND non-ASN shipments. */
export const LABEL_PLACEMENT = {
  orientation: 'picket fence — barcode points to the bottom/conveyor',
  maxHeightIn: 12, minHeightIn: 1.38,
  side: 'the longest side of the carton',
  fedexRule: 'FedEx and GS1-128 may be on the same or opposite sides; the FedEx label may NOT cover the GS1-128',
  page: 36,
}

/** §8.5 / §9 — what must be printed on every carton, regardless of EDI status. */
export const CARTON_MARKINGS = [
  'Company name / address',
  'Operating company name/address (i.e. Saks Fifth Avenue)',
  'PO number',
  'Department number',
  'Store number and abbreviation',
  'Total number of cartons & units per store',
  'Style, colour, size details',
]

export const AUDIT = {
  itemErrorRateTrigger: 0.02,
  feePerMonth: 1000,
  minimumMonths: 3,
  exit: 'three consecutive receipt months of 99.5% error-free shipments',
  // ⚠️ ANSWERED BY THE MANUAL, and it was the open question: "Calculations are
  // performed monthly." So the 2% is assessed on a receipt month, not on a single PO
  // — one bad shipment does not put you on the programme by itself. Every PO is still
  // audited; the monthly figure is what places you.
  cadence: 'monthly',
  auditedAgainst: 'the packing slip data OR the ASN vs the GS1-128 label (store, style, colour, size, quantity) vs the physical units',
  scope: 'every PO is audited',
  alsoLoses: 'Exemplar reserves the right to keep the discrepancies found during audit',
  section: '9.1',
}

/**
 * §9.2 Received Not Ordered — and the line that matters for a re-sent PO.
 *
 * ⚠️ THE MANUAL PUTS THE RETRANSMISSION ON THEM, NOT US: "It is Exemplar Luxury
 * Group's responsibility to request an EDI-PO retransmission or a hard copy reprint of
 * the updated purchase order as confirmation of the change." So a second 850 under the
 * same PO number IS the confirmation of a change — which is exactly what Bloomingdale's
 * sent on PO 1236143 while coding it 07 Duplicate.
 */
export const RECEIVED_NOT_ORDERED = {
  definition: 'Units not shipped according to style, colour, size and store are overages and/or substitutions',
  consequence: 'Exemplar may refuse or return without vendor authorization, AND may keep the units and assess an offset fee',
  retransmissionIsConfirmation: true,
  noSubstitutions: 'Do not substitute any units on any purchase order',
  section: '9.2',
}

/**
 * The guided checklist for one shipment.
 *
 * ⚠️ ORDERED BY WHEN IT HAS TO BE TRUE, not by section number. The manual is organised
 * for reading; a floor needs it organised for doing — route before you pack, because
 * the TMS decides the mode, and label before you palletise, because you cannot reach a
 * carton label once it is wrapped three times.
 *
 * ⚠️ AND EVERY STEP CARRIES ITS PRICE. A checklist without consequences gets skipped
 * under time pressure; "$300 per PO" does not.
 */
export function shipmentChecklist({ asnWillBeSent = false, cartons = 1, pos = 1, mode = null, dts = false } = {}) {
  const money = (key) => {
    const f = feeFor(key, { cartons, pos })
    return f?.estimate != null ? `$${f.estimate.toLocaleString()}` : f?.note ?? ''
  }
  const step = (phase, what, detail, feeKey, opts = {}) => ({
    phase, what, detail,
    fee: feeKey ? { ...FEES[feeKey], cost: money(feeKey) } : null,
    ...opts,
  })

  const steps = [
    // ── 1. Before anything is picked ──────────────────────────────────────
    step('before', 'Confirm the PO has not been revised',
      'A second 850 under the same PO number is the confirmation of a change (§9.2) — check for a retransmission before picking.',
      'poLate', { appChecks: 'poRevisionTicket() compares the last two transmissions' }),
    step('before', 'Confirm freight terms — Collect or Prepaid',
      'Set at onboarding by the buying office. Logistics will not advise. Wrong terms invoke the prepay fee.',
      'prepayAgreement'),

    // ── 2. Routing, which decides the mode ────────────────────────────────
    step('route', 'Book the shipment in the Dynamic TMS',
      'At least 3 business days before the cancel date. The TMS returns the carrier, SCAC, ready date and a confirmation number.',
      'notBookedInTms', { appChecks: 'checkSaksShipment() reports the deadline' }),
    step('route', 'Let the TMS decide parcel / LTL / TL',
      'Do not assume. The routing guide leaves a gap between its own definitions, and guessing costs the freight plus $75 a package.',
      'unauthorizedCarrier'),
    dts ? step('route', 'Obtain a Direct-to-Door authorization number',
      'Per PO, ONE TIME, never reused. Must appear on the invoice, packing lists, carton labels AND the BOL (§8.3).',
      'unauthorizedDts') : null,

    // ── 3. Packing ────────────────────────────────────────────────────────
    step('pack', 'Pack by store and PO — one PO per carton',
      'Pre-distributed unless Vendor Relations approved bulk. Never mix stores in one carton.',
      'notPredist'),
    step('pack', 'New cartons, within spec',
      `L ${CARTON.lengthIn.join('-')}", W ${CARTON.widthIn.join('-')}", H ${CARTON.heightIn.join('-')}", ${CARTON.weightLb.join('-')} lb. Recycled cartons are not allowed.`,
      'cartonSize'),
    step('pack', 'Insert top and bottom of every carton',
      'Prevents pilferage. Its own fee line.',
      'noCartonInsert'),
    step('pack', 'Seal with SECURITY tape, H format, top and bottom',
      'Clear or solid plastic tape is explicitly not acceptable. Re-shipper cartons are exempt.',
      'noSecurityTape'),
    step('pack', 'No hay, straw, snow, newspaper or printed material',
      'Forbidden as packing material.',
      'unauthorizedPacking'),

    // ── 4. Labelling ──────────────────────────────────────────────────────
    step('label', 'Mark every carton permanently',
      `${CARTON_MARKINGS.join(' · ')}. Written on the carton or on a non-removable label — a packing list is NOT sufficient labelling.`,
      'storeMissing'),
    step('label', 'GS1-128 placement',
      `${LABEL_PLACEMENT.orientation}; ${LABEL_PLACEMENT.minHeightIn}"-${LABEL_PLACEMENT.maxHeightIn}" from the bottom, on ${LABEL_PLACEMENT.side}. ${LABEL_PLACEMENT.fedexRule}.`,
      'gs1Placement'),

    // ── 5. The documents, which differ by EDI status ──────────────────────
    asnWillBeSent
      ? step('documents', 'Transmit the 856 ASN', '24-48 hours before arrival. The ASN serves as the packing list.', 'asnMissingLate')
      : step('documents', 'Packing slip per PO per store, emailed IN ADVANCE',
          'Removable pouch on the carton; "PACKING SLIP ATTACHED" on all six sides. Non-trailer: packing list AND a copy of the UNSIGNED BOL in the pouch, one per PO. FedEx/UPS: a slip on every carton.',
          'psNotOnCarton'),
    step('documents', 'BOL carries the PO number and the TMS confirmation number',
      'Confirmation number goes in CID# and Special Instructions. A valid PO must be listed on the BOL.',
      'poNotOnBol'),
    step('documents', 'Hand the BOL to the driver',
      'Its own $250 fee if you do not.',
      'noBolToCarrier'),
    step('documents', 'One BOL per destination per day',
      'Multiple BOLs to the same destination on the same or consecutive business days is a freight chargeback. We mint the numbers, so this is the one only we can prevent.',
      'multipleBols', { appCanCatch: true }),

    // ── 6. Palletising, last because it seals everything ──────────────────
    step('pallet', `Palletise on ${PALLET.sizeIn.join('x')}" ${PALLET.type}, max ${PALLET.maxHeightIn}"`,
      'All truck deliveries must be palletised — floor-loaded trailers are refused.',
      'wrongPalletSize'),
    step('pallet', 'Segregate by DC, never by banner or PO',
      'Cartons for the same physical ship-to DC go on the same pallet. One PO at a time within the pallet; multiple POs must be placarded PO-carton count.',
      'notSegregatedByDc'),
    step('pallet', `Shrink wrap ${PALLET.shrinkWrapTurns}x bottom to top, secured to the pallet`,
      'Do NOT wrap or strap cartons individually. No overhang. Base cartons must be solid.',
      'improperShrinkwrap'),
    step('pallet', 'Label every pallet',
      PALLET.label.join(' · '),
      'palletLabel'),
    mode === 'TL' ? step('pallet', 'Apply a bolt seal and write the number on the BOL',
      'Full truckload direct to a DC only. No seal, or no number on the BOL, is rejection at pickup.',
      'missingBoltSeal') : null,

    // ── 7. After it ships ─────────────────────────────────────────────────
    step('after', 'Send the 810 invoice',
      'Missing invoice is its own fee, per PO.',
      'missing810'),
    step('after', 'Ship exactly what the PO says',
      `Short or over shipping is $500 an incident — and the manual says "EDI/NON-EDI", so being non-EDI is no shelter. ${AUDIT.itemErrorRateTrigger * 100}% item error over a receipt month puts you on the Vendor Audit Program at $${AUDIT.feePerMonth}/month for ${AUDIT.minimumMonths} months minimum.`,
      'shortShipped'),
  ].filter(Boolean)

  return {
    source: SOURCE,
    asnWillBeSent,
    steps,
    phases: ['before', 'route', 'pack', 'label', 'documents', 'pallet', 'after'],
    // The worst case if every automatable step is missed, for a shipment this size.
    exposure: steps
      .filter((s) => s.fee?.cost?.startsWith('$'))
      .reduce((a, s) => a + Number(String(s.fee.cost).replace(/[$,]/g, '')), 0),
  }
}
