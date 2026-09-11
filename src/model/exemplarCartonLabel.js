// src/model/exemplarCartonLabel.js — the GS1-128 carton label for Exemplar, as ZPL.
//
// Nima, 2026-09-11: "We also need to be able to for Neiman Marcus generate the label
// the packing slip based off what we packed they shoud be readable as package just as
// the Bloomingdales Nordstrom ones are."
//
// ── WHY ZPL, AND WHY NOT A BARCODE LIBRARY ──────────────────────────────────
//
// A GS1-128 needs Code 128 with FNC1. This repo has a UPC-A encoder
// (src/model/upcBarcode.js) and nothing for Code 128, and I am not writing 107 bar
// patterns from memory: one wrong symbol is an unscannable label, which is fee code
// 54/304 at $10 per carton, $250 minimum, and nobody finds out until the DC scans it.
//
// The Zebra already does it correctly. `^BC...,D` is Mode D — UCC/EAN Case Code —
// which applies FNC1 and the GS1 check digit in firmware. That is also how the
// EXISTING labels work: customrecord_hb_edi_packages.custrecord_hb_edi_package_zpl
// holds ZPL for 3,087 of 3,761 live cartons, and this file is modelled field-for-field
// on one of them (ShopBop PO POJ00371660, carton 1 of 2) so ours prints on the same
// stock, on the same printer, through the same server/printLabel.js path.
//
// ⚠️ IF7650's 22 CARTONS HAVE NO ZPL. That is why this exists. The NetSuite script
// that fills the field ran for the EDI partners and never ran for this shipment, so
// there is nothing to print — the cartons carry valid SSCCs and contents, and no label.
//
// ── ⚠️ WHAT EXEMPLAR REQUIRES THAT SHOPBOP'S LABEL DOES NOT CARRY ───────────
//
// The live template was built for ShopBop. Exemplar's Manual §8 lists seven carton
// markings (see CARTON_MARKINGS in exemplarStandards.js), and three are absent from
// it: DEPARTMENT NUMBER, STORE NUMBER AND ABBREVIATION, and STYLE/COLOUR/SIZE.
// Copying the ShopBop layout unchanged would have produced a label that looks right
// and is chargeable three ways ($250 minimum each). They are required fields here.

// ⚠️ FROM exemplarStores.js, NOT saksRouting.js. This originally imported
// saksRouting's hand-transcribed table, which disagreed with the DC list document on
// every entry — so a label for DC 560 would have printed "600 Research Dr, Pittston"
// instead of "600-620 Research Drive, CenterPoint Commerce & Trade Park, Pittston
// Township". An incomplete consignee is fee 55/355, $250 minimum.
import { DCS, dcAddressLines, servicingDc, isLiveShipTo } from './exemplarStores.js'

/** 4x6 thermal at 203 dpi, the stock the warehouse Zebra is loaded with. */
export const LABEL = { widthDots: 812, heightDots: 1218, dpi: 203 }

/**
 * Ship-from, taken from the LIVE label rather than from bolAddresses.js.
 *
 * ⚠️ THEY DISAGREE, AND THE LABEL IS THE ONE IN USE. bolAddresses.js SHIP_FROM says
 * name "Naghedi" and street "825 Western Unit 13"; every printed carton label says
 * "Entrelaced Holdings, LLC" and "825 Western Avenue" / "Unit 13". The legal entity
 * is what a carton marking wants ("Company name / address", §8), so this follows the
 * label. Not reconciled into bolAddresses.js on purpose — a BOL and a carton marking
 * can legitimately differ, and silently changing the BOL's shipper is not my call.
 */
export const SHIP_FROM = {
  name: 'Entrelaced Holdings, LLC',
  lines: ['825 Western Avenue', 'Unit 13'],
  city: 'Glendale', state: 'CA', zip: '91201',
}

const digits = (v) => String(v ?? '').replace(/\D/g, '')

/**
 * SSCC-18 mod-10, computed so a bad one is caught HERE and not at the DC.
 *
 * ⚠️ The Zebra's Mode D will happily print whatever it is given; "Y" in the ^BC
 * parameters means it computes the BARCODE's own check character, which is a
 * different thing from the SSCC's 18th digit being right. Verified against live
 * data: 185072747098541640 and 985072747099538669 both check out.
 */
export function ssccCheckDigit(first17) {
  const d = digits(first17).slice(0, 17)
  if (d.length !== 17) return null
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(d[i]) * (i % 2 === 0 ? 3 : 1)
  return (10 - (sum % 10)) % 10
}

