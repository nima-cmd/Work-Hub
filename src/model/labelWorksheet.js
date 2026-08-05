// src/model/labelWorksheet.js — one line per carton, for typing parcel labels by
// hand.
//
// Nima, 2026-08-05: "since these are ups and fedex i need to create labels. our API
// with shipstation isn't workign and these have to be manually created i have all
// the carton information already present but it be nice to see with which store it
// goes to when i manually create the labels… We need the PO number and the store
// number on them for him to label."
//
// ── Why the store matters on a shipment going to a DC ───────────────────────
//
// A Bloomingdale's DC-direct shipment is consigned to ONE address (the DC), but
// every carton inside it belongs to a different STORE — the DC cross-docks them. So
// the address is the same on all 22 labels and the PO + store is the only thing
// distinguishing them, which is exactly what the DC needs printed to route the box
// onward. Getting that pair wrong sends a carton to the wrong store with a
// perfectly valid label.
//
// ── One row per CARTON, and the honest limit on that ────────────────────────
//
// A row is expanded per carton because that is the unit being typed. But units are
// only known PER FULFILMENT, not per carton — `edi_fulfillment_pack` counts cartons
// and units for an IF, and nothing records which unit went in which box. So a
// 2-carton IF shows "carton 1 of 2" and the IF's TOTAL units, never a fabricated
// per-carton split. Same rule as everywhere else here: a guessed number is worse
// than an absent one, because this one would be checked against a physical box.
//
// Weight is deliberately absent for the same reason. `fulfillment_boxes` (the
// scan-in dims) is EMPTY — 0 rows — and `edi_packages.weight_lb` is a PO-DC total,
// so dividing it by carton count would invent a figure that goes on a carrier label
// and gets billed.

// One line per CARTON, from the persisted carton rows (Nima, 2026-08-05: "i dont
// need the name and the carton count i do need how each carton in the shipment its
// weight and dimension").
//
// rows: [{ poNumber, storeNumber, soNumber, ifNumber, cartons: [{cartonNo, weightLb,
//          lengthIn, widthIn, heightIn, boxName, ucc, units}] }]
export function buildLabelWorksheet(ship = {}, rows = []) {
  const lines = []
  for (const r of rows) {
    const cartons = r.cartons?.length ? r.cartons : [null]
    for (const c of cartons) {
      lines.push({
        seq: lines.length + 1,
        poNumber: r.poNumber,
        storeNumber: r.storeNumber || null,
        ifNumber: r.ifNumber,
        cartonNo: c?.cartonNo ?? null,
        // ⚠️ Real per-carton figures, never a total divided by carton count. IF7469
        // ships two boxes of the SAME type weighing 44lb and 47lb — an average
        // would be wrong on both, and a wrong weight on a carrier label gets
        // rebilled.
        weightLb: c?.weightLb ?? null,
        lengthIn: c?.lengthIn ?? null,
        widthIn: c?.widthIn ?? null,
        heightIn: c?.heightIn ?? null,
        dims: c && c.lengthIn ? `${c.lengthIn}x${c.widthIn}x${c.heightIn}` : null,
        ucc: c?.ucc ?? null,
        // No carton row yet — the box exists physically, so it gets a line with the
        // gap visible rather than being dropped.
        missing: !c,
      })
    }
  }
  return {
    bolNumber: ship.bolNumber,
    dc: ship.dc,
    carrier: ship.carrier || null,
    shipDate: ship.shipDate || null,
    shipTo: ship.address || null,
    consignedTo: ship.consignedTo || null,
    billToAccount: ship.billToAccount || null,
    freightTerms: ship.freightTerms || null,
    applicable: !!ship.shipDirect,
    lines,
    cartons: lines.length,
    // Totals are a cross-check against the BOL, not label input.
    totalWeightLb: round1(lines.reduce((n, l) => n + (l.weightLb || 0), 0)),
    incomplete: lines.filter((l) => l.missing || l.weightLb == null || l.lengthIn == null).length,
  }
}

const round1 = (n) => Math.round(n * 10) / 10

// The label's own reference fields: PO and store are what the DC cross-docks on.
export function labelLine(l) {
  const store = l.storeNumber ? `Store ${l.storeNumber}` : 'Store ?'
  return `PO ${l.poNumber} · ${store}`
}

// A CSV a carrier's batch-import tool can read. One row per carton, because that is
// one label.
//
// ⚠️ The column NAMES here are generic on purpose. UPS's importers do not share a
// schema — WorldShip uses a user-defined import map, ups.com "Import Shipments"
// expects its own header set — so this emits every field a label needs under plain
// names and the map is pointed at them. Guessing one tool's exact headers would
// produce a file that imports silently wrong, which is worse than one that needs
// mapping once.
export const CSV_COLUMNS = [
  'Reference1_PO', 'Reference2_Store', 'ShipTo_Company', 'ShipTo_Address1',
  'ShipTo_City', 'ShipTo_State', 'ShipTo_Zip', 'ShipTo_Country',
  'Weight_Lb', 'Length_In', 'Width_In', 'Height_In',
  'Service', 'Billing', 'BillTo_Account', 'SSCC', 'IF', 'BOL',
]

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function worksheetCsv(sheets = []) {
  const out = [CSV_COLUMNS.join(',')]
  for (const w of sheets) {
    if (!w.applicable) continue
    for (const l of w.lines) {
      out.push([
        l.poNumber, l.storeNumber,
        w.shipTo?.name, w.shipTo?.street, w.shipTo?.city, w.shipTo?.state, w.shipTo?.zip, 'US',
        l.weightLb, l.lengthIn, l.widthIn, l.heightIn,
        w.carrier, w.freightTerms, w.billToAccount, l.ucc, l.ifNumber, w.bolNumber,
      ].map(csvCell).join(','))
    }
  }
  return out.join('\n') + '\n'
}
