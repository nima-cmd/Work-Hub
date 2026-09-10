// src/ingest/poRevisionLive.js — read two versions of one 850 out of Orderful.
//
// ⚠️ THIS READS THE EDI, NOT NETSUITE, and that is the whole reason it exists. The
// ordinary bulk pick ticket reads NetSuite because that is where the sales orders
// are. For a re-sent PO the new version may have no sales orders at all — PO 1236143's
// 09-08 transmission was silently ignored by the integration and created nothing — so
// the 850 is the only place it exists.

import { fetchOrderfulMessage } from './orderful.js'
import { pool } from '../db.js'
import { revisionPick } from '../model/poRevisionPick.js'

/**
 * Every transmission we hold for one PO, oldest first.
 *
 * ⚠️ MATCHED ON business_number, WHICH IS THE PO ONLY FOR AN 850. On an 856 it is the
 * BOL or a tracking number and on an 810 it is our invoice number, so the type filter
 * is not tidiness — without it this would pair a purchase order against a shipment.
 */
export async function poTransmissions(poNumber, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT id, business_number, created_at, po_purpose_code, total_units, line_count
       FROM edi_transactions
      WHERE type = '850_PURCHASE_ORDER'
        AND regexp_replace(business_number, '^0+', '') = regexp_replace($1, '^0+', '')
      ORDER BY created_at`,
    [String(poNumber)],
  )
  return rows.map((r) => ({
    transactionId: r.id,
    poNumber: r.business_number,
    receivedAt: r.created_at,
    purposeCode: r.po_purpose_code,
    units: r.total_units,
    lineCount: r.line_count,
  }))
}

/**
 * Pull one 850 and flatten it to { sku, units, byStore } lines.
 *
 * ⚠️ SDQ IS READ POSITIONALLY, AND THAT IS THE FORMAT'S FAULT. One SDQ segment carries
 * up to ten store/quantity PAIRS as identificationCode/quantity, then
 * identificationCode1/quantity1 … so a loop over numbered suffixes is the only way to
 * read it. Missing the suffixed pairs is how a 24-store PO reads as a 1-store PO —
 * the same bug that stranded 338 Nordstrom 850s ([[nordstrom-850-sdq-shipto]]).
 *
 * @param upcToSku map UPC -> our SKU. Unmapped UPCs are kept AS the UPC, never dropped.
 */
export async function fetchPoVersion(transactionId, upcToSku = {}, { _fetch = fetchOrderfulMessage } = {}) {
  const m = await _fetch(process.env.ORDERFUL_API_KEY, String(transactionId))
  const ts = m.transactionSets?.[0]
  if (!ts) throw new Error(`transaction ${transactionId} has no transaction set`)
  const beg = ts.beginningSegmentForPurchaseOrder?.[0] || {}

  const lines = (ts.PO1_loop || []).map((l) => {
    const b = l.baselineItemData?.[0] || {}
    const upc = b.productServiceID
    const byStore = []
    for (const d of l.destinationQuantity || []) {
      for (let i = 0; i < 12; i++) {
        const store = i === 0 ? d.identificationCode : d[`identificationCode${i}`]
        const qty = i === 0 ? d.quantity : d[`quantity${i}`]
        if (store) byStore.push({ store: String(store), qty: Number(qty) || 0 })
      }
    }
    return {
      // ⚠️ An unmapped UPC keeps the UPC as its key rather than becoming "unknown" —
      // a new colour we have not catalogued must still appear on the sheet.
      sku: upcToSku[upc] || upc,
      upc,
      units: Number(b.quantity) || 0,
      price: b.unitPrice ?? null,
      byStore,
    }
  })

  return {
    poNumber: beg.purchaseOrderNumber ?? null,
    transactionId: String(transactionId),
    purposeCode: beg.transactionSetPurposeCode ?? null,
    poTypeCode: beg.purchaseOrderTypeCode ?? null,
    receivedAt: null,
    lines,
  }
}

/** The UPC → SKU map, live from NetSuite. */
export async function upcMap({ _runSuiteQL } = {}) {
  const { runSuiteQL } = _runSuiteQL ? { runSuiteQL: _runSuiteQL } : await import('./netsuiteApi.js')
  const r = await runSuiteQL(`SELECT i.itemid, i.upccode FROM item i WHERE i.upccode IS NOT NULL`)
  const out = {}
  for (const x of (r.rows || r)) if (x.upccode) out[String(x.upccode)] = x.itemid
  return out
}

/**
 * The comparison, ready to render.
 *
 * ⚠️ COMPARES THE LAST TWO, and says which two. A PO could be sent four times; a
 * sheet that silently picks a pair is a sheet nobody can check.
 */
export async function poRevisionTicket(poNumber, { db = pool, upc = null } = {}) {
  const txns = await poTransmissions(poNumber, { db })
  if (txns.length < 2) {
    return { poNumber: String(poNumber), transmissions: txns, comparable: false,
             reason: txns.length ? 'only one 850 received for this PO — nothing to compare' : 'no 850 found for this PO' }
  }
  const map = upc ?? await upcMap()
  const [a, b] = txns.slice(-2)
  const v1 = { ...(await fetchPoVersion(a.transactionId, map)), receivedAt: a.receivedAt }
  const v2 = { ...(await fetchPoVersion(b.transactionId, map)), receivedAt: b.receivedAt }
  return {
    ...revisionPick(v1, v2),
    comparable: true,
    transmissions: txns,
    fetchedAt: new Date().toISOString(),
  }
}
