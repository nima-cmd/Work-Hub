// src/ingest/importer.js — the shared import path used by the in-app Import
// button (and reusable by the CLI). Accepts uploaded CSV files, auto-detects
// each one, maps → pipeline → upserts into Postgres.
//
// Import your exports *together* (all in one go) so the pipeline sees the whole
// picture and computes each order's furthest stage correctly.

import { parseCsv } from './csv.js'
import { detectSource } from './detect.js'
import {
  fromOpenSalesOrders,
  fromFulfillmentPipeline,
  fromUnpackedFulfillments,
  fromPendingOrders,
  fromInvoicedPending,
  fromEdiFulfillments,
  fromPoReceiving,
  fromOcPipeline,
  fromEdiPackagesVolume,
} from './savedSearches.js'
import { buildPipeline } from '../model/pipeline.js'
import { deriveSource } from '../model/source.js'
import {
  loadOrders, loadFulfillments, loadInvoices, recordSnapshot, loadEdiFulfillments,
  loadPurchaseOrders, prunePurchaseOrders, loadOrderConfirmations, pruneOrderConfirmations,
  pruneOrders, stampApprovedForShipping, stampShippedValue, clearDepartedCustody,
  loadEdiPackages,
} from './loadToDb.js'
import { withTransaction } from '../db.js'

// The two current searches, plus the three legacy shapes (still accepted on
// upload so an old export doesn't silently fail to import).
const MAPPERS = {
  openSalesOrders: fromOpenSalesOrders,
  fulfillmentPipeline: fromFulfillmentPipeline,
  unpackedFulfillments: fromUnpackedFulfillments,
  pendingOrders: fromPendingOrders,
  invoicedPending: fromInvoicedPending,
}

// Line-level sources that don't flow through buildPipeline (keyed on their own
// natural key, not SO#) — handled separately from MAPPERS/records below.
// `prune` (where present) mirrors scripts/ingest.js: each export is the full
// open set for its source, so rows that vanished from it were closed in
// NetSuite and get deleted — but only when that file is actually part of the
// upload (an orders-only upload never touches PO/OC data).
const LINE_LEVEL_MAPPERS = {
  ediFulfillments: { map: fromEdiFulfillments, load: loadEdiFulfillments },
  poReceiving: { map: fromPoReceiving, load: loadPurchaseOrders, prune: prunePurchaseOrders },
  ocPipeline: { map: fromOcPipeline, load: loadOrderConfirmations, prune: pruneOrderConfirmations },
  // Routing feed — per-PO-DC packages. No prune: a routed PO drops off the
  // export but its numbers don't change, and the shipment rows are the durable
  // record (see edi_packages comment in schema.sql).
  ediPackagesVolume: { map: fromEdiPackagesVolume, load: loadEdiPackages },
}

// files: [{ name, text, lastModified }]
export async function importBatch(files) {
  const records = []
  const perFile = []
  const lineLevel = [] // [{ key, rows }] for sources in LINE_LEVEL_MAPPERS

  const snapshots = []
  for (const f of files) {
    const rows = parseCsv(f.text)
    const headers = rows.length ? Object.keys(rows[0]) : []
    const key = detectSource(headers)
    if (!key) {
      perFile.push({ name: f.name, recognized: false, rows: rows.length })
      continue
    }
    if (LINE_LEVEL_MAPPERS[key]) {
      const mapped = LINE_LEVEL_MAPPERS[key].map(rows)
      lineLevel.push({ key, rows: mapped })
      snapshots.push([key, mapped.length, f.lastModified ? new Date(f.lastModified) : null])
      perFile.push({ name: f.name, recognized: true, type: key, rows: mapped.length })
      continue
    }
    const mapped = MAPPERS[key](rows)
    records.push(...mapped)
    // Key the snapshot by detected source-type, not the uploaded filename.
    snapshots.push([key, mapped.length, f.lastModified ? new Date(f.lastModified) : null])
    perFile.push({ name: f.name, recognized: true, type: key, rows: mapped.length })
  }

  const orders = buildPipeline(records, { today: new Date() })
  for (const o of orders) o.source = deriveSource(o.customer, o.location)

  // Same rule as scripts/ingest.js: the order-pipeline export is the master
  // list of open orders, so when it's part of this upload, orders that no
  // longer appear in it were closed/shipped in NetSuite and get pruned.
  // Without this, in-app imports (now the primary path via Bugs' task) would
  // let closed orders linger where the CLI ingest would have removed them.
  const hasMaster = snapshots.some(([key]) => key === 'openSalesOrders')

  // One transaction for all writes: a bad row rolls back the whole upload
  // instead of leaving orders half-updated.
  const { nOrders, nFul, nInv, nPruned } = await withTransaction(async (db) => {
    for (const [name, count, mtime] of snapshots) await recordSnapshot(name, count, mtime, db)
    for (const { key, rows } of lineLevel) {
      await LINE_LEVEL_MAPPERS[key].load(rows, db)
      if (LINE_LEVEL_MAPPERS[key].prune && rows.length) await LINE_LEVEL_MAPPERS[key].prune(rows, db)
    }
    const nOrders = await loadOrders(orders, db)
    const nFul = await loadFulfillments(records, db)
    const nInv = await loadInvoices(records, db)
    await stampApprovedForShipping(records, db) // launch-day ledger for the Launch Bay delay warning
    await stampShippedValue(records, db) // snapshot shipped $ for the header credits
    await clearDepartedCustody(records, db) // close custody + prune box rows for IFs that shipped
    const nPruned = hasMaster ? await pruneOrders(orders.map((o) => o.soNumber), db) : 0
    return { nOrders, nFul, nInv, nPruned }
  })

  return { files: perFile, orders: nOrders, fulfillments: nFul, invoices: nInv, pruned: nPruned }
}
