// src/model/ediSearch.js — shaping "type any number, find the PO" results.
//
// Nima, 2026-08-25, after having to ask what happened to PO 7242978: "We want to be
// able to [be] here and search which is another feature missing in the EDI and pull
// everything up for it."
//
// ── ⚠️ SEARCH EVERYWHERE, THEN SAY WHAT MATCHED ─────────────────────────────
//
// The tempting design is to classify the input first — "NB… is a BOL, 5 digits is an
// invoice, 7 digits is a PO" — and query the one place. That is guessing, and the
// guesses collide: 11419 is an invoice number AND a plausible PO, and this repo
// already has a documented case of one identifier meaning two things with ZERO
// overlapping values (orders.po_number vs purchase_orders.po_number, see
// orderLane.js). A classifier would silently look in the wrong table and report
// "not found" about a number that exists.
//
// So every identifier column is searched and each hit carries the FIELD it matched.
// The reader sees "11419 — invoice on PO 7242978", not a bare result.

/** What an identifier turned out to be. Descriptive, assigned by the hit, never
 *  inferred from the shape of the input. */
export const MATCH = {
  PO: 'po',                 // orders.po_number / an 850's businessNumber
  BOL: 'bol',               // routing_shipment.bol_number, and an 856's businessNumber
  INVOICE: 'invoice',       // an 810's businessNumber
  SO: 'so',                 // our sales order
  IF: 'if',                 // our fulfilment
}

export const MATCH_LABEL = {
  [MATCH.PO]: 'PO number',
  [MATCH.BOL]: 'BOL / ASN',
  [MATCH.INVOICE]: 'invoice',
  [MATCH.SO]: 'sales order',
  [MATCH.IF]: 'fulfilment',
}

/** Trim and upper-case, and nothing else.
 *  ⚠️ NO PREFIX STRIPPING. "NB1731242" and "1731242" are different strings and only
 *  one of them is a BOL; helpfully removing the prefix would match a PO that happens
 *  to share the digits. */
export const normalizeQuery = (q) => String(q || '').trim().toUpperCase()

/**
 * Collapse raw hits to one row per PO, keeping every reason it matched.
 *
 * ⚠️ ONE ROW PER PO, because a search for a BOL and a search for the PO should land in
 * the same place — the PO is the thing you act on. But the REASONS are kept as a list:
 * a number matching two different documents on one PO is information, not noise.
 */
export function groupSearchHits(hits = []) {
  const byPo = new Map()
  for (const h of hits) {
    const po = String(h.poNumber || '').trim()
    if (!po) continue
    if (!byPo.has(po)) byPo.set(po, { poNumber: po, partner: h.partner || null, matches: [] })
    const row = byPo.get(po)
    if (!row.partner && h.partner) row.partner = h.partner
    // Dedupe on field+value: the same BOL can arrive from routing_shipment AND from an
    // 856, and saying it twice tells the reader nothing.
    const key = `${h.field}:${h.value}`
    if (!row.matches.some((m) => `${m.field}:${m.value}` === key)) {
      row.matches.push({ field: h.field, value: h.value, label: MATCH_LABEL[h.field] || h.field })
    }
  }
  // A PO whose own number matched leads — an exact hit on the thing you searched for
  // outranks a hit on one of its documents.
  return [...byPo.values()].sort((a, b) => {
    const exact = (r) => (r.matches.some((m) => m.field === MATCH.PO) ? 0 : 1)
    return exact(a) - exact(b) || a.poNumber.localeCompare(b.poNumber)
  })
}

/** One line per result, naming why it matched. */
export function hitSummary(row) {
  if (!row) return null
  const own = row.matches.find((m) => m.field === MATCH.PO)
  if (own && row.matches.length === 1) return `PO ${row.poNumber}`
  const others = row.matches.filter((m) => m !== own).map((m) => `${m.label} ${m.value}`)
  return `PO ${row.poNumber} — matched on ${others.join(', ')}`
}