export function ssccError(sscc) {
  const d = digits(sscc)
  if (!d) return 'no SSCC'
  if (d.length !== 18) return `SSCC must be 18 digits, got ${d.length}`
  const want = ssccCheckDigit(d.slice(0, 17))
  if (Number(d[17]) !== want) return `SSCC check digit is ${d[17]}, should be ${want}`
  return null
}

/**
 * §8 markings this label must carry. A missing one is its own chargeback.
 *
 * ⚠️ `totalUnits` IS NO LONGER REQUIRED, AND THAT IS A DELIBERATE DEVIATION.
 * Nima, 2026-09-11: "we dont think we need the store units". The Manual's §8 list
 * reads "Total number of cartons & units per store", so the units half is a
 * documented requirement we are choosing not to print. "CARTON n of m" still carries
 * the cartons half.
 *
 * Recorded rather than quietly dropped: if a carton marking is ever queried, this is
 * the line that was left off and the decision that left it off. Pass `totalUnits`
 * with `showStoreTotal: true` to put it back — nothing else changes.
 */
export const STORE_UNITS_OMITTED = {
  requirement: 'Total number of cartons & units per store',
  section: '8 (CARTON_MARKINGS)',
  decidedBy: 'Nima, 2026-09-11',
  stillPrinted: 'the carton count, as "CARTON n of m"',
  restoreWith: 'showStoreTotal: true',
}

export const REQUIRED = [
  ['shipFromName', 'Company name / address'],
  ['operatingCompany', 'Operating company (e.g. Saks Fifth Avenue)'],
  ['po', 'PO number'],
  ['department', 'Department number'],
  ['store', 'Store number'],
  ['storeAbbrev', 'Store abbreviation'],
  ['totalCartons', 'Total cartons for the store'],
  ['style', 'Style / colour / size'],
  ['sscc', 'GS1-128 SSCC'],
]

/**
 * What is missing before anything is printed.
 *
 * ⚠️ IT RETURNS PROBLEMS, IT DOES NOT INVENT VALUES. [[default-is-not-an-answer]] —
 * a label that prints "DEPT: —" is a $250 fee that looks like a formatting choice.
 */
export function labelProblems(c = {}) {
  const missing = REQUIRED.filter(([k]) => {
    const v = c[k]
    return v === null || v === undefined || String(v).trim() === ''
  }).map(([k, label]) => ({ field: k, requirement: label }))

  const errors = []
  const se = ssccError(c.sscc)
  if (se && c.sscc !== undefined) errors.push(se)
  if (c.carton && c.totalCartons && Number(c.carton) > Number(c.totalCartons)) {
    errors.push(`carton ${c.carton} of ${c.totalCartons} — carton number exceeds the total`)
  }
  // A DC code we do not recognise means the ship-to block is a guess.
  if (c.dc && !DCS[String(c.dc).replace(/^0+/, '')]) {
    errors.push(`DC ${c.dc} is not in the Routing Guide's DC table`)
  }
  return { missing, errors, printable: missing.length === 0 && errors.length === 0 }
}

/**
 * ⚠️ ZPL DATA IS ASCII. Two separate hazards, and I hit the second one.
 *
 * `^` and `~` are ZPL's own control characters: leaving one in data terminates the
 * field and corrupts every command after it.
 *
 * And the printer's resident fonts are a single-byte code page, so a non-ASCII
 * character prints as a box or the wrong glyph. I used an EM DASH as the placeholder
 * for an unknown PRO and BOL number, and Nima saw it come out as garbage — "we see
 * also invalid - s which we dont understand". Same class as the pdfkit WinAnsi rule
 * already recorded in this repo: use ASCII on a label, always.
 */
const esc = (s) => String(s ?? '')
  .replace(/[\u2010-\u2015]/g, '-')   // dashes
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
  .replace(/\u2026/g, '...')
  .replace(/[^\x20-\x7E]/g, '')       // anything else non-ASCII is dropped, not drawn
  .replace(/[\^~]/g, ' ')

/**
 * Characters the printer's resident font cannot render. Newline, carriage return and
 * tab are excluded: they separate ZPL commands and are not drawn.
 *
 * ⚠️ My first version flagged \n and reported 45 "non-ASCII characters" on a
 * perfectly clean label — a checker that cries wolf gets switched off.
 */
export const nonAscii = (s) => [...String(s ?? '')]
  .filter((c) => { const n = c.charCodeAt(0); return (n > 126 || n < 32) && n !== 10 && n !== 13 && n !== 9 })

