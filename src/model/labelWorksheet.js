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
    // Billing resolved from the partner's standing rule, with anything explicitly
    // stored on the shipment winning. Bloomingdale's is always Ground; UPS is third
    // party to Macy's 5R12Y0 / zip 30083, FedEx is collect on ours.
    service: ship.billing?.service || null,
    freightTerms: ship.billing?.terms || null,
    billToAccount: ship.billing?.account || null,
    billToZip: ship.billing?.accountZip || null,
    billingFromRule: !!ship.billing?.fromRule,
    applicable: !!ship.shipDirect,
    // ⚠️ WHY there is no worksheet, whenever there isn't one. This read
    // `applicable:false cartons:0 lines:0` with no explanation at all, and the five
    // authorized 2026-08-18 Bloomingdale's shipments sat silent behind it — the
    // cartons existed, the shipments were authorized, and nothing on any surface
    // said what was missing. A count of zero is not a reason.
    //
    // Ordered by what a human would do next, most-actionable first, and each names
    // the specific thing rather than a category.
    why: whyNotApplicable(ship, rows, lines),
    lines,
    cartons: lines.length,
    // Totals are a cross-check against the BOL, not label input.
    totalWeightLb: round1(lines.reduce((n, l) => n + (l.weightLb || 0), 0)),
    incomplete: lines.filter((l) => l.missing || l.weightLb == null || l.lengthIn == null).length,
  }
}

const round1 = (n) => Math.round(n * 10) / 10

// Why this shipment has no per-carton label worksheet — null when it has one.
//
// The distinction that matters: "this lane never gets parcel labels" (a freight
// shipment consolidating into a merge center — correct, nothing to do) versus "this
// one should have them and something upstream is missing" (real work, named).
// Collapsing those is how five authorized shipments went quiet for a day.
export function whyNotApplicable(ship = {}, rows = [], lines = []) {
  // ⚠️ NOT `lines.length`. The builder deliberately emits a placeholder line for a
  // fulfilment with no carton row, so that the gap is visible rather than dropped —
  // which means a shipment with nothing packed still has lines. Keying the
  // explanation on line COUNT would have declared those worksheets fine, reproducing
  // the exact silence this exists to end, one layer up.
  if (ship.shipDirect && lines.some((l) => !l.missing)) return null

  // ⚠️ DEPARTED SHIPMENTS ARE HISTORY. The first cut of this told Nima to "pack" six
  // shipments whose freight had left on 2026-08-05 and whose fulfilments all read
  // `Shipped` — inventing eight-day-old work on a card he can do nothing about. This
  // repo has hit that exact shape repeatedly (the inverted departures board, the age
  // clock that ran forever on shipped orders); a surface explaining an absence must
  // first ask whether the absence still matters.
  if (ship.shippedAt) return null

  if (!ship.shipDirect) {
    // ⚠️ Nordstrom has NO merge centers — it routes through its own Manhattan TMS
    // straight to its DC, and `shipToFor` ignores mergeCenter for it entirely. The
    // first cut printed "consigned via the merge center (CA)" on all nine Nordstrom
    // cards: a Macy's mechanism named on a competitor's shipment, which is precisely
    // the defect PR #79 fixed on the BOL itself. Keyed on the PARTNER, like that fix.
    if (ship.partner === 'Nordstrom') {
      return {
        kind: 'freight',
        work: false,
        text: `No parcel labels — this ships as freight on BOL ${ship.bolNumber || '—'}.`,
      }
    }
    // ⚠️ And the merge center is only NAMED when we have evidence for it. Every card
    // carries merge_center 'CA' from a column default, so printing it unconditionally
    // would state as fact the very default this PR exists to stop trusting. The
    // consignee block off the routing notification is that evidence.
    const named = ship.consignedTo && ship.mergeCenter
    return {
      kind: 'freight',
      work: false,
      text: named
        ? `No parcel labels — consigned via the ${ship.mergeCenter} merge center, so this ships on BOL ${ship.bolNumber || '—'}.`
        : `No parcel labels — not consigned direct to the DC, so this ships on BOL ${ship.bolNumber || '—'}. ` +
          `No routing notification has confirmed where it is consigned.`,
    }
  }
  // Direct to the DC, so labels ARE the shipping method — but there is nothing to
  // build them from. Name the fulfilments, because "pack them" is the actual next
  // action and it is per-IF.
  if (!rows.length) {
    return {
      kind: 'no_orders',
      work: true,
      text: `No parcel labels — no order lines are linked to this shipment yet, so there is nothing to label.`,
    }
  }
  const unpacked = rows.filter((r) => !r.cartons?.length)
  const ifs = [...new Set(unpacked.map((r) => r.ifNumber).filter(Boolean))]
  return {
    kind: 'not_packed',
    work: true,
    ifs,
    // The specific fulfilments, not a count — the whole point is that he can go and
    // pack exactly these.
    text: ifs.length
      ? `No parcel labels yet — ${ifs.length === 1 ? 'fulfilment' : 'fulfilments'} ${ifs.join(', ')} ` +
        `${ifs.length === 1 ? 'has' : 'have'} no cartons. Pack ${ifs.length === 1 ? 'it' : 'them'} in NetSuite ` +
        `before a parcel label can be made.`
      : `No parcel labels yet — ${unpacked.length} order line(s) on this shipment have no fulfilment, so no cartons exist to label.`,
  }
}

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
// ⚠️ Carrier and Service are SEPARATE columns. An earlier cut put the raw carrier
// string ("UPS GRND") in Service, which no importer understands as a service level —
// the service is always "Ground" here and the carrier is which company.
// BillTo_Zip is required for UPS third-party billing: without it UPS rejects the
// third-party account or falls back to billing the shipper.
export const CSV_COLUMNS = [
  'Reference1_PO', 'Reference2_Store', 'ShipTo_Company', 'ShipTo_Address1',
  'ShipTo_City', 'ShipTo_State', 'ShipTo_Zip', 'ShipTo_Country',
  'Weight_Lb', 'Length_In', 'Width_In', 'Height_In',
  'Carrier', 'Service', 'Billing', 'BillTo_Account', 'BillTo_Zip',
  'SSCC', 'IF', 'BOL',
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
        w.carrier, w.service, w.freightTerms, w.billToAccount, w.billToZip,
        l.ucc, l.ifNumber, w.bolNumber,
      ].map(csvCell).join(','))
    }
  }
  return out.join('\n') + '\n'
}
