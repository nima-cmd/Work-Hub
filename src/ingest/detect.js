// src/ingest/detect.js — figure out which saved search a CSV came from by its
// header columns, so the Import button can accept any export and route it to the
// right mapper (no need to name files a specific way).

export function detectSource(headers) {
  const H = new Set((headers || []).map((h) => h.trim()))
  const has = (...cols) => cols.every((c) => H.has(c))

  // order matters: Pending Orders also has "Created From", so check it first
  if (has('Days Pending', 'IF-Packed-Status')) return 'pendingOrders'
  if (H.has('Memo (IF)') || has('Created From', 'Actual Ship Date')) return 'unpackedFulfillments'
  if (H.has('Sum of Quantity') || H.has('Maximum of Company Name')) return 'openSalesOrders'
  if (has('SO', 'Inv')) return 'invoicedPending'
  return null // unrecognized — the UI will report this back
}

export const SOURCE_LABELS = {
  openSalesOrders: 'Warehouse Open Sales Orders',
  unpackedFulfillments: 'Item Fulfilment (unpacked)',
  pendingOrders: 'Pending Orders',
  invoicedPending: 'Invoiced Order Pending Status',
}
