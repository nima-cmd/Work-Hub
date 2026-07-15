// src/ingest/orderful.js
// Pulls EDI transactions (850/856/810/860…) straight from Orderful's API —
// replaces the manual Orderful → CSV → Airtable step. Auth is a single header
// (see https://docs.orderful.com/reference/authentication); pagination is
// cursor-based, newest first, 100 per page (see List Transactions docs).

import { pool } from '../db.js'

const API_BASE = 'https://api.orderful.com/v3/transactions'

async function fetchPage(apiKey, cursor) {
  const url = new URL(API_BASE)
  if (cursor) url.searchParams.set('nextCursor', cursor)
  const res = await fetch(url, {
    headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Orderful API ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// Naghedi is sometimes sender, sometimes receiver depending on the document —
// the other party on the transaction is always "the trading partner".
function tradingPartner(txn) {
  const isNaghedi = (party) => party?.name === 'NAGHEDI'
  return isNaghedi(txn.sender) ? txn.receiver?.name : txn.sender?.name
}

// Fetches every transaction (paginating until Orderful stops returning a
// nextCursor) and returns them normalized for loadEdiTransactions. Orderful
// has no server-side "since" filter we rely on here — the upsert is what
// keeps re-syncs cheap (idempotent), not the fetch itself.
export async function fetchOrderfulTransactions(apiKey) {
  const all = []
  let cursor
  do {
    const page = await fetchPage(apiKey, cursor)
    for (const txn of page.data || []) {
      all.push({
        id: txn.id,
        type: txn.type?.name,
        direction: txn.sender?.name === 'NAGHEDI' ? 'OUT' : 'IN',
        businessNumber: txn.businessNumber,
        tradingPartner: tradingPartner(txn),
        stream: txn.stream,
        validationStatus: txn.validationStatus,
        deliveryStatus: txn.deliveryStatus,
        acknowledgmentStatus: txn.acknowledgmentStatus,
        createdAt: txn.createdAt,
        lastUpdatedAt: txn.lastUpdatedAt,
      })
    }
    cursor = page.metadata?.pagination?.links?.next
      ? new URL(page.metadata.pagination.links.next).searchParams.get('nextCursor')
      : null
  } while (cursor)
  return all
}

export async function loadEdiTransactions(transactions, db = pool) {
  let n = 0
  for (const t of transactions) {
    await db.query(
      `INSERT INTO edi_transactions
         (id, type, direction, business_number, trading_partner, stream,
          validation_status, delivery_status, acknowledgment_status, created_at, last_updated_at, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (id) DO UPDATE SET
         validation_status     = EXCLUDED.validation_status,
         delivery_status       = EXCLUDED.delivery_status,
         acknowledgment_status = EXCLUDED.acknowledgment_status,
         last_updated_at       = EXCLUDED.last_updated_at,
         synced_at             = now()`,
      [
        t.id, t.type, t.direction, t.businessNumber, t.tradingPartner, t.stream,
        t.validationStatus, t.deliveryStatus, t.acknowledgmentStatus, t.createdAt, t.lastUpdatedAt,
      ],
    )
    n++
  }
  return n
}

async function fetchTransactionMessage(apiKey, id) {
  const res = await fetch(`${API_BASE}/${id}/message`, {
    headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' },
  })
  if (!res.ok) throw new Error(`Orderful API ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

const ediDate = (yyyymmdd) => (yyyymmdd ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : null)

// The ship-window dates live in the DTM (date/time reference) segment of the
// 850's own transaction set, not on the list endpoint — confirmed against
// real X12 850 content 2026-07-10. 064 = "Do Not Deliver Before", 001 = "Cancel After".
function extractPoDates(message) {
  const dtms = message?.transactionSets?.[0]?.dateTimeReference || []
  const find = (q) => dtms.find((d) => d.dateTimeQualifier === q)?.date
  return { shipNotBefore: ediDate(find('064')), cancelAfter: ediDate(find('001')) }
}

// Only 850s carry these dates, and the message body is a second API call per
// transaction — so this only ever fetches ones we haven't already resolved,
// not the full history on every sync.
export async function backfillPoDates(apiKey, db = pool) {
  const { rows } = await db.query(
    `SELECT id FROM edi_transactions WHERE type = '850_PURCHASE_ORDER' AND ship_not_before IS NULL AND cancel_after IS NULL`,
  )
  let n = 0
  for (const { id } of rows) {
    const message = await fetchTransactionMessage(apiKey, id)
    const { shipNotBefore, cancelAfter } = extractPoDates(message)
    if (!shipNotBefore && !cancelAfter) continue // nothing found — leave NULL, don't re-fetch forever
    await db.query(
      `UPDATE edi_transactions SET ship_not_before = $2, cancel_after = $3 WHERE id = $1`,
      [id, shipNotBefore, cancelAfter],
    )
    n++
  }
  return { checked: rows.length, updated: n }
}

// The 850 is the master document everything else must resolve to (Nima,
// 2026-07-10) — but businessNumber isn't that resolver for 856/810: an 810's
// businessNumber is its own invoice number, and some 856s carry a carrier
// tracking number instead of the PO#. The real PO# reference lives inside
// each document's own message body:
//   810 → beginningSegmentForInvoice.purchaseOrderNumber (exactly one)
//   856 → HL_loop[] entries at hierarchicalLevelCode 'O' (order level), each
//         with purchaseOrderReference[0].purchaseOrderNumber — a consolidated
//         shipment can list several, same idea as the BOL fan-out.
function extractPoRefs(type, message) {
  const ts = message?.transactionSets?.[0]
  if (!ts) return []
  if (type === '810_INVOICE') {
    const po = ts.beginningSegmentForInvoice?.[0]?.purchaseOrderNumber
    return po ? [po] : []
  }
  if (type === '856_SHIP_NOTICE_MANIFEST') {
    const orderLevels = (ts.HL_loop || []).filter((h) => h.hierarchicalLevel?.[0]?.hierarchicalLevelCode === 'O')
    const refs = orderLevels.map((h) => h.purchaseOrderReference?.[0]?.purchaseOrderNumber).filter(Boolean)
    return [...new Set(refs)]
  }
  return []
}

export async function loadDocumentPoRefs(transactionId, poNumbers, db = pool) {
  for (const po of poNumbers) {
    await db.query(
      `INSERT INTO edi_document_po_refs (transaction_id, po_number) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [transactionId, po],
    )
  }
  await db.query('UPDATE edi_transactions SET po_refs_checked = true WHERE id = $1', [transactionId])
}

// Only 856/810s need this, and the message body is a second API call per
// transaction — so this only ever fetches ones not yet checked, not the full
// history on every sync.
export async function backfillDocumentPoRefs(apiKey, db = pool) {
  const { rows } = await db.query(
    `SELECT id, type FROM edi_transactions
     WHERE type IN ('856_SHIP_NOTICE_MANIFEST', '810_INVOICE') AND po_refs_checked = false`,
  )
  let n = 0
  for (const { id, type } of rows) {
    const message = await fetchTransactionMessage(apiKey, id)
    const poNumbers = extractPoRefs(type, message)
    await loadDocumentPoRefs(id, poNumbers, db)
    if (poNumbers.length) n++
  }
  return { checked: rows.length, resolved: n }
}

export async function fetchEdiDocumentPoRefs(db = pool) {
  const { rows } = await db.query(
    `SELECT transaction_id AS "transactionId", po_number AS "poNumber" FROM edi_document_po_refs`,
  )
  return rows
}

export async function syncOrderful(apiKey, db = pool) {
  const transactions = await fetchOrderfulTransactions(apiKey)
  const count = await loadEdiTransactions(transactions, db)
  const dates = await backfillPoDates(apiKey, db)
  const poRefs = await backfillDocumentPoRefs(apiKey, db)
  return { fetched: transactions.length, upserted: count, poDates: dates, poRefs }
}

export async function fetchEdiTransactions(db = pool) {
  const { rows } = await db.query(
    `SELECT id, type, direction, business_number AS "businessNumber", trading_partner AS "tradingPartner",
            stream, validation_status AS "validationStatus", delivery_status AS "deliveryStatus",
            acknowledgment_status AS "acknowledgmentStatus", created_at AS "createdAt",
            last_updated_at AS "lastUpdatedAt", ship_not_before AS "shipNotBefore", cancel_after AS "cancelAfter"
     FROM edi_transactions
     ORDER BY created_at DESC`,
  )
  return rows
}
