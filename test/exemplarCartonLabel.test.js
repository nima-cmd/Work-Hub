// test/exemplarCartonLabel.test.js — built against IF7650's real cartons.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cartonLabelZpl, labelProblems, shipmentLabels, ssccCheckDigit, ssccError,
  REQUIRED, SHIP_FROM, LABEL, nonAscii, STORE_UNITS_OMITTED, auditCartonMarkings,
} from '../src/model/exemplarCartonLabel.js'

// Carton 1 of IF7650, verbatim from NetSuite.
// ⚠️ 270, not 311. My first fixture said 311 — that is PO 1236143's figure, a
// different Bloomingdale's order. IF7650's 22 cartons hold 270 units, which matches
// SO12534's 22 order lines exactly. A fixture claiming to be "verbatim from
// NetSuite" has to actually be.
const carton1 = {
  sscc: '185072747098541640',
  upc: '840470893555',
  style: 'SN03011LD-MOCHA · St. Barths Petit Tote | Mocha',
  carton: 1, totalCartons: 22, units: 10, totalUnits: 270,
}
const common = {
  shipFromName: SHIP_FROM.name,
  // ⚠️ THE STOREFRONT, NOT THE TRADING-PARTNER NAME. I had "Saks Fifth Avenue" here,
  // which is what Orderful calls the partner. Store 0077's STOREFRONT column on the
  // 2026-04-21 list reads "SAKS GLOBAL", renamed to "EXEMPLAR LUXURY GROUP" effective
  // 2026-09-21. Nima: "ship to i think need to read Exemplar luxury group".
  operatingCompany: 'EXEMPLAR LUXURY GROUP',
  po: '8928906', department: '204', store: '0077', storeAbbrev: 'PNDC',
  dc: '0510', carrier: 'PER TMS',
}
const full = { ...common, ...carton1 }

test('⚠️ THE SSCC CHECK DIGIT IS VERIFIED HERE, NOT AT THE DC', () => {
  // The Zebra's Mode D computes the BARCODE's check character, which is a different
  // thing from the SSCC's own 18th digit being right. Both of these are live values.
  assert.equal(ssccCheckDigit('18507274709854164'), 0)
  assert.equal(ssccCheckDigit('98507274709953866'), 9)
  assert.equal(ssccError('185072747098541640'), null)
  assert.equal(ssccError('985072747099538669'), null)
  // A transposed digit is caught.
  assert.match(ssccError('185072747098541641'), /check digit is 1, should be 0/)
  assert.match(ssccError('18507274709854164'), /18 digits, got 17/)
  assert.equal(ssccCheckDigit('123'), null, 'too short returns null, never a digit')
})

test('⚠️ THE THREE §8 FIELDS SHOPBOP\'S LABEL LACKS ARE REQUIRED HERE', () => {
  // The live template this is modelled on was built for ShopBop and carries no
  // department, no store number/abbreviation and no style. Each is its own
  // chargeback at $250 minimum, so copying that layout would look right and cost
  // three fees. Named explicitly so nobody "simplifies" them back out.
  const keys = REQUIRED.map(([k]) => k)
  for (const k of ['department', 'store', 'storeAbbrev', 'style']) assert.ok(keys.includes(k), k)
})

test('⚠️ A MISSING FIELD IS REPORTED, NEVER PRINTED AS A DASH', () => {
  // [[default-is-not-an-answer]]. "DEPT: —" reads as a formatting choice and is a fee.
  const p = labelProblems({ ...full, department: '', store: null })
  assert.equal(p.printable, false)
  assert.deepEqual(p.missing.map((m) => m.field), ['department', 'store'])
  assert.match(p.missing[0].requirement, /Department number/)
  // And rendering one refuses rather than emitting a partial label.
  assert.throws(() => cartonLabelZpl({ ...full, department: '' }), /non-compliant/)
})

test('an unknown DC is an error, because the ship-to block would be a guess', () => {
  const p = labelProblems({ ...full, dc: '999' })
  assert.equal(p.printable, false)
  assert.match(p.errors.join(), /DC 999 is not in the Routing Guide/)
  // The real code resolves, zero-padded or not.
  assert.equal(labelProblems({ ...full, dc: '0510' }).printable, true)
  assert.equal(labelProblems({ ...full, dc: '510' }).printable, true)
})

