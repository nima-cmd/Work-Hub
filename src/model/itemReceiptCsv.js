// src/model/itemReceiptCsv.js — a packing slip becomes a NetSuite Item Receipt.
//
// ⚠️ EVERY RULE BELOW WAS PAID FOR BY A FAILED IMPORT. Nima, 2026-09-09: "we also
// want to make sure were taking into accoutn the way we make the item receipt
// import as that took a long while to get right." None of it is recoverable from
// the CSV format, so each guard says what it costs to remove.
// The long form is in docs/packing-slip-to-netsuite.md.
//
// Ported from Naghedi-Warehouse `src/services/exportGenerator.js`, with the PO line
// data coming from NetSuite live instead of a manual CSV parked in localStorage.

/** Charms, stickers and hangtags are not inventory — they never reach a receipt. */
export const DEFAULT_NOTRACK_KEYWORDS = ['sticker', 'hangtag']

export const isNotTracked = (sku, keywords = DEFAULT_NOTRACK_KEYWORDS) =>
  !!sku && keywords.some((k) => k && String(sku).toLowerCase().includes(String(k).toLowerCase()))

/** "1785" → "PO1785". The slip writes digits; NetSuite writes the prefix. */
export const toPoFull = (po) => {
  const s = String(po ?? '').trim()
  return /^po/i.test(s) ? s.toUpperCase() : `PO${s}`
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'

/** "2026.9.7" or "2026-09-07" → "09/07/2026", which is what the import expects. */
export function slipDateToUs(raw) {
  const p = String(raw ?? '').trim().split(/[.\-/]/)
  if (p.length < 3) return ''
  const [y, m, d] = p
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`
}

/**
 * Index the live PO lines by PO and SKU.
 *
 * ⚠️ `orderLine` IS `item_line_position`, NEVER `line_seq`. The Item Receipt's
 * "Order Line" counts positions among ITEM lines only — an expense or tax line on
 * the PO shifts every sequence number after it, so using line_seq points the
 * receipt at the wrong line. See isItemLine/mapWarehousePoLines in
 * src/ingest/warehouseFeed.js, where that distinction is already drawn.
 */
export function indexPoLines(poLines = []) {
  const byPo = new Map()
  const dupes = new Map()
  for (const l of poLines) {
    const po = toPoFull(l.poNumber ?? l.po_number)
    const sku = String(l.sku ?? '').trim()
    if (!po || !sku) continue
    const entry = (byPo.get(po) ?? new Map())
    const ordered = Number(l.ordered ?? l.qty_ordered) || 0
    const received = Number(l.received ?? l.qty_received) || 0
    const rec = {
      sku,
      orderLine: Number(l.orderLine ?? l.item_line_position) || null,
      ordered,
      received,
      remaining: Math.max(0, ordered - received),
      finalDestination: l.finalDestination ?? l.final_destination ?? null,
      poLocation: l.poLocation ?? l.po_location ?? null,
      vendor: l.vendor ?? null,
    }
    if (entry.has(sku)) {
      // ⚠️ ONE SKU ON TWO LINES CANNOT BE TARGETED. This index is keyed PO+SKU so it
      // cannot represent both, and neither Order Line nor match-by-item can reliably
      // pick the right one. Flagged for manual handling rather than guessed at.
      const d = dupes.get(po) ?? new Set()
      d.add(sku)
      dupes.set(po, d)
    } else entry.set(sku, rec)
    byPo.set(po, entry)
  }
  return { byPo, duplicateSkus: [...dupes.entries()].map(([po, s]) => ({ poNumber: po, skus: [...s] })) }
}

/**
 * Build the Item Receipt CSV.
 *
 * @param container the parsed slip (needs containerNum, containerDate, skuTotals)
 * @param poLines   live PO lines from NetSuite (see indexPoLines)
 * @returns { csv, filename, rows, poCount, overReceives, unknownPOs,
 *            unmatchedLines, duplicateSkus, excluded, excludedPOs, blocked }
 */
export function buildItemReceiptCsv(container, poLines = [], { notrack = DEFAULT_NOTRACK_KEYWORDS } = {}) {
  const label = String(container.containerNum ?? '')
  const date = slipDateToUs(container.containerDate)
  const { byPo, duplicateSkus } = indexPoLines(poLines)

  const headers = ['External ID', 'Created From', 'Date', 'Memo',
                   'Item', 'Order Line', 'Quantity', 'Receive', 'To Location']
  const rows = []
  const overReceives = []
  const unknownPOs = []
  const unmatchedLines = []
  const excluded = []
  const excludedPOs = new Set()

  // Slip lines grouped by PO, not-tracked items dropped and reported.
  const byPoTotals = new Map()
  for (const l of container.skuTotals || []) {
    if (isNotTracked(l.sku, notrack)) { excluded.push({ sku: l.sku, units: l.units, poNumber: l.poNumber }); continue }
    const po = toPoFull(l.poNumber)
    const m = byPoTotals.get(po) ?? new Map()
    m.set(l.sku, (m.get(l.sku) ?? 0) + l.units)
    byPoTotals.set(po, m)
  }

  for (const po of [...byPoTotals.keys()].sort()) {
    const shipped = byPoTotals.get(po)
    const lines = byPo.get(po)

    // ⚠️ GUARD 1 — PO NOT OPEN IN NETSUITE. No order lines and no "Created From" to
    // build against, and it almost always means the PO is already fully received or
    // closed. Its rows are dropped entirely and the PO is fed to the Transfer's
    // exclusion list so both files describe the same shipment.
    if (!lines || lines.size === 0) {
      unknownPOs.push({
        poNumber: po,
        skuCount: shipped.size,
        units: [...shipped.values()].reduce((a, b) => a + b, 0),
      })
      excludedPOs.add(po)
      continue
    }

    // ⚠️ GUARD 2 — A SHIPPED SKU WITH NO OPEN LINE IS NOT RECEIVABLE. Already
    // received, wrong PO, or a size never ordered. Left off the file and flagged;
    // inventing a line would receive against something that is not there.
    const toReceive = []
    for (const [sku, qty] of shipped) {
      const line = lines.get(sku)
      if (line) toReceive.push({ sku, qty, orderLine: line.orderLine, receive: 'T' })
      else unmatchedLines.push({ poNumber: po, sku, qty })
    }

    // ⚠️ THE F ROWS ARE MANDATORY, AND THIS IS THE MOST EXPENSIVE LESSON IN THE FILE.
    // Without a Receive = F row for every OTHER still-open line, NetSuite
    // AUTO-RECEIVES all remaining open lines — pulling in units from shipments that
    // have not left the factory.
    //
    // ⚠️ BUT A FULLY-RECEIVED LINE MUST BE EXCLUDED FROM THEM. It has nothing left to
    // match, and the import dies on "Unable to find a matching line for sublist
    // expense". Safe, because a closed line has no remaining balance to protect.
    const notShipped = [...lines.values()]
      .filter((l) => !shipped.has(l.sku))
      .filter((l) => l.remaining > 0)
      .map((l) => ({ sku: l.sku, qty: 0, orderLine: l.orderLine, receive: 'F' }))

    // ⚠️ T AND F SORT TOGETHER AS ONE SEQUENCE, ascending by order line. NetSuite's
    // Standard Item Receipt form ANCHORS the receipt on the first CSV row it sees,
    // so line 1 has to come first when it is still open. Two separate blocks — all
    // the T rows then all the F rows — anchors it on whatever shipped first.
    const all = [...toReceive, ...notShipped].sort(
      (a, b) => (Number(a.orderLine) || 9999) - (Number(b.orderLine) || 9999),
    )

    // ⚠️ OVER-RECEIVE IS MEASURED AGAINST REMAINING, NOT GROSS ORDERED. A PO that is
    // half received still has its full ordered quantity, so comparing against that
    // lets a second shipment of the same units through unnoticed.
    for (const { sku, qty } of toReceive) {
      const line = lines.get(sku)
      if (qty > line.remaining) {
        overReceives.push({
          poNumber: po, sku, shipped: qty, remaining: line.remaining,
          ordered: line.ordered, received: line.received, excess: qty - line.remaining,
        })
      }
    }

    const externalId = `EXT-IR-${label}${po.replace(/^PO/i, '')}`
    // The "Name" reference type resolves the full display name, not the bare number.
    const createdFrom = `Purchase Order #${po}`
    for (const { sku, qty, orderLine, receive } of all) {
      rows.push([externalId, createdFrom, date, label, sku, orderLine, qty, receive, 'China'])
    }
  }

  return {
    csv: toCsv([headers, ...rows]),
    filename: `Item Receipts - ${label}.csv`,
    rows: rows.length,
    poCount: byPoTotals.size,
    overReceives,
    unknownPOs,
    unmatchedLines,
    duplicateSkus,
    excluded,
    excludedPOs: [...excludedPOs],
    // ⚠️ AN OVER-RECEIVE OR A DUPLICATE SKU BLOCKS THE EXPORT. Both put units on a
    // PO line that cannot hold them, and both are silent in NetSuite until a count
    // disagrees weeks later. The caller must not offer the file for download while
    // this is true.
    blocked: overReceives.length > 0 || duplicateSkus.length > 0,
  }
}
