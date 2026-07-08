// src/ingest/savedSearches.js
// Maps each NetSuite saved-search CSV shape into partial "pipeline records".
//
// You told me these saved searches WILL be adjusted over time, so every mapper
// reads by column *name* and tolerates missing columns — a renamed or dropped
// column degrades gracefully instead of crashing. When a search changes, we
// update only the relevant mapper here.

import { STAGE } from '../model/stages.js'

// ── small shared helpers ──────────────────────────────────────────────────

// "Sales Order #SO12043" -> "SO12043";  "Transfer Order #TO171" -> "TO171"
export function refNumber(s) {
  if (!s) return ''
  const m = String(s).match(/#?\s*([A-Z]{1,3}\d+)/i)
  return m ? m[1].toUpperCase() : String(s).trim()
}

// NetSuite prefixes customer names with an entity id: "494 Level Shoes".
export function cleanName(s) {
  return String(s || '').replace(/^\d+\s+/, '').trim()
}

// ".00" -> 0 ; "6,837.00" -> 6837 ; "" -> null
export function num(s) {
  const n = parseFloat(String(s ?? '').replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : null
}

// "6/23/2026" -> Date ; "" -> null
export function toDate(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

// ── 1) WarehouseOpenSalesOrders.csv — SOs still needing fulfillment ─────────
export function fromOpenSalesOrders(rows) {
  return rows
    .filter((r) => r['Document Number'] && r['Document Number'] !== 'Total')
    .map((r) => ({
      source: 'WarehouseOpenSalesOrders',
      stage: STAGE.OPEN,
      soNumber: refNumber(r['Document Number']),
      customer: r['Maximum of Company Name'] || '',
      poNumber: r['Maximum of PO/Check Number'] || '',
      isAts: /yes/i.test(r['Maximum of Is ATS Order'] || ''),
      startDate: toDate(r['Maximum of Start Date']),
      endDate: toDate(r['Maximum of End Date']),
      qtyOrdered: num(r['Sum of Quantity']),
      qtyAllocated: num(r['Sum of Allocated Supply']),
      qtyFulfilled: num(r['Sum of Quantity Fulfilled/Received']),
    }))
}

// ── 2) Item Fulfilment unpacked.csv — IFs picked but not yet packed ─────────
export function fromUnpackedFulfillments(rows) {
  return rows
    .filter((r) => r['Document Number'])
    .map((r) => ({
      source: 'ItemFulfilmentUnpacked',
      stage: STAGE.PICKED,
      soNumber: refNumber(r['Created From']),
      ifNumber: refNumber(r['Document Number']),
      customer: cleanName(r['Name']),
      ifStatus: r['Status'] || '', // "Picked"
      date: toDate(r['Date']),
    }))
}

// ── 3) Pending Orders.csv — IFs packed, waiting on invoice/payment/ship ─────
export function fromPendingOrders(rows) {
  return rows
    .filter((r) => r['Document Number'])
    .map((r) => ({
      source: 'PendingOrders',
      stage: STAGE.PACKED,
      soNumber: refNumber(r['Created From']),
      ifNumber: refNumber(r['Document Number']),
      customer: cleanName(r['Name']),
      packedStatus: r['IF-Packed-Status'] || '', // Approved to Ship / FOB.. / Pending Invoice / Waiting On Payment
      daysPending: num(r['Days Pending']),
      billingStatus: r['Billing Status'] || '',
      invoice: refNumber(r['Invoice for IF']),
      poNumber: refNumber(r['Purchase Order #']),
      date: toDate(r['Date']),
    }))
}

// ── 4) invoiced order pending status.csv — invoiced SOs, checking payment ───
export function fromInvoicedPending(rows) {
  return rows
    .filter((r) => r['SO'] || r['Inv'])
    .map((r) => ({
      source: 'InvoicedOrderPendingStatus',
      stage: STAGE.INVOICED,
      soNumber: refNumber(r['SO']),
      internalId: r['Internal ID'] || '',
      customer: r['Name'] || '',
      invoice: r['Inv'] || '',
      soStatus: r['Status'] || '', // Open / Paid In Full
      shippingStatus: r['Shipping Status'] || '', // Pending Payment / FOB Pending Approval / Approved For Shipping
      amountPaid: num(r['Amount Paid']),
      shipDate: toDate(r['Ship Date']),
      startDate: toDate(r['Start Date']),
      cancelDate: toDate(r['Cancel Date']),
      notes: r['Notes'] || '',
      approvalStatus: r['Approval Status'] || '',
    }))
}