const fd = (font, x, y, text) => `^AN,${font}^FO${x},${y}^FD${esc(text)}^FS`

/**
 * A field constrained to a column width, so long text WRAPS instead of running into
 * the next column. ZPL has no automatic width: every ^FD prints from its origin to
 * the edge of the label unless a ^FB field block bounds it.
 *
 * ⚠️ THIS IS WHAT MADE THE SHIP-FROM SPILL. "Entrelaced Holdings, LLC" at font
 * height 25 is about 360 dots wide, the divider is at 345, so the company name
 * printed straight over the SHIP TO block. Nima: "vew artifiact ship from spill into
 * ship to". Exactly the same bug as the PDF labels, in a different language.
 */
const fb = (font, x, y, width, text, lines = 2) =>
  `^AN,${font}^FO${x},${y}^FB${width},${lines},0,L,0^FD${esc(text)}^FS`

/**
 * The label, as ZPL.
 *
 * @param c.sscc           18-digit SSCC from custrecord_hb_edi_package_ucc
 * @param c.upc            the carton's UPC, or 'Mixed SKUs'
 * @param c.style          style / colour / size for the human-readable block
 * @param c.carton/.totalCartons  "CARTON n of m"
 * @param c.units          units in THIS carton
 * @param c.totalUnits     units for the store across the shipment (§8)
 * @param c.dc             Routing Guide DC code — supplies the ship-to block
 *
 * ⚠️ It THROWS on a non-printable label rather than emitting a partial one. The
 * caller is expected to have shown labelProblems() to a human first.
 */
export function cartonLabelZpl(c = {}) {
  const p = labelProblems(c)
  if (!p.printable) {
    throw new Error(`refusing to render a non-compliant carton label: ${
      [...p.missing.map((m) => `missing ${m.field} (${m.requirement})`), ...p.errors].join('; ')}`)
  }
  const dc = DCS[String(c.dc).replace(/^0+/, '')]
  const lines = dcAddressLines(c.dc)
  const zip = dc.zip
  const sscc = digits(c.sscc)

  const out = ['^XA', '']
  // ── Ship from / ship to, split down the middle like the live template ──
  out.push(`^FO0,0^GB${LABEL.widthDots},237,2^FS`, '^FO345,0^GB2,237,2^FS')
  const COL = 300   // dots: 345 divider - 30 origin, less a gutter
  out.push(fd(20, 30, 25, 'SHIP FROM'), fb(22, 30, 52, COL, SHIP_FROM.name, 2))
  SHIP_FROM.lines.forEach((l, i) => out.push(fb(22, 30, 108 + i * 30, COL, l, 1)))
  out.push(fb(22, 30, 168, COL, `${SHIP_FROM.city}, ${SHIP_FROM.state} ${SHIP_FROM.zip}`, 1))

  out.push('', fd(20, 370, 25, 'SHIP TO'), fb(24, 370, 52, 410, c.operatingCompany, 2))
  out.push(fb(22, 370, 112, 410, dc.name, 1))
  lines.forEach((l, i) => out.push(fb(22, 370, 142 + i * 30, 410, l, 1)))

  // ── Postal-code barcode (AI 420) + carrier, as the live label does ──
  out.push('', `^FO0,235^GB${LABEL.widthDots},213,2^FS`, '^FO380,235^GB2,213,2^FS')
  if (zip) {
    out.push(fd(20, 30, 250, 'SHIP TO POSTAL CODE'), fd(25, 120, 285, `(420) ${zip}`))
    out.push(`^BY3,3,10^FO55,315^BCN,110,N,N,Y,D^FD420${zip}^FS`)
  }
  out.push('', fd(20, 405, 250, 'CARRIER'), `^A0N,35^FO405,290^FDCARR: ${esc(c.carrier || 'PER TMS')}^FS`)
  // ⚠️ AN UNKNOWN PRO OR BOL PRINTS "PENDING", NOT A DASH. Both are issued when the
  // freight is booked and the BOL is minted, which has not happened for this
  // shipment — so the honest label says the number is coming. A dash reads as a
  // formatting glitch (and, as an em dash, printed as one).
  out.push(fd(25, 405, 350, 'PRO#:'), fd(25, 490, 350, c.pro || 'PENDING'))
  out.push(fd(25, 405, 390, 'BOL#:'), fd(25, 490, 390, c.bol || 'PENDING'))

  // ── PO + department + store: the §8 fields ShopBop's label has no room for ──
  out.push('', fd(25, 30, 475, 'PURCHASE ORDER:'), `^AN,40^FO30,530^FD${esc(c.po)}^FS`)
  out.push(`^BY3,3,10^FO782,475,1^BCN,110,N,N,Y,D^FD${esc(digits(c.po) || c.po)}^FS`)
  out.push(fd(28, 30, 600, `DEPT: ${c.department}    STORE: ${c.store} ${c.storeAbbrev}`))

  // ── What is in the box ──
  //
  // ⚠️ TWO NUMBERS ON THIS LABEL LOOK ALIKE AND ARE NOT. Nima asked where the two
  // UPCs come from; there is only one UPC, and the other long number is the SSCC.
  //   ITEM UPC  840470893555        what is INSIDE — the product, ours, from
  //                                 item.upccode. Same on all 10 units in the box.
  //   SSCC-18   185072747098541640  the BOX ITSELF — a serial licence plate, unique
  //                                 to this carton, from custrecord_hb_edi_package_ucc.
  // Labelled "ITEM UPC" rather than "UPC" so the two are not read as a pair.
  //
  // ⚠️ STYLE IS THE SKU ALONE. Nima: "the style should be just sku SN03011ld-mocha.
  // we dont need the name of the item". The SKU already encodes style and colour,
  // and the description wrapped to two lines on the narrow stocks.
  const sku = String(c.style).split(/\s*[|·]/)[0].trim()
  out.push('', fd(30, 30, 655, `ITEM UPC: ${c.upc}`))
  out.push(fd(32, 30, 700, `STYLE: ${sku}`))
  out.push(fd(30, 30, 750, `QTY: ${c.units}`))
  if (c.showStoreTotal && c.totalUnits) {
    out.push(fd(24, 300, 750, `STORE TOTAL: ${c.totalUnits} units / ${c.totalCartons} ctns`))
  }
  out.push(fd(34, 30, 820, `CARTON ${c.carton} of ${c.totalCartons}`))

  // ── SSCC-18, the scanned identity of the box ──
  out.push('', `^FO0,896^GB${LABEL.widthDots},400,2^FS`)
  out.push(fd(20, 30, 911, 'SSCC-18  (this carton)'), fd(25, 240, 942, `(00) ${sscc}`))
  out.push(`^BY4,3,10^FO95,972^BCN,225,N,N,Y,D^FD00${sscc}^FS`)
  out.push(`^FO0,0^GB${LABEL.widthDots},${LABEL.heightDots},2,W^FS`, '', '^XZ')
  return out.join('\n')
}

