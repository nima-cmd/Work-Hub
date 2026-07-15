// src/ingest/detect.js — figure out which saved search a CSV came from by its
// header columns, so the Import button can accept any export and route it to the
// right mapper (no need to name files a specific way).
//
// The app now runs on TWO consolidated searches (down from four):
//   - orderPipeline      (SO-based)  → demand, approval, invoice, ship/cancel dates
//   - fulfillmentPipeline (IF-based) → Picked/Packed item fulfillments
// The three legacy shapes are still detected so old exports keep working.

export function detectSource(headers) {
  const H = new Set((headers || []).map((h) => h.trim()))
  const has = (...cols) => cols.every((c) => H.has(c))

  // Consolidated IF-based fulfillment search: keyed on "Created From" (the SO
  // link) without order-level quantity columns.
  if (H.has('Maximum of Created From') && !H.has('Sum of Quantity')) return 'fulfillmentPipeline'

  // Legacy fulfillment shapes (check before openSalesOrders — some share columns)
  if (has('Days Pending', 'IF-Packed-Status')) return 'pendingOrders'
  if (H.has('Memo (IF)') || has('Created From', 'Actual Ship Date')) return 'unpackedFulfillments'

  // Consolidated SO-based order pipeline (also matches the legacy open-SO search)
  if (H.has('Sum of Quantity') || H.has('Maximum of Company Name')) return 'openSalesOrders'

  if (has('SO', 'Inv')) return 'invoicedPending'

  // The 856 ASN search (Nima's "NetSuite Fulfillments" export for Airtable) —
  // BOL is the join key from an Orderful 856 back to its originating PO.
  if (has('PO DC Identifier', 'Maximum of BOL')) return 'ediFulfillments'

  return null // unrecognized — the UI will report this back
}

export const SOURCE_LABELS = {
  openSalesOrders: 'Warehouse Order Pipeline',
  fulfillmentPipeline: 'Warehouse Fulfillment Pipeline',
  ediFulfillments: 'EDI 856 ASN / BOL search',
  // legacy (no longer required, still recognized on upload)
  unpackedFulfillments: 'Item Fulfilment (legacy)',
  pendingOrders: 'Pending Orders (legacy)',
  invoicedPending: 'Invoiced Order Pending Status (legacy)',
}

// The two exports the app now expects (source-type keys, matching detectSource).
// Freshness tracking checks each independently so a stale/missing one is obvious.
export const REQUIRED_SOURCES = ['openSalesOrders', 'fulfillmentPipeline']
