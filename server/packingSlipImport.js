// server/packingSlipImport.js — the factory slip screen's two calls.
//
// Nima, 2026-09-09, on why this moved out of Naghedi-Warehouse: "the more we think
// of it the more it seems to belong here. we can check the import to make sure
// nothing weird is happening we can track the shipment we can make sure were
// receiving it on time we can have a record to go back against ... also if we we
// still have the information of whats in what box if we ever eneded to do a look up
// of an item by what container and box it was teh app would be able to help".
//
// ⚠️ PREVIEW AND COMMIT ARE SEPARATE CALLS, AND THAT IS THE POINT. The whole reason
// the translation moved here is so the numbers can be LOOKED AT before anything is
// stored or imported. A single "upload and go" endpoint would reproduce the app it
// replaced: a generator that emits two CSVs and forgets.
//
// ⚠️ THE PARSE HAPPENS HERE, NOT IN THE BROWSER. `xlsx` stays a server dependency
// (see src/ingest/packingSlipFile.js) — the client sends bytes and gets back numbers.

import { readPackingSlip } from '../src/ingest/packingSlipFile.js'
import { buildNetsuiteExport } from '../src/model/inventoryTransferCsv.js'
import { containerLabel, suggestContainerFields } from '../src/model/containerIdentity.js'
import { slipRevision } from '../src/model/packingSlipRevision.js'
import { savePackingSlip } from '../src/ingest/packingSlipLoad.js'
import { warehousePoLineSql, mapWarehousePoLines } from '../src/ingest/warehouseFeed.js'
import { runSuiteQL } from '../src/ingest/netsuiteApi.js'
import { pool } from '../src/db.js'

/** The live open-PO lines both CSVs are built against. */
async function livePoLines() {
  const raw = await runSuiteQL(warehousePoLineSql())
  const { rows } = mapWarehousePoLines(raw.rows || raw)
  return rows
}

const toBytes = (base64) => new Uint8Array(Buffer.from(String(base64 || ''), 'base64'))

/**
 * Parse a slip, build both CSVs, and report everything that looks wrong — storing
 * nothing.
 *
 * @param filename       for provenance and the field suggestion
 * @param base64         .xlsx bytes, or omit and pass `text` for a .csv
 * @param containerNum   the bare number; falls back to the filename guess
 * @param containerDate  as printed, "2026.9.7"
 */
export async function previewPackingSlip({ filename = null, base64 = null, text = null, containerNum = null, containerDate = null } = {}) {
  if (!base64 && !text) throw new Error('base64 or text is required')
  const suggested = suggestContainerFields(filename || '')
  const num = String(containerNum ?? suggested.containerNum ?? '').trim()
  const date = containerDate ?? suggested.containerDate
  if (!num) throw new Error('containerNum is required (the bare number off the slip, e.g. "55")')

  const container = readPackingSlip(text ?? toBytes(base64), { containerNum: num, containerDate: date })
  const label = containerLabel(container)

  const poLines = await livePoLines()
  // ⚠️ Narrowed to this slip's POs on purpose. buildItemReceiptCsv emits a
  // Receive = F row for every OTHER still-open line on a PO it touches, and handing
  // it the whole open book would not change that — but it makes the guard counts
  // ("unknown PO") mean "not open in NetSuite" rather than "not in the slice I sent".
  const wanted = new Set((container.poNumbers || []).map((p) => `PO${String(p).replace(/^PO/i, '')}`.toUpperCase()))
  const mine = poLines.filter((l) => wanted.has(`PO${String(l.po_number).replace(/^PO/i, '')}`.toUpperCase()))

  const { itemReceipt, transfer, importOrder } = await buildNetsuiteExport(container, mine)

  // What a commit would say about a container we already hold.
  const { rows: [stored] } = await pool.query(
    'SELECT container_label, unit_count, carton_count, po_numbers FROM packing_slip WHERE container_label = $1',
    [label],
  )
  const revision = slipRevision(stored, container, { sourceFilename: filename })

  return {
    containerLabel: label,
    containerNum: num,
    containerDate: date,
    suggested,
    sourceFilename: filename,
    format: container.format,
    unitCount: container.unitCount,
    cartonCount: container.cartonCount,
    poNumbers: container.poNumbers,
    skuTotals: container.skuTotals,
    // ⚠️ The carton map is returned even though NEITHER CSV uses it. It is the half
    // that answers "which box was this in", and the import screen is the only place
    // anyone will ever see it before it disappears into the database.
    cartons: container.cartons,
    skipped: container.skipped || [],
    revision,
    importOrder,
    itemReceipt: csvSummary(itemReceipt),
    transfer: csvSummary(transfer),
    // ⚠️ ONE PLACE THAT SAYS WHETHER THE FILES MAY BE USED. buildItemReceiptCsv
    // blocks on an over-receive or a duplicate SKU; both put units on a PO line that
    // cannot hold them, and both are silent in NetSuite until a count disagrees
    // weeks later. The screen must not offer a download while this is true.
    blocked: itemReceipt.blocked,
  }
}

/** Everything about a generated file except the caller-facing CSV text itself. */
const csvSummary = (r) => ({
  csv: r.csv,
  filename: r.filename,
  rows: r.rows,
  poCount: r.poCount,
  excluded: r.excluded,
  overReceives: r.overReceives ?? [],
  unknownPOs: r.unknownPOs ?? [],
  unmatchedLines: r.unmatchedLines ?? [],
  duplicateSkus: r.duplicateSkus ?? [],
  excludedPOs: r.excludedPOs ?? [],
  missingDestinations: r.missingDestinations ?? [],
  heldBack: r.heldBack ?? [],
  blocked: r.blocked ?? false,
})

/**
 * Store the slip.
 *
 * ⚠️ RE-PARSED FROM THE BYTES, not trusted from the preview. The alternative is
 * accepting a client-supplied container as fact, which would let an edited preview
 * store totals no document ever said — and the whole value of keeping the slip is
 * that "1,439 units" is attributable to a document.
 *
 * ⚠️ `blocked` DOES NOT STOP THE SAVE, and that asymmetry is deliberate. It blocks
 * the CSVs, because those would put units on a PO line that cannot hold them. The
 * slip itself is a document that arrived; refusing to record it would leave the one
 * container someone needs to investigate as the one container with no record.
 */
export async function commitPackingSlip(body = {}) {
  const preview = await previewPackingSlip(body)
  const container = readPackingSlip(body.text ?? toBytes(body.base64), {
    containerNum: preview.containerNum,
    containerDate: preview.containerDate,
  })
  const saved = await savePackingSlip(container, { sourceFilename: body.filename ?? null })
  return { ...saved, blocked: preview.blocked }
}
