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

// Expand fulfilment rows into one line per carton.
//
// rows: [{ poNumber, storeNumber, storeName, soNumber, ifNumber, cartons, units }]
// ship: { bolNumber, dc, carrier, shipDate, shipDirect, consignedTo, address }
export function buildLabelWorksheet(ship = {}, rows = []) {
  const lines = []
  for (const r of rows) {
    // A fulfilment with no carton count yet still gets ONE line rather than
    // vanishing — a box exists physically whether or not the pack feed has caught
    // up, and a missing line is how a carton ships unlabelled.
    const n = Math.max(1, Number(r.cartons) || 0)
    for (let k = 1; k <= n; k++) {
      lines.push({
        seq: lines.length + 1,
        poNumber: r.poNumber,
        storeNumber: r.storeNumber || null,
        storeName: shortStore(r.storeName),
        soNumber: r.soNumber,
        ifNumber: r.ifNumber,
        cartonOf: n > 1 ? `${k} of ${n}` : null,
        ifUnits: r.units ?? null,
        cartonsUnknown: !Number(r.cartons),
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
    // Freight moves on the BOL, so a per-carton parcel sheet is meaningless there.
    // Stated rather than silently returning an empty list.
    applicable: !!ship.shipDirect,
    lines,
    cartons: lines.length,
    stores: new Set(lines.map((l) => l.storeNumber)).size,
  }
}

// "Bloomingdale's - 0231 China Grove Pool Stock/Customer/Customer Fulfillment
// Center" is unreadable on a worksheet row. Keep the human part, drop the prefix
// and the warehouse boilerplate.
export function shortStore(name) {
  if (!name) return null
  return String(name)
    .replace(/^.*?\b\d{4}\s*/, '')
    .replace(/\s*(Pool Stock|Customer Fulfillment Center|Customer)\b.*$/i, '')
    .trim() || String(name).trim()
}

// A single line's label text, so the sheet and anything printed from it can never
// disagree about what goes on the box.
export function labelLine(l) {
  const store = l.storeNumber ? `Store ${l.storeNumber}` : 'Store ?'
  const carton = l.cartonOf ? ` · carton ${l.cartonOf}` : ''
  return `PO ${l.poNumber} · ${store}${carton}`
}
