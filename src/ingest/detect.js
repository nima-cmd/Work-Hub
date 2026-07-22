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

  // Line-level OC↔PO sources (Nima, 2026-07-17: importable in-app, not just
  // via `npm run ingest`, so they can live in Bugs' CSV-freshness task).
  // Each is keyed on a column unique to its export: the PO-receiving search's
  // "Final Naghedi Destination" and the OC search's "Order Start Date"
  // (the order pipeline uses plain "Start Date"/"Maximum of Start Date").
  if (has('Document Number', 'Item', 'Final Naghedi Destination')) return 'poReceiving'
  if (has('Document Number', 'Item', 'Order Start Date')) return 'ocPipeline'

  // Consolidated SO-based order pipeline (also matches the legacy open-SO search)
  if (H.has('Sum of Quantity') || H.has('Maximum of Company Name')) return 'openSalesOrders'

  if (has('SO', 'Inv')) return 'invoicedPending'

  // The 856 ASN search (Nima's "NetSuite Fulfillments" export for Airtable) —
  // BOL is the join key from an Orderful 856 back to its originating PO.
  if (has('PO DC Identifier', 'Maximum of BOL')) return 'ediFulfillments'

  // EDIPackagesVolume — the routing feed (per PO-DC cartons/weight/volume).
  // Keyed on its two signature columns; "PO Number - DC" is unique to it.
  if (has('PO Number - DC', 'Cubic Feet (Rounded)')) return 'ediPackagesVolume'

  return null // unrecognized — the UI will report this back
}

export const SOURCE_LABELS = {
  openSalesOrders: 'Warehouse Order Pipeline',
  fulfillmentPipeline: 'Warehouse Fulfillment Pipeline',
  poReceiving: 'Warehouse PO Receiving Pipeline',
  ocPipeline: 'Warehouse OC Pipeline',
  ediFulfillments: 'EDI 856 ASN / BOL search',
  ediPackagesVolume: 'EDI Packages Volume (routing feed)',
  // The "Waiting to Ship" search — the ONLY source of IF-Packed-Status
  // (Approved to Ship / FOB / Waiting On Payment / Pending Invoice), which the
  // Launch Bay + Ship Departures depend on. Formerly treated as legacy; promoted
  // back to required 2026-07-17 after a stale export left the Launch Bay showing
  // only 1 of ~10 packed IFs with no freshness warning.
  pendingOrders: 'Waiting to Ship (packed status)',
  // legacy (no longer required, still recognized on upload)
  unpackedFulfillments: 'Item Fulfilment (legacy)',
  invoicedPending: 'Invoiced Order Pending Status (legacy)',
}

// The exports the app now expects (source-type keys, matching detectSource).
// Freshness tracking checks each independently so a stale/missing one is obvious.
// pendingOrders is here because the Launch Bay's packed-status data comes from
// nowhere else — if it's not re-exported, the bay silently goes stale.
export const REQUIRED_SOURCES = ['openSalesOrders', 'fulfillmentPipeline', 'poReceiving', 'ocPipeline', 'pendingOrders']

// Direct links to each saved search in NetSuite, so the freshness panel and
// Bugs' CSV-freshness task can jump straight to the export page (same pattern
// as Naghedi-Warehouse). Verified against live NetSuite via MCP (2026-07-17):
// numeric ids 3944/3945/3946/3936 match our mappers' columns. A null just
// hides the link, nothing breaks.
//
// Order Pipeline points at v2 (searchid=3943, confirmed by Nima 2026-07-17) —
// it has the invoice/billing-join columns the mapper reads (Document Number_1,
// Invoice Status, Ship Date, Order Cancel Date, Amount Remaining). Export from
// this one, NOT the older v1 (3942), which lacks those columns.
const NS = 'https://8513640.app.netsuite.com/app/common/search/searchresults.nl?searchid='
export const SOURCE_LINKS = {
  openSalesOrders: NS + '3943',
  fulfillmentPipeline: NS + '3944',
  poReceiving: NS + '3945',
  ocPipeline: NS + '3946',
  ediFulfillments: NS + '3936',
  // EDI Packages Volume — the routing feed (Nima, 2026-07-22).
  ediPackagesVolume: NS + '3947',
  // "Waiting to Ship" — the packed-status feed for the Launch Bay (Nima,
  // 2026-07-17). NOTE: its PO#, Invoice-for-IF and IF-Packed-Status columns are
  // MANUALLY maintained in NetSuite, so this data is only as good as the last
  // hand-update — the long-term goal is to derive launch-readiness from reliable
  // signals (invoice/payment status, custody scans, ship dates) instead.
  pendingOrders: NS + '3085',
}