test('carton 23 of 22 is caught', () => {
  assert.match(labelProblems({ ...full, carton: 23 }).errors.join(), /exceeds the total/)
})

test('the ZPL carries the GS1-128 in Mode D, with the (00) application identifier', () => {
  const z = cartonLabelZpl(full)
  // ⚠️ Mode D is what makes this a GS1-128 rather than a plain Code 128 — the
  // printer applies FNC1. Losing the ",D" yields a barcode that scans as the wrong
  // symbology and fails the DC's check.
  assert.match(z, /\^BCN,225,N,N,Y,D\^FD00185072747098541640\^FS/)
  assert.match(z, /\(00\) 185072747098541640/, 'the human-readable form is required beside it')
  assert.ok(z.startsWith('^XA'))
  assert.ok(z.trimEnd().endsWith('^XZ'))
})

test('every §8 marking actually appears in the rendered label', () => {
  const z = cartonLabelZpl(full)
  assert.match(z, /Entrelaced Holdings, LLC/)     // company name
  assert.match(z, /EXEMPLAR LUXURY GROUP/)        // operating company = the STOREFRONT
  assert.match(z, /8928906/)                      // PO
  assert.match(z, /DEPT: 204/)                    // department
  assert.match(z, /STORE: 0077 PNDC/)             // store number + abbreviation
  assert.match(z, /CARTON 1 of 22/)               // carton n of m
  assert.match(z, /STYLE: SN03011LD-MOCHA/)       // style / colour — SKU alone
  assert.match(z, /ITEM UPC: 840470893555/)
  assert.match(z, /QTY: 10/)
  // ⚠️ STORE UNITS ARE DELIBERATELY OFF. §8 asks for "cartons & units per store";
  // Nima's call is to print the carton half only. STORE_UNITS_OMITTED records it.
  assert.ok(!/STORE TOTAL/.test(z))
  assert.match(cartonLabelZpl({ ...full, showStoreTotal: true }), /STORE TOTAL: 270 units/)
})

test('⚠️ THE STYLE IS THE SKU ALONE, NOT THE ITEM NAME', () => {
  // Nima: "the style should be just sku SN03011ld-mocha. we dont need the name of
  // the item". The SKU already carries style and colour, and the description wrapped
  // to two lines on the narrow stocks.
  const z = cartonLabelZpl({ ...full, style: 'SN03011LD-MOCHA | St. Barths Petit Tote | Mocha' })
  assert.match(z, /STYLE: SN03011LD-MOCHA\^FS/)
  assert.ok(!/Petit Tote/.test(z))
})

test('⚠️ THE TWO LONG NUMBERS ARE LABELLED APART', () => {
  // Nima asked where the "two UPC" come from. There is one UPC and one SSCC:
  // the UPC identifies what is INSIDE (same on every unit in the box); the SSCC
  // identifies the BOX (unique to this carton). Labelling both "UPC" invited the
  // question, so the label now says ITEM UPC and "SSCC-18 (this carton)".
  const z = cartonLabelZpl(full)
  assert.match(z, /ITEM UPC: 840470893555/)
  assert.match(z, /SSCC-18  \(this carton\)/)
  assert.ok(!/\^FDUPC:/.test(z), 'a bare "UPC:" is what made them look like a pair')
})

