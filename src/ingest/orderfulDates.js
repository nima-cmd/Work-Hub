// src/ingest/orderfulDates.js
// Pure X12 parsing for an 850's ship-window dates — no DB, no network, so the
// model tests can import it directly. orderful.js re-exports these.
//
// The dates live in the DTM (date/time reference) segment of the 850's own
// transaction set, not on the list endpoint. But which X12 qualifier carries
// them is PARTNER-DEPENDENT — verified against real 850 bodies 2026-07-28
// (2+ each). Every partner uses the SAME header location, just a different code
// from one of two semantic families:
//   start  (window opens): 064 Do-Not-Deliver-Before · 037 Ship-Not-Before · 010 Requested-Ship
//   cancel (window closes): 001 Cancel-After · 063 Do-Not-Deliver-After
// Observed: Bloomingdale's 064/001 · Nordstrom 037/001 · Shopbop 064/063 ·
// Saks 010/001 · Neiman 037/063. So instead of one hardcoded qualifier per role
// we take the first present in each family's priority order — keeps the original
// 064/001 as the defaults, covers the others, and degrades gracefully for any
// future partner using a standard qualifier.

export const START_QUALIFIERS = ['064', '037', '010']
export const CANCEL_QUALIFIERS = ['001', '063']

const ediDate = (yyyymmdd) => (yyyymmdd ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null)

export function extractPoDates(message) {
  const dtms = message?.transactionSets?.[0]?.dateTimeReference || []
  const firstOf = (quals) => {
    for (const q of quals) {
      const hit = dtms.find((d) => d.dateTimeQualifier === q)?.date
      if (hit) return hit
    }
    return null
  }
  return { shipNotBefore: ediDate(firstOf(START_QUALIFIERS)), cancelAfter: ediDate(firstOf(CANCEL_QUALIFIERS)) }
}

// ── 850 line items (for version diffing) ─────────────────────────────────────
// The PO's lines live in transactionSets[0].PO1_loop[]; each entry's
// baselineItemData[0] carries the qty/price plus several productServiceID pairs
// keyed by a qualifier (verified on real Nordstrom 850s 2026-07-29):
//   UP = UPC · VA = vendor style (e.g. SN04023LD) · IN = buyer item · Ua/others.
// We key each line by the VENDOR STYLE (VA) when present, else the UPC — that's
// the identity that stays stable across a re-send, so a diff lines up SKUs
// rather than reshuffling by array position. Pure: no DB, no network.
function productIds(baseline) {
  // Collect every (qualifier, id) pair regardless of the numeric suffix Orderful
  // appends (productServiceIDQualifier, ...Qualifier1, ...Qualifier2, …).
  const ids = {}
  for (const key of Object.keys(baseline)) {
    const m = key.match(/^productServiceIDQualifier(\d*)$/)
    if (!m) continue
    const qual = baseline[key]
    const val = baseline[`productServiceID${m[1]}`]
    if (qual && val != null) ids[qual] = String(val)
  }
  return ids
}

export function extractPoLines(message) {
  const loop = message?.transactionSets?.[0]?.PO1_loop || []
  return loop.map((entry, i) => {
    const b = (entry.baselineItemData || [])[0] || {}
    const ids = productIds(b)
    const qty = Number(b.quantity ?? b.quantityOrdered ?? 0) || 0
    const unitPrice = b.unitPrice != null && b.unitPrice !== '' ? Number(b.unitPrice) : null
    return {
      line: b.assignedIdentification || String(i + 1),
      sku: ids.VA || ids.UP || ids.IN || `line${i + 1}`, // stable identity across re-sends
      style: ids.VA || null,
      upc: ids.UP || null,
      qty,
      unitPrice,
    }
  })
}

// Rollups cached alongside the raw lines for cheap "did anything change" checks.
export function summarizePoLines(lines = []) {
  return { totalUnits: lines.reduce((s, l) => s + (l.qty || 0), 0), lineCount: lines.length }
}
