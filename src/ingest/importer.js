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
} from './savedSearches.js'
import { buildPipeline } from '../model/pipeline.js'
import { deriveSource } from '../model/source.js'
import { loadOrders, loadFulfillments, loadInvoices, recordSnapshot, loadEdiFulfillments } from './loadToDb.js'
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
const LINE_LEVEL_MAPPERS = {
  ediFulfillments: { map: fromEdiFulfillments, load: loadEdiFulfillments },
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

  // One transaction for all writes: a bad row rolls back the whole upload
  // instead of leaving orders half-updated.
  const { nOrders, nFul, nInv } = await withTransaction(async (db) => {
    for (const [name, count, mtime] of snapshots) await recordSnapshot(name, count, mtime, db)
    for (const { key, rows } of lineLevel) await LINE_LEVEL_MAPPERS[key].load(rows, db)
    return {
      nOrders: await loadOrders(orders, db),
      nFul: await loadFulfillments(records, db),
      nInv: await loadInvoices(records, db),
    }
  })

  return { files: perFile, orders: nOrders, fulfillments: nFul, invoices: nInv }
}
