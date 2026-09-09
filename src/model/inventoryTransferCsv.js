// src/model/inventoryTransferCsv.js — the second file, moving what arrived out of China.
//
// ⚠️ IMPORT ORDER IS NOT A PREFERENCE. The Item Receipt goes FIRST. You cannot
// transfer units NetSuite does not yet believe it has, and a transfer imported
// first fails or moves nothing.
//
// ⚠️ AND THE ASYMMETRY WITH THE RECEIPT IS EASY TO GET BACKWARDS — I had it wrong
// in a comment before checking the original:
//
//   a whole PO the receipt skipped (already received in NetSuite)  → STILL TRANSFERS
//   a single LINE the receipt could not receive (no open line)     → does NOT transfer
//
// Those units are in China either way; the difference is whether NetSuite thinks it
// owns them. An already-received PO was received on a previous shipment and is now
// moving — excluding it strands the units in China forever. An unmatched line was
// never received, so there is nothing to move. See buildItemReceiptCsv Guard 1.

import { DEFAULT_NOTRACK_KEYWORDS, isNotTracked, toPoFull, slipDateToUs, containerLabel } from './itemReceiptCsv.js'

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'

/**
 * Where does this PO's stock end up?
 *
 * ⚠️ THIS FUNCTION USED TO END `return { location: 'Warehouse' }` AND IT MOVED 150
 * UNITS TO THE WRONG PLACE. On 2026-09-09, importing the Item Receipt pushed both
 * POs to status E, which dropped them out of the PO feed (see
 * PACKING_SLIP_PO_STATUS_CODES); regenerating the Transfer then found no lines,
 * fell through to that hardcoded default, and produced a file routing container
 * `11 Air ... 2026.9.7` to Warehouse instead of the Virtual Warehouse both POs
 * specify. The file imported cleanly. Nothing looked wrong.
 *
 * The comment above it already cited [[default-is-not-an-answer]] — and the code
 * beneath it named a real, plausible, wrong warehouse. A default is not an answer,
 * and "Warehouse" is the most answer-shaped default in this account.
 *
 * So an unknown destination is now NULL, and null BLOCKS the export. This file is
 * what physically moves inventory in the books; a plausible wrong answer is strictly
 * worse than no file.
 */
export function destinationFor(lines) {
  const withDest = (lines || []).find((l) => l.finalDestination)
  if (withDest) return { location: withDest.finalDestination, isFallback: false, unknown: false }
  // The PO's own location is still a guess, but it is at least DERIVED from the PO
  // rather than invented here. Reported, not blocking.
  const withLoc = (lines || []).find((l) => l.poLocation)
  if (withLoc) return { location: withLoc.poLocation, isFallback: true, unknown: false }
  return { location: null, isFallback: true, unknown: true }
}

/**
 * Build the Inventory Transfer CSV.
 *
 * @param container       the parsed slip
 * @param poLinesByPo     Map(PO → Map(sku → line)) from indexPoLines
 * @param unmatchedLines  from the Item Receipt — the ONLY thing excluded here
 */
export function buildInventoryTransferCsv(container, poLinesByPo = new Map(), unmatchedLines = [], { notrack = DEFAULT_NOTRACK_KEYWORDS } = {}) {
  const label = containerLabel(container)
  const date = slipDateToUs(container.containerDate)

  const headers = ['External ID', 'Memo', 'Date', 'From Location', 'To Location',
                   'PO #', 'Style Number', 'Color', 'Item', 'Quantity', 'Purchase Order']
  const rows = []
  const excluded = []
  const missingDestinations = []
  const unknownDestinations = []
  const heldBack = []

  // Keyed `PO|SKU` — a specific line, never a whole PO.
  const skip = new Set((unmatchedLines || []).map((l) => `${toPoFull(l.poNumber)}|${l.sku}`))

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
    const lines = [...(poLinesByPo.get(po)?.values() ?? [])]
    const { location, isFallback, unknown } = destinationFor(lines)
    if (isFallback) {
      missingDestinations.push({
        poNumber: po,
        fallbackLocation: location,
        unknown,
        units: [...shipped.values()].reduce((a, b) => a + b, 0),
        reason: unknown
          ? 'no destination at all — the PO is not in the PO feed (already received? check its status)'
          : "using the PO's own location, not its Final Naghedi Destination",
      })
      if (unknown) unknownDestinations.push(po)
    }

    // ⚠️ NOTE WHAT IS NOT HERE: no check that the PO was on the receipt. An
    // already-received PO has no open lines, so `lines` is empty and the
    // destination falls back — but its units still transfer, because they are in
    // China and they are moving.
    const poDigits = po.replace(/^PO/i, '')
    const externalId = `EXT-${label}${poDigits}`
    for (const [sku, qty] of [...shipped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (skip.has(`${po}|${sku}`)) {
        heldBack.push({ poNumber: po, sku, qty, reason: 'not received — no open line on the PO' })
        continue
      }
      rows.push([
        externalId, label, date, 'China', location ?? '', poDigits,
        // ⚠️ Style and Colour are deliberately EMPTY. NetSuite derives both from the
        // item, and supplying them invites a mismatch between what we say and what
        // the item record says — a disagreement the import resolves silently.
        '', '',
        sku, qty, `Purchase Order #${po}`,
      ])
    }
  }

  return {
    csv: toCsv([headers, ...rows]),
    filename: `Inventory Transfer - ${label}.csv`,
    rows: rows.length,
    poCount: byPoTotals.size,
    excluded,
    // ⚠️ Non-empty means a transfer is about to move stock to a guessed location.
    // Not blocking — the file is still correct for everything else — but it must be
    // shown, because nothing downstream will ever mention it again.
    missingDestinations,
    heldBack,
    // ⚠️ AN UNKNOWN DESTINATION BLOCKS THE FILE. Not a warning — the transfer is the
    // document that moves the stock, and there is no honest value to put in the
    // column. A PO landing here is almost always one the Item Receipt just pushed
    // out of the feed's status scope, so the fix is upstream, not in this file.
    blocked: unknownDestinations.length > 0,
    unknownDestinations,
  }
}

/**
 * Both files for one container, in the order they must be imported.
 *
 * ⚠️ The receipt is built first because the transfer NEEDS its `unmatchedLines`.
 * That is a real dependency, not sequencing for tidiness.
 */
export function buildNetsuiteExport(container, poLines = [], opts = {}) {
  // Imported here rather than at the top so the two builders stay independently
  // testable and neither pulls the other into a caller that only wants one.
  return import('./itemReceiptCsv.js').then(({ buildItemReceiptCsv, indexPoLines }) => {
    const itemReceipt = buildItemReceiptCsv(container, poLines, opts)
    const { byPo } = indexPoLines(poLines)
    const transfer = buildInventoryTransferCsv(container, byPo, itemReceipt.unmatchedLines, opts)
    return { itemReceipt, transfer, importOrder: ['itemReceipt', 'transfer'] }
  })
}
