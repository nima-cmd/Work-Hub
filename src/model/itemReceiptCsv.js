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

// The container's NetSuite label. Re-exported so callers building a receipt do not
// have to know which module owns the naming rule — it is the same identity.
export { containerLabel, toNsDateLabel } from './containerIdentity.js'
import { containerLabel } from './containerIdentity.js'

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
    // ⚠️ A MANUALLY CLOSED LINE HAS NOTHING REMAINING, WHATEVER THE ARITHMETIC SAYS.
    // A line closed short — 60 ordered, 0 received, closed — computes 60 remaining
    // and is not receivable at all. Treating it as open emits a Receive = F row for
    // it, which is the case that breaks the import ("Unable to find a matching line
    // for sublist expense"), and it would also miss an over-receive against it.
    // `line_closed` comes from tl.isclosed and was already carried by
    // mapWarehousePoLines; I simply was not reading it until the pipeline diff
    // against Naghedi-Warehouse showed it computes remaining the same way.
    const closed = l.closed ?? l.line_closed ?? false
    const rec = {
      sku,
      orderLine: Number(l.orderLine ?? l.item_line_position) || null,
      ordered,
      received,
      closed: !!closed,
      remaining: closed ? 0 : Math.max(0, ordered - received),
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
 * @param opts.acceptExcess  deliberately receive MORE than the PO line has left, when
 *   the factory genuinely shipped extra. It never lifts the duplicate block — see
 *   `kind` below. Off by default: an over-receive must be a decision.
 *
 *   ⚠️ IT TAKES A LIST OF `PO|SKU` KEYS; `true` (every over-receive on the container)
 *   survives only for the callers that predate the decision layer. Nima, 2026-09-14:
 *   "we would like the ability to choose what to do". One boolean said yes to every
 *   line at once, so a container with a deliberate +1 on one PO and a genuine mistake
 *   on another was accepted wholesale by a single click. A resolution is per line, and
 *   this is the half of it that reaches the file.
 *
 * @returns { csv, filename, rows, poCount, overReceives, blockingOverReceives,
 *            excessShipped, acceptedExcess, unknownPOs, unmatchedLines,
 *            duplicateSkus, excluded, excludedPOs, blocked }
 */
export function buildItemReceiptCsv(container, poLines = [], { notrack = DEFAULT_NOTRACK_KEYWORDS, acceptExcess = false } = {}) {
  const acceptedKeys = Array.isArray(acceptExcess) ? new Set(acceptExcess) : null
  const isAccepted = (o) => (acceptedKeys ? acceptedKeys.has(`${o.poNumber}|${o.sku}`) : acceptExcess === true)
  const label = containerLabel(container)
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
    // closed. Its rows are dropped from the RECEIPT.
    //
    // ⚠️ BUT IT MUST STILL TRANSFER, and this asymmetry is easy to get backwards —
    // I had this comment wrong before checking. Units on an already-received PO ARE
    // in China and ARE moving, so excluding the PO from the Transfer would strand
    // them in China forever. Only an unmatched LINE (a SKU with no open line, held
    // for inspection) is kept off the Transfer, because those units were never
    // received and cannot move. `excludedPOs` is reported for the operator, NOT fed
    // to the Transfer as an exclusion. See buildInventoryTransferCsv.
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
          // ⚠️ TWO DIFFERENT THINGS LOOK IDENTICAL HERE, AND ONLY ONE IS DANGEROUS.
          //
          // Nima, 2026-09-11: "can we also receive the extra unit on the ir and use
          // it on the transfer and keep the PO the same showing the overrage in
          // receipt." Yes — but only for the benign shape.
          //
          //   remaining > 0 and shipped slightly over  -> the factory made one extra.
          //                                               Receiving it records what
          //                                               physically arrived and
          //                                               leaves the PO honest at
          //                                               "received 101 of 100".
          //
          //   remaining === 0                          -> the line has nothing left,
          //                                               which is what EVERY line
          //                                               looks like once this
          //                                               container's receipt has
          //                                               already been imported. That
          //                                               is a DUPLICATE, and
          //                                               importing it again doubles
          //                                               the stock silently.
          //
          // PO1747 on container "59 cartons LCL to LA" is the first shape: 53
          // remaining, 54 shipped, one unit over. The four over-receives of 2026-09-08
          // were the second, and are why this block exists at all.
          kind: line.remaining > 0 ? 'excess-shipped' : 'nothing-remaining',
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
    // Reported so the operator knows these POs are missing from the receipt.
    // ⚠️ NOT a Transfer exclusion — see Guard 1.
    excludedPOs: [...excludedPOs],
    // ⚠️ ONLY THE DUPLICATE SHAPE BLOCKS OUTRIGHT NOW.
    //
    // `nothing-remaining` is indistinguishable from re-importing a container whose
    // receipt already landed, and that doubles stock silently — it blocks, always,
    // and there is no option to override it.
    //
    // `excess-shipped` means the factory sent more than was ordered against a line
    // that still had room. Receiving it is the honest record of what arrived, so it
    // blocks by DEFAULT but can be accepted deliberately with `acceptExcess: true`.
    // The PO stays as it was and reads "received 101 of 100", which is true.
    blockingOverReceives: overReceives.filter((o) => o.kind === 'nothing-remaining'),
    excessShipped: overReceives.filter((o) => o.kind === 'excess-shipped'),
    acceptedExcess: overReceives.filter((o) => o.kind === 'excess-shipped' && isAccepted(o)),
    blocked: overReceives.some((o) => o.kind === 'nothing-remaining')
      || overReceives.some((o) => o.kind === 'excess-shipped' && !isAccepted(o))
      || duplicateSkus.length > 0,
  }
}