/**
 * Every carton's label for a shipment, plus one report of what is wrong.
 *
 * ⚠️ ONE BAD CARTON DOES NOT WITHHOLD THE OTHER 21. The over-receive blocking bug
 * taught this: a per-shipment gate meant one problem held back everything valid.
 * Good labels come back ready to print; bad ones come back named.
 *
 * ── ⚠️ THE STYLE IS DERIVED FROM THE UPC, NEVER TYPED ───────────────────────
 *
 * `upcMap` is UPC → { sku, description }, built from the order's own lines. Pass it
 * and the style on the label is LOOKED UP; a carton whose UPC is not in the map is
 * blocked rather than labelled.
 *
 * This exists because I got one wrong. Generating IF7650's 22 labels I hand-typed
 * the style names, and for UPC 840470890059 I wrote "SN41263LD-CHOCOLATE" when the
 * sales order says "SN41263LD-ONYX" — my NetSuite query had paginated and cut off
 * before that row, so I filled in a plausible colour. It was caught only by
 * re-checking every carton against the order.
 *
 * A wrong colour on a GS1-128 is exactly what Exemplar audits: §9.1 compares the
 * label's store/style/colour/size against the PHYSICAL units, at 2% item error rate
 * for the $1,000-a-month programme. One mislabelled carton out of 22 is 4.5%.
 */
