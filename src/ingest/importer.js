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
  fromUnpackedFulfillments,
  fromPendingOrders,
  fromInvoicedPending,
} from './savedSearches.js'
import { buildPipeline } from '../model/pipeline.js'
import { deriveSource } from '../model/source.js'
import { loadOrders, loadFulfillments, loadInvoices, recordSnapshot } from './loadToDb.js'

const MAPPERS = {
  openSalesOrders: fromOpenSalesOrders,
  unpackedFulfillments: fromUnpackedFulfillments,
  pendingOrders: fromPendingOrders,
  invoicedPending: fromInvoicedPending,
}

// files: [{ name, text, lastModified }]
export async function importBatch(files) {
  const records = []
  const perFile = []

  for (const f of files) {
    const rows = parseCsv(f.text)
    const headers = rows.length ? Object.keys(rows[0]) : []
    const key = detectSource(headers)
    if (!key) {
      perFile.push({ name: f.name, recognized: false, rows: rows.length })
      continue
    }
    const mapped = MAPPERS[key](rows)
    records.push(...mapped)
    await recordSnapshot(f.name, mapped.length, f.lastModified ? new Date(f.lastModified) : null)
    perFile.push({ name: f.name, recognized: true, type: key, rows: mapped.length })
  }

  const orders = buildPipeline(records, { today: new Date() })
  for (const o of orders) o.source = deriveSource(o.customer)

  const nOrders = await loadOrders(orders)
  const nFul = await loadFulfillments(records)
  const nInv = await loadInvoices(records)

  return { files: perFile, orders: nOrders, fulfillments: nFul, invoices: nInv }
}