test('⚠️ NO NON-ASCII REACHES THE PRINTER', () => {
  // I used an EM DASH as the placeholder for an unknown PRO/BOL and it printed as
  // garbage — Nima: "we see also invalid - s which we dont understand". The
  // resident fonts are single-byte; same class as the pdfkit WinAnsi rule.
  const z = cartonLabelZpl({ ...full, style: 'SN0—3011’LD…' })
  assert.deepEqual(nonAscii(z), [], 'the whole label must be ASCII')
  // ⚠️ AN UNKNOWN PRO/BOL IS BLANK, NOT "PENDING". Nima: "for pro and bol leave it
  // blank instead of pending". Neither is a §8 carton marking, so an empty box a
  // driver can write in beats a word that reads like a value.
  assert.match(z, /\^FDPRO#:\^FS/)
  assert.match(z, /\^FDBOL#:\^FS/)
  assert.ok(!/PENDING/.test(z))
  // Given real numbers they print.
  const withNums = cartonLabelZpl({ ...full, pro: '123456789', bol: 'NB1731300' })
  assert.match(withNums, /\^FD123456789\^FS/)
  assert.match(withNums, /\^FDNB1731300\^FS/)
})

test('⚠️ THE ADDRESS BLOCKS ARE WIDTH-BOUNDED SO THEY CANNOT SPILL', () => {
  // "Entrelaced Holdings, LLC" at font height 25 is ~360 dots; the column divider is
  // at 345, so it printed straight over the SHIP TO block. ZPL has no automatic
  // width — only ^FB bounds a field. Nima: "vew artifiact ship from spill into ship to".
  const z = cartonLabelZpl(full)
  // ⚠️ Asserted on CONTENT, not coordinates. My first version swept by ^FO position
  // and matched the PO number at y=530 because the range regex "5[0-9]" caught "53"
  // — a full-width field that is supposed to be unbounded.
  const lines = z.split('\n')
  const mustBeBounded = [
    'Entrelaced Holdings', '825 Western Avenue', 'Unit 13', 'Glendale, CA',
    'EXEMPLAR LUXURY GROUP', 'PNDC', '4123 Pinnacle Point', 'Dallas, TX',
  ]
  for (const text of mustBeBounded) {
    const l = lines.find((x) => x.includes(`^FD${text}`) || x.includes(text))
    assert.ok(l, `expected a field containing "${text}"`)
    assert.match(l, /\^FB\d+,/, `unbounded address field: ${l}`)
  }
  // The ship-from column is bounded to 300 dots — inside the 345-dot divider.
  assert.match(lines.find((l) => l.includes('Entrelaced Holdings')), /\^FB300,/)
})

test('the ship-to block comes from the Routing Guide DC, not from free text', () => {
  const z = cartonLabelZpl(full)
  // ⚠️ FROM THE DC LIST DOCUMENT, not from saksRouting's transcription. The label
  // used to import that table and would have printed "4123 Pinnacle Point Dr" — and
  // for DC 560, "600 Research Dr, Pittston" instead of the full CenterPoint address.
  // An incomplete consignee is fee 55/355, $250 minimum.
  assert.match(z, /PNDC/)
  assert.match(z, /4123 Pinnacle Point/)
  assert.ok(!/Pinnacle Point Dr/.test(z))
  assert.match(z, /Dallas, TX 75211/)
  // ⚠️ THE AI 420 POSTAL BARCODE IS GONE. §4.2 requires the GS1-128 facing outward
  // and nothing else — there is no postal-barcode requirement in the guide. It came
  // from the ShopBop PARCEL template, and under ZPL mode D it was printing
  // "INVALID - L" because 42075211 is not a valid UCC/EAN structure.
  assert.ok(!/\(420\)/.test(z))
  assert.ok(!/42075211/.test(z))
})

test('⚠️ DC 560 PRINTS ITS FULL THREE-LINE CONSIGNEE', () => {
  // The worst of the seven disagreements: the old table had "600 Research Dr,
  // Pittston, PA" for a DC whose real address carries a street RANGE, a business
  // park and a different municipality. 560 services 42 of the 67 stores, so this is
  // the address most cartons would have carried.
  const z = cartonLabelZpl({ ...full, dc: '560' })
  assert.match(z, /600-620 Research Drive/)
  assert.match(z, /CenterPoint Commerce & Trade Park/)
  assert.match(z, /Pittston Township, PA 18640/)
})

test('⚠️ ^ AND ~ ARE STRIPPED FROM DATA — they are ZPL control characters', () => {
  // A style name containing a caret would terminate the field and corrupt every
  // command after it, producing a mangled label rather than an error.
  const z = cartonLabelZpl({ ...full, style: 'SN03011^LD~MOCHA' })
  assert.match(z, /STYLE: SN03011 LD MOCHA/)
  assert.ok(!/SN03011\^LD/.test(z))
})

test('⚠️ ONE BAD CARTON DOES NOT WITHHOLD THE OTHER 21', () => {
  // The over-receive blocking bug: a per-shipment gate meant one problem held back
  // everything that was fine. Good labels print; bad ones are named.
  const cartons = [
    carton1,
    { ...carton1, carton: 2, sscc: '285072747098813614', upc: '840470800560' },
    { ...carton1, carton: 3, sscc: '385072747099088858', department: '' }, // bad
  ]
  const r = shipmentLabels(cartons, common)
  assert.equal(r.ready, 2)
  assert.equal(r.total, 3)
  assert.equal(r.blocked.length, 1)
  assert.equal(r.blocked[0].carton, 3)
  assert.deepEqual(r.blocked[0].missing.map((m) => m.field), ['department'])
  assert.ok(r.labels.every((l) => l.zpl.includes('^XZ')))
})

test('4x6 at 203 dpi — the stock the warehouse Zebra is loaded with', () => {
  assert.equal(LABEL.widthDots, 812)
  assert.equal(LABEL.heightDots, 1218)
  assert.equal(Math.round(LABEL.widthDots / LABEL.dpi), 4)
  assert.equal(Math.round(LABEL.heightDots / LABEL.dpi), 6)
})

test('⚠️ THE STYLE IS DERIVED FROM THE UPC, BECAUSE I TYPED ONE WRONG', () => {
  // Generating IF7650's labels I hand-typed the styles and wrote
  // "SN41263LD-CHOCOLATE" for UPC 840470890059, which the sales order calls
  // "SN41263LD-ONYX" — my query had paginated and cut off before that row, so I
  // filled in a plausible colour. §9.1 audits the label's colour against the
  // physical units at a 2% error rate; one bad carton in 22 is 4.5%.
  const upcMap = {
    '840470890059': { sku: 'SN41263LD-ONYX', description: 'Porto Medium Half-Moon Bag | Onyx', qty: 10 },
  }
  const carton = {
    carton: 22, sscc: '285072747014483044', upc: '840470890059', units: 10,
    totalCartons: 22, totalUnits: 270,
  }

  // With no typed style at all, it is looked up.
  const ok = shipmentLabels([carton], common, { upcMap })
  assert.equal(ok.ready, 1)
  assert.match(ok.labels[0].zpl, /STYLE: SN41263LD-ONYX\^FS/)
  assert.equal(ok.labels[0].style, 'SN41263LD-ONYX | Porto Medium Half-Moon Bag | Onyx',
    'the packing slip still gets the description; only the LABEL is the SKU alone')

  // ⚠️ A typed style that DISAGREES is blocked, not silently overwritten — two
  // sources disagreeing about what is in the box is a packing question.
  const wrong = shipmentLabels(
    [{ ...carton, style: 'SN41263LD-CHOCOLATE | Porto Medium Half-Moon Bag | Chocolate' }], common, { upcMap })
  assert.equal(wrong.ready, 0)
  assert.match(wrong.blocked[0].errors[0], /style disagrees/)
  assert.match(wrong.blocked[0].errors[0], /SN41263LD-ONYX/)
})

test('⚠️ A UPC ON NO ORDER LINE IS BLOCKED, NOT LABELLED FROM A TYPED STYLE', () => {
  const r = shipmentLabels(
    [{ carton: 1, sscc: '185072747098541640', upc: '999999999999', units: 10, style: 'WHATEVER',
       totalCartons: 22, totalUnits: 270 }],
    common, { upcMap: {} })
  assert.equal(r.ready, 0)
  assert.match(r.blocked[0].errors[0], /on no line of this order/)
})

test('a carton quantity that disagrees with its order line is blocked', () => {
  const upcMap = { '840470893555': { sku: 'SN03011LD-MOCHA', qty: 10 } }
  const r = shipmentLabels(
    [{ carton: 1, sscc: '185072747098541640', upc: '840470893555', units: 12,
       totalCartons: 22, totalUnits: 270 }], common, { upcMap })
  assert.equal(r.ready, 0)
  assert.match(r.blocked[0].errors[0], /quantity disagrees: carton holds 12.*is 10/)
})

test('⚠️ PRO AND BOL ARE NOT CARTON MARKINGS', async () => {
  // Nima: "do i need something for Pro number". Neither appears in §8's seven
  // markings. They are on our label only because I modelled it on the live ShopBop
  // template, where those slots carry the UPS tracking number. The BOL number IS
  // required — on the BOL (§12.9, $550), not on the box.
  const { CARTON_MARKINGS } = await import('../src/model/exemplarStandards.js')
  assert.ok(!CARTON_MARKINGS.some((r) => /\bpro\b|bol|bill of lading/i.test(r)))
  const a = auditCartonMarkings(cartonLabelZpl(full), full)
  assert.ok(a.notRequired.some((n) => /PRO number/.test(n)))
  assert.ok(a.notRequired.some((n) => /BOL number/.test(n)))
})

test('⚠️ THE §8 AUDIT IS MECHANICAL, AND IT REPORTS THE ONE PARTIAL', () => {
  // "make sure im not missing information on the label" — checked against the seven
  // markings rather than by eye, so the answer survives the next layout change.
  const a = auditCartonMarkings(cartonLabelZpl(full), full)
  assert.equal(a.missing.length, 0, 'nothing is outright missing')
  assert.equal(a.partial.length, 1)
  assert.equal(a.partial[0].n, 6, 'cartons & units per store — the units half is off by decision')
  assert.match(a.partial[0].note, /STORE_UNITS_OMITTED/)
  assert.equal(a.compliant, true)

  // Turning the store total back on closes it completely.
  const b = auditCartonMarkings(cartonLabelZpl({ ...full, showStoreTotal: true }), full)
  assert.equal(b.partial.length, 0)
  assert.ok(b.checks.every((c) => c.ok))
})

test('a label genuinely missing a marking is reported, not passed', () => {
  // The audit has to be able to FAIL, or it is decoration.
  const a = auditCartonMarkings('^XA^FDnothing^FS^XZ', {})
  assert.ok(a.missing.length >= 5)
  assert.equal(a.compliant, false)
})

test('placement is carried with the label, because content alone is not compliance', () => {
  const a = auditCartonMarkings(cartonLabelZpl(full), full)
  assert.ok(a.placement.some((p) => /picket fence/i.test(p)))
  assert.ok(a.placement.some((p) => /1\.38/.test(p)))
  assert.ok(a.placement.some((p) => /LONGEST side/i.test(p)))
})

test('⚠️ THE PO BARCODE IS MODE A, NOT MODE D — THAT WAS THE "INVALID"', () => {
  // ^BC's last parameter is the mode; D is UCC/EAN Case Code and needs numeric data
  // in a valid GS1 structure. Given a plain 10-digit PO the Zebra prints
  // "INVALID - L" where the bars go — Nima: "what is the invalid - s across from
  // purchase order". It sat at x=782, directly across from the PO text at x=30.
  const z = cartonLabelZpl(full)
  const po = z.split('\n').find((l) => l.includes('^BC') && l.includes(String(full.po).replace(/\D/g, '')))
  assert.match(po, /\^BCN,\d+,N,N,N,A\^FD/, 'the PO must be a plain Code 128 (mode A)')

  // ⚠️ The SSCC KEEPS mode D — it is a real GS1 structure and that form is proven on
  // the live ShopBop labels at a receiving DC. Only the non-GS1 barcodes changed.
  const sscc = z.split('\n').find((l) => l.includes('^BC') && l.includes('00' + full.sscc))
  assert.match(sscc, /\^BCN,\d+,N,N,Y,D\^FD00\d{18}\^FS/)

  // No barcode anywhere uses mode D on data that is not a GS1 structure.
  for (const l of z.split('\n')) {
    if (!/\^BC/.test(l)) continue
    if (/,D\^FD/.test(l)) assert.match(l, /\^FD00\d{18}\^FS/, `mode D on non-GS1 data: ${l}`)
  }
})