export function shipmentLabels(cartons = [], common = {}, { upcMap = null } = {}) {
  const labels = []
  const blocked = []
  for (const carton of cartons) {
    const c = { ...common, ...carton }
    if (upcMap) {
      const hit = upcMap[String(c.upc ?? '').trim()]
      if (!hit) {
        blocked.push({
          carton: c.carton, sscc: c.sscc, missing: [], printable: false,
          errors: [`UPC ${c.upc} is on no line of this order — cannot derive the style, and a typed one is not trusted`],
        })
        continue
      }
      // ⚠️ A TYPED STYLE THAT DISAGREES IS AN ERROR, NOT SOMETHING TO OVERWRITE.
      // Silently replacing it would hide the fact that two sources disagree about
      // what is in the box, which is a packing question, not a formatting one.
      const typedSku = c.style ? String(c.style).split(/\s*[|·]/)[0].trim() : null
      if (typedSku && typedSku !== hit.sku) {
        blocked.push({
          carton: c.carton, sscc: c.sscc, missing: [], printable: false,
          errors: [`style disagrees: carton says "${typedSku}", UPC ${c.upc} on this order is "${hit.sku}"`],
        })
        continue
      }
      c.style = hit.description ? `${hit.sku} | ${hit.description}` : hit.sku
      if (hit.qty != null && Number(c.units) !== Number(hit.qty)) {
        blocked.push({
          carton: c.carton, sscc: c.sscc, missing: [], printable: false,
          errors: [`quantity disagrees: carton holds ${c.units}, the order line for ${hit.sku} is ${hit.qty}`],
        })
        continue
      }
    }
    const p = labelProblems(c)
    if (!p.printable) { blocked.push({ carton: c.carton, sscc: c.sscc, ...p }); continue }
    labels.push({ carton: c.carton, sscc: c.sscc, upc: c.upc, style: c.style, units: c.units, zpl: cartonLabelZpl(c) })
  }
  return { labels, blocked, ready: labels.length, total: cartons.length }
}


/**
 * ⚠️ IS ANYTHING MISSING? — checked against §8's seven markings, not by eye.
 *
 * Nima, 2026-09-11: "make sure im not missing information on the label and adhering
 * to their guidlines do i need something for Pro number".
 *
 * Answer to the PRO question, and it is worth stating plainly: PRO AND BOL ARE NOT
 * CARTON MARKINGS. Neither appears in §8's list. They are on our label because I
 * modelled it on the live ShopBop template, and ShopBop's parcel labels carry the
 * UPS tracking number in those slots. For Exemplar they are optional — useful to a
 * person reconciling freight, required by nothing.
 *
 * The BOL number IS required, but on the BOL itself (§12.9, $550, together with the
 * TMS confirmation number in CID# and Special Instructions) — not on the box.
 */
export function auditCartonMarkings(zpl, carton = {}) {
  const has = (re) => re.test(zpl)
  const checks = [
    { n: 1, requirement: 'Company name / address',
      ok: has(/SHIP FROM/) && has(new RegExp(SHIP_FROM.name.split(',')[0])) && has(/Glendale/) },
    { n: 2, requirement: 'Operating company name/address',
      ok: has(/SHIP TO/) && Boolean(carton.operatingCompany) && has(new RegExp(String(carton.operatingCompany).slice(0, 12))) },
    { n: 3, requirement: 'PO number', ok: has(/PURCHASE ORDER/) && has(new RegExp(String(carton.po))) },
    { n: 4, requirement: 'Department number', ok: has(/DEPT:/) },
    { n: 5, requirement: 'Store number and abbreviation', ok: has(/STORE:\s*\S+\s+\S+/) },
    { n: 6, requirement: 'Total number of cartons & units per store',
      ok: has(/CARTON \d+ of \d+/) && has(/STORE TOTAL/),
      partial: has(/CARTON \d+ of \d+/) && !has(/STORE TOTAL/),
      note: 'Cartons are printed as "CARTON n of m". The UNITS half is off by decision — see STORE_UNITS_OMITTED. showStoreTotal: true restores it.' },
    { n: 7, requirement: 'Style, colour, size details',
      ok: has(/STYLE:/) && /-/.test(String(carton.style ?? '')),
      note: 'The SKU carries style and colour (SN03011LD-MOCHA). SIZE is not printed separately; every item on this PO is ONE SIZE / NO SIZE on the PO download, so there is no size to state — confirm that holds for a PO that carries real sizes.' },
  ]
  return {
    checks,
    missing: checks.filter((c) => !c.ok && !c.partial),
    partial: checks.filter((c) => c.partial),
    compliant: checks.every((c) => c.ok || c.partial),
    // Not markings, but the label is useless if it is applied wrong.
    placement: [
      'Picket fence — the barcode reads bottom-to-top toward the conveyor.',
      'Between 1.38 in and 12 in from the bottom of the carton.',
      'On the LONGEST side of the carton.',
      'A FedEx label may sit on the same or the opposite side, but must NOT cover the GS1-128.',
    ],
    notRequired: [
      'PRO number — not a §8 carton marking; inherited from the ShopBop template this label was modelled on.',
      'BOL number — required on the BOL (§12.9), not on the carton.',
    ],
  }
}
