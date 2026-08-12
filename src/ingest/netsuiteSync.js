// src/ingest/netsuiteSync.js — the live NetSuite order-lifecycle pull.
//
// Read-only SuiteQL (see netsuiteApi.js) mapped into the SAME partial-record
// shape the CSV mappers in savedSearches.js emit, so it flows through the
// existing buildPipeline → loadToDb path untouched. The CSV import stays as the
// fallback; whichever ran most recently wins per natural key.
//
// Why this exists: the saved-search CSVs export OPEN work only, so an order that
// completes between manual uploads drops off the export and `pruneOrders` then
// deletes it — the app never sees it finish. Querying live lets us ask for "open
// PLUS anything that changed in the last N days", so terminal states are
// observed instead of vanishing.
//
// All status codes below were measured against the live account 2026-07-30 (see
// docs/netsuite-api-integration.md); NetSuite exposes them as single letters.

import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { pushWarehousePoLines, pushWarehouseInventory } from './warehouseFeed.js'
import { STAGE } from '../model/stages.js'
import { cleanName } from './savedSearches.js'
import { buildPipeline } from '../model/pipeline.js'
import { deriveSource } from '../model/source.js'
// NOTE: db.js / loadToDb.js are imported LAZILY inside syncFromNetsuite. db.js
// throws at import time when DATABASE_URL is unset, and `npm test` runs without
// --env-file — so a top-level import here would break the "unit tests need no DB"
// contract just by importing this module's pure mappers.

// ── status maps (live-measured) ──────────────────────────────────────────────
// Sales Order. B/D/F are still in the open pipeline; G/H are terminal.
export const SO_STATUS = {
  A: 'Pending Approval',
  B: 'Pending Fulfillment',
  D: 'Partially Fulfilled',
  E: 'Pending Billing/Partially Fulfilled',
  F: 'Pending Billing',
  G: 'Billed',
  H: 'Closed',
}
export const SO_OPEN_CODES = ['A', 'B', 'D', 'E', 'F']
export const SO_TERMINAL_CODES = ['G', 'H']

// Purchase Order — inbound supply. Measured live 2026-08-02 across 681 POs:
// B "Pending Receipt" (57) · D "Partially Received" (28) · F "Pending Bill" (1)
// are still awaiting or mid-receipt; G "Fully Billed" (589) and H "Closed" (6)
// are done. Same letters as the SO map, DIFFERENT meanings — don't share them.
export const PO_OPEN_CODES = ['B', 'D', 'F']

// The real hold signal in this account: the custom list `custbody_approval_status`
// on the sales order. Measured live 2026-07-31 across the 135 open SOs — 108
// read 1 "Approved", 27 read 2 "On Hold". The native Pending-Approval status is
// never used, so this field is the ONLY way to know an order is held.
export const APPROVAL_APPROVED = 1
export const APPROVAL_ON_HOLD = 2

// Item Fulfillment. This is the ONLY reliable shipped signal —
// transaction.shipstatus 500s, so read transaction.status.
export const IF_STATUS = { A: 'Picked', B: 'Packed', C: 'Shipped' }

// Invoice.
export const INV_STATUS = { A: 'Open', B: 'Paid In Full' }

// The approved-to-ship gate (Nima's step 5). This is a CUSTOM field, not a
// NetSuite status: `custbody_invoice_status` on the invoice, a custom list whose
// codes were queried live 2026-07-31. Value 2 is defined but unused — 5,883
// invoices across all history read 1/3/4/5 only, and NONE is null, which is why
// the COALESCE in loadInvoices can't freeze a stale value here.
//
// Why this exists at all: the app matched these exact strings in
// server/queries.js `launchState`, but read them off `invoices.shipping_status`,
// which ONLY the CSV path ever wrote (last `invoicedPending` import 2026-07-09).
// So the gate was not merely stale — it was DEAD: with no writer, every bay row
// fell through to "awaiting invoice", and the `delayed`/floating-days nudge
// (which requires state 'approved') could never fire once. Neon still claims 19
// "Approved For Shipping"; NetSuite says 4 in the entire account.
export const INV_SHIPPING_STATUS = {
  1: 'Pending Payment',
  3: 'Approved For Shipping',
  4: 'Shipped',
  5: 'FOB Pending Approval',
}

const nOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Trim to a real string, or null. Never '' — the loader COALESCEs these columns,
// and an empty string is a value, so it would overwrite a known one with blank.
const strOrNull = (v) => {
  const s = String(v ?? '').trim()
  return s || null
}

// 'YYYY-MM-DD' N days before today (UTC-ish; a day either side is harmless for a
// look-back window). Injectable `now` keeps it testable.
export function windowStart(days, now = new Date()) {
  const d = new Date(now.getTime() - days * 86_400_000)
  return d.toISOString().slice(0, 10)
}

// ── mappers: SuiteQL row → partial pipeline record ───────────────────────────

// A Sales Order row. Mirrors fromOpenSalesOrders' output contract.
// `stage` from this row alone: terminal → SHIPPED, an invoice → INVOICED
// (buildPipeline may promote it via shippingStatus), on-hold → ON_HOLD, else
// OPEN. Picked/Packed/Shipped from the IF records merge in by SO# via
// furthestStage, exactly as with the CSVs.
//
// ⚠️ A HOLD IS NOT A NETSUITE STATUS HERE (Nima, 2026-07-31). The native
// "Pending Approval" status (code 'A') is never used in this account — measured
// live: of 5,927 sales orders, the only statuses present are B (135), D (2),
// G (4,953) and H (837), so the `code === 'A'` branch below has never once
// fired. Holds are carried on the CUSTOM field `custbody_approval_status`
// (1 = Approved, 2 = On Hold), and every open SO reads status B "Pending
// Fulfillment" regardless.
//
// The consequence, which is the bug this fixes: all 27 on-hold orders sat in
// Kanban's Pending Fulfillment as work to start (73 shown, 46 real). Reading
// the field is the whole fix — the ON_HOLD stage already existed and ranks
// below OPEN, it was just unreachable.
export function mapOrderRow(row) {
  const code = row.status || ''
  const terminal = SO_TERMINAL_CODES.includes(code)
  const soStatus = SO_STATUS[code] || code || ''
  // String, not number: SuiteQL hands custom list values back as strings.
  const onHold = String(row.approval_status ?? '') === String(APPROVAL_ON_HOLD)
  // A placeholder is a temp order holding stock until the real one arrives
  // (Nima, 2026-07-31: "we don't need to track it"). SuiteQL returns a checkbox
  // as 'T'/'F'; anything else — including absent, which is what the CSV path
  // sends — stays null so it can't wipe a known value.
  const ph = row.is_placeholder
  const isPlaceholder = ph === 'T' || ph === true ? true : (ph === 'F' || ph === false ? false : null)

  let stage = STAGE.OPEN
  if (terminal) stage = STAGE.SHIPPED
  else if (code === 'A' || onHold) stage = STAGE.ON_HOLD

  return {
    source: 'NetSuiteLive',
    stage,
    soNumber: String(row.tranid || '').toUpperCase(),
    // NetSuite prefixes the entity id ("533 Centre Point Nantucket"); the CSV
    // path stores it stripped, so match that or every customer name would churn.
    customer: cleanName(row.customer || ''),
    location: row.location || '',
    poNumber: row.otherrefnum || '',
    soStatus,
    // The ATS custom field isn't reachable over SuiteQL yet, so leave it null —
    // loadOrders COALESCEs is_ats so a null preserves whatever the CSV knew.
    isAts: null,
    shipDate: row.shipdate || null,
    startDate: row.trandate || null,
    // The order's OWN payment terms, as label text ("Net 30", "Due on receipt").
    //
    // ⚠️ NAMED `orderTerms`, NOT `terms`, and that is not cosmetic. Invoice
    // records emit a `terms` of their own (mapInvoiceRow), buildPipeline merges
    // every record for an SO into one object, and its CARRY copy is
    // first-non-empty-wins — so a shared name would let whichever record arrived
    // first decide, silently, which document's terms the flow keys on. They
    // normally agree, which is exactly what would make the day they disagree
    // impossible to spot.
    orderTerms: strOrNull(row.terms),
    // Order value; feeds the shipped-$ credit fallback.
    amountPaid: nOrNull(row.foreigntotal),
    // Terminal orders are, by definition, fully billed — that's what makes the
    // recently-closed window able to close an order out instead of losing it.
    billingStatus: terminal ? 'Fully Billed' : null,
    netsuiteStatusCode: code,
    // Which DC this store consolidates through, and its store number — the pair
    // getPoDcs calls its "primary + best source". Trimmed to null rather than ''
    // so loadOrders' COALESCE can't blank a known value with an empty string.
    dc: strOrNull(row.dc_code),
    storeNumber: strOrNull(row.store_number),
    isPlaceholder,
    terminal,
  }
}

// An Item Fulfillment row. status C (Shipped) also supplies actualShipDate —
// which is what stamps the SHIPPED_VALUE credit.
export function mapFulfillmentRow(row) {
  const code = row.status || ''
  const ifStatus = IF_STATUS[code] || code || ''
  const shipped = code === 'C'
  return {
    source: 'NetSuiteLive',
    stage: shipped ? STAGE.SHIPPED : code === 'B' ? STAGE.PACKED : STAGE.PICKED,
    soNumber: String(row.so_number || '').toUpperCase(),
    ifNumber: String(row.if_number || '').toUpperCase(),
    ifStatus,
    date: row.trandate || null,
    actualShipDate: shipped ? row.trandate || null : null,
  }
}

// An Invoice row. amountRemaining is what's still owed (0 once paid);
// amountTotal is the stable value the credit falls back to.
export function mapInvoiceRow(row) {
  const code = row.status || ''
  return {
    source: 'NetSuiteLive',
    soNumber: String(row.so_number || '').toUpperCase(),
    invoice: String(row.inv_number || '').toUpperCase(),
    invoiceStatus: INV_STATUS[code] || code || '',
    // The approved-to-ship gate. SuiteQL hands a custom list back as a number
    // here (unlike custbody_approval_status on the SO, which arrives as a
    // string), so normalise before the lookup rather than trusting either.
    shippingStatus: INV_SHIPPING_STATUS[Number(row.invoice_status)] || '',
    // Nordstrom's consolidated invoice reference — many of OUR invoices share one
    // (per DC, per PO). Uppercased and trimmed here so the 810's businessNumber,
    // which arrives in whatever case Orderful passes through, can match it.
    nordstromRef: String(row.nordstrom_ref || '').trim().toUpperCase() || null,
    amountRemaining: nOrNull(row.foreignamountunpaid),
    amountTotal: nOrNull(row.foreigntotal),
    // Payment terms + due date: the objective half of the ship gate. These are
    // what let src/model/paymentGate.js derive whether payment blocks a
    // shipment, instead of reading the hand-maintained `shippingStatus` above.
    // Terms arrive as label text via BUILTIN.DF ("Net 30", "Due on receipt",
    // "No Payment Required") and are matched loosely, never by id.
    terms: String(row.terms || '').trim() || null,
    dueDate: row.duedate || null,
    // Who the invoice bills. Taken from the INVOICE, not the order, because
    // 1,015 invoices legitimately have no order row (out-of-window, by design)
    // — and an overdue list that can't say who owes the money is unusable.
    billTo: String(row.bill_to || '').trim() || null,
    shipDate: row.shipdate || null,
    // The invoice's own document date. min() over these is the floor of the
    // records we hold — what lets the trail say a partner's 810 reference
    // "predates our invoice records" instead of rendering it like a live gap.
    tranDate: row.trandate || null,
  }
}

// ── queries ──────────────────────────────────────────────────────────────────
// Kept deliberately simple: SuiteQL 500s on GROUP BY BUILTIN.DF over large sets,
// and `createdfrom` isn't queryable (join PreviousTransactionLineLink instead).
// The link table is LINE-level, so every child join needs DISTINCT.

const openOrRecent = (since) =>
  `(t.status IN (${SO_OPEN_CODES.map((c) => `'${c}'`).join(',')}) OR t.lastmodifieddate >= TO_DATE('${since}','YYYY-MM-DD'))`

// ⚠️ THE DC COMES OFF THE CUSTOMER, NOT THE ORDER (Nima, 2026-08-02).
// An EDI sales order is one store, and which distribution center that store
// consolidates through is what lets us print one cargo tag per DC. Three places
// hold it and only one is reachable from here:
//   · `custbody_if_dc_code` (sales order)    — NOT_EXPOSED to SuiteQL SEARCH
//   · `custbody_pkg_distribution_center`     — NOT_EXPOSED either
//   · `custentity_dc_location` (customer)    — EXPOSED, and already carries the
//     exact code the app uses: Bloomingdale's SC/ST/JP/CI/CL/HA/CG, Nordstrom
//     799/699/584/…, Shopbop SBX2. Verified 131/131 sales orders on every open
//     EDI PO — no gaps, no mapping needed.
// Same NOT_EXPOSED trap as `quantityfulfilled`: the field is real and visible on
// the record, it just isn't searchable, and SuiteQL says "not found" rather than
// "not searchable". Check the REST record before believing a field is absent.
//
// LEFT JOIN, not JOIN: a sales order must never disappear from the sync because
// its customer row didn't come back.
export function orderSql(since) {
  // ⚠️ `terms` is read off the SALES ORDER, not the invoice, and that is the
  // whole point (Nima, 2026-08-11: a Net order goes to Shipped when the label is
  // made, and the invoice comes after). The invoice already carries terms — but
  // under this flow it does not EXIST yet at the moment the terms decide what
  // happens, so reading them there would answer the question too late to matter.
  // Verified live: 100 of 100 open sales orders carry terms (Due on receipt 36 ·
  // Net 60 35 · Net 30 22 · Net 45 7), so there is no null case to guess at.
  // BUILTIN.DF resolves the id to label text; ⚠️ SuiteQL 500s on GROUP BY over
  // BUILTIN.DF, so never aggregate on this column — select it and group in JS.
  return `SELECT t.tranid, BUILTIN.DF(t.entity) AS customer, t.status,
                 TO_CHAR(t.trandate,'YYYY-MM-DD') AS trandate,
                 TO_CHAR(t.shipdate,'YYYY-MM-DD') AS shipdate,
                 BUILTIN.DF(t.terms) AS terms,
                 t.foreigntotal, t.otherrefnum,
                 t.custbody_approval_status AS approval_status,
                 t.custbody_is_placeholder AS is_placeholder,
                 c.custentity_dc_location AS dc_code,
                 c.custentity_store_number AS store_number
          FROM transaction t
          LEFT JOIN customer c ON c.id = t.entity
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// One location per SO, off the lines (the header has none). Multiple lines can
// disagree; we keep the first non-null, same as the CSV's "Maximum of Location".
export function locationSql(since) {
  return `SELECT DISTINCT t.tranid, BUILTIN.DF(tl.location) AS location
          FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
          WHERE t.type='SalesOrd' AND tl.mainline='F' AND ${openOrRecent(since)}`
}

// ── SO line quantities ───────────────────────────────────────────────────────
// The order HEADER carries no quantity, so ordered/committed/fulfilled have to be
// rolled up off the lines. Until now they came ONLY from the openSalesOrders CSV,
// which made them the last frozen FIELDS in the app after the last frozen table
// went live — and `loadOrders` COALESCEs, so a stale value outlived its export.
//
// ⚠️ THE ARTIFACT THIS FIXES — the CSV was also counting freight and tax as goods.
// "Sum of Quantity" totals EVERY line, and the ShipItem / TaxItem lines carry a
// quantity of 1 but NO quantitycommitted. So
// `shortBy = ordered - allocated - fulfilled` read exactly 2 on any order with
// both a ship line and a tax line, and 1 on those with one of them — 141 and 27
// of the 194 orders with quantities, 87%, none of them actually short. Measured
// live 2026-08-02: SO12419 orders 14 units and has all 14 committed, yet the app
// read 16/14. Nima's instinct in [[order-qty-shortage-stale]] was right: "we were
// not short, and I think all sales orders have at least 1 unit shortage."
// Rolling up ITEM lines only is the whole fix.
//
// ⚠️ `tl.quantity` comes back NEGATIVE on a sales order (−3 for an order of 3),
// exactly as on an Estimate — 1,884 of 1,884 open lines, zero positive. ABS it.
// `quantitycommitted` and `quantityshiprecv` are already positive; ABSing those
// too would silently hide a credit line if one ever appeared.
//
// ⚠️ `quantityfulfilled` is NOT_EXPOSED to SuiteQL ("Not available for channel
// SEARCH"). `quantityshiprecv` is the exposed equivalent and does track
// fulfilment — verified on SO11975, partially fulfilled, where it matches
// quantitybilled line for line.
export function orderLineSql(since) {
  return `SELECT t.tranid, tl.itemtype, tl.quantity, tl.isclosed,
                 tl.quantitycommitted, tl.quantityshiprecv
          FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
          WHERE t.type='SalesOrd' AND tl.mainline='F' AND ${openOrRecent(since)}`
}

// Line types that are money on the order but not goods on the shelf. Excluded
// from every quantity roll-up.
//
// Deliberately a DENY list, not an allow list of 'InvtPart'. An unknown itemtype
// counts as an item, so the day an Assembly or Kit line appears its units land in
// demand instead of vanishing — an overcount announces itself, an undercount is
// the bug we just spent a session finding. Live spread on the open orders:
// InvtPart 1617 · ShipItem 141 · TaxItem 126 · Discount 5.
export const NON_ITEM_LINE_TYPES = ['ShipItem', 'TaxItem', 'Discount', 'Subtotal', 'Markup']

// Line rows → one {qtyOrdered, qtyAllocated, qtyFulfilled} per SO. Summed in JS
// for the same reason as the PO and OC folds: SuiteQL 500s on GROUP BY here.
// An SO with no item lines at all is absent from the map rather than present with
// zeroes, so it writes nulls and COALESCE keeps whatever was known.
//
// ⚠️ A CLOSED LINE IS CANCELLED DEMAND, and counting it is the same phantom
// shortage in a second costume: it can never be committed and can never ship, so
// its units sit in `ordered` forever with nothing to subtract them. Measured live
// 2026-08-02, ALL 76 closed lines in the window carry 0 committed AND 0
// ship/recv — so dropping them whole loses no fulfilment history, it only stops
// the overcount. SO12159 is the live case: partially fulfilled, two closed lines,
// 18 units that would otherwise read as still-open.
// The entry is seeded by SEEING the SO, not by counting a line, and the
// distinction is load-bearing. "This order's lines are all closed" is a real
// answer of zero open units; "the pull returned nothing for this order" is an
// absence of knowledge. Only the second may fall through to COALESCE. Seeding on
// the excluded line too means the 4 fully-closed orders in the window get an
// honest 0 instead of keeping a CSV number that still counts freight and tax.
export function foldOrderLines(rows = []) {
  const bySo = new Map()
  for (const row of rows) {
    const so = String(row.tranid || '').toUpperCase()
    if (!so) continue
    let seen = bySo.get(so)
    if (!seen) { seen = { qtyOrdered: 0, qtyAllocated: 0, qtyFulfilled: 0 }; bySo.set(so, seen) }
    if (NON_ITEM_LINE_TYPES.includes(String(row.itemtype || '').trim())) continue
    if (String(row.isclosed || '') === 'T') continue
    seen.qtyOrdered += Math.abs(Number(row.quantity) || 0)
    seen.qtyAllocated += Number(row.quantitycommitted) || 0
    seen.qtyFulfilled += Number(row.quantityshiprecv) || 0
  }
  return bySo
}

export function fulfillmentSql(since) {
  return `SELECT DISTINCT c.tranid AS if_number, t.tranid AS so_number, c.status,
                 TO_CHAR(c.trandate,'YYYY-MM-DD') AS trandate
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='ItemShip'
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// Tracking numbers per IF. NetSuite exposes these ONLY via the TrackingNumberMap
// join (transaction.trackingnumbers / linkedtrackingnumbers are not queryable
// fields — both fail as unknown identifiers). One IF can have several rows when the
// shipment is multi-box.
export function trackingSql(since) {
  return `SELECT DISTINCT c.tranid AS if_number, tn.trackingnumber
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='ItemShip'
          JOIN TrackingNumberMap m ON m.transaction = c.id
          JOIN trackingnumber tn ON tn.id = m.trackingnumber
          WHERE t.type='SalesOrd' AND ${openOrRecent(since)}`
}

// SO → its ONE invoice, for deriving the IF ↔ Invoice link (see the call site in
// fetchOrderLifecycle for why the shared SO is the only available link). An SO
// with several invoices is reported as ambiguous and deliberately gets NO entry:
// a wrong invoice on a fulfilment puts the payment gate on the wrong shipment,
// which is worse than an honest blank.
export function invoiceBySo(invRows = []) {
  const bySo = new Map()
  const ambiguous = new Set()
  for (const r of invRows) {
    const so = String(r.so_number || '').toUpperCase()
    const inv = String(r.inv_number || '').toUpperCase()
    if (!so || !inv) continue
    const seen = bySo.get(so)
    if (seen && seen !== inv) ambiguous.add(so)
    else bySo.set(so, inv)
  }
  for (const so of ambiguous) bySo.delete(so)
  return { bySo, ambiguous: [...ambiguous] }
}

// ⚠️ AN INVOICE IS ITS OWN DOCUMENT, so it gets its OWN window (2026-08-03).
// This query used to be scoped ONLY by the sales order — `openOrRecent(since)` —
// which made `invoices` a 30-day working window rather than a document record:
// 104 rows against NetSuite's 418 in the very same INV10996–INV11416 span (25%).
// The visible cost was on the EDI trail: of Bloomingdale's 166 outbound 810s
// since 2026-05, only 49 could reach an invoice row, so 117 POs showed "we
// transmitted an 810" with no INVOICED event, no amount and no paid status. The
// keying was right all along (see the 810 note in orderEvents) — the coverage
// wasn't.
//
// The `invoiceSince` branch is ADDITIVE, never a replacement. An invoice raised
// long ago against a still-open sales order has to keep arriving or step 5's
// gate (`shipping_status`) would freeze at whatever we last saw; the SO branch is
// what guarantees that, so widening must not trade one blind spot for another.
//
// ⚠️ Widening this query ALONE breaks the sync — it does not merely under-fill.
// `invoices.so_number` has an enforced FK to `orders(so_number)` (proven live:
// 23503), and today it is this shared `openOrRecent` predicate that guarantees
// every invoice's SO is in the same pull. All 309 invoices missing from the span
// belong to orders outside the window too, so the FK would reject every one.
// `loadInvoices` resolves the SO through `orders` for exactly this reason.
export function invoiceSql(since, invoiceSince = since) {
  return `SELECT DISTINCT c.tranid AS inv_number, t.tranid AS so_number, c.status,
                 c.custbody_invoice_status AS invoice_status,
                 c.custbody_hb_edi_nordstrom_inv AS nordstrom_ref,
                 c.foreigntotal, c.foreignamountunpaid,
                 BUILTIN.DF(c.terms) AS terms,
                 BUILTIN.DF(c.entity) AS bill_to,
                 TO_CHAR(c.duedate,'YYYY-MM-DD') AS duedate,
                 TO_CHAR(c.shipdate,'YYYY-MM-DD') AS shipdate,
                 TO_CHAR(c.trandate,'YYYY-MM-DD') AS trandate
          FROM transaction t
          JOIN PreviousTransactionLineLink l ON l.previousdoc = t.id
          JOIN transaction c ON c.id = l.nextdoc AND c.type='CustInvc'
          WHERE t.type='SalesOrd'
            AND (${openOrRecent(since)}
                 OR c.trandate >= TO_DATE('${invoiceSince}','YYYY-MM-DD')
                 OR c.lastmodifieddate >= TO_DATE('${invoiceSince}','YYYY-MM-DD'))`
}

// ── inbound supply: purchase orders ──────────────────────────────────────────
// The last substantive CSV-only table (the "PO Warehouse View" saved search).
// It was still frozen at the 2026-07-29 export while every outbound table went
// live, and nothing surfaced the staleness because no screen ages inbound.
//
// ⚠️ `destination` MUST be the location's FULL path. This column is the OC↔PO
// match key and joins to order_confirmations.location, which stores the full
// hierarchical name ("Warehouse Bulk : Nordstrom"). BUILTIN.DF on the custom
// field returns only the LEAF ("Nordstrom"), so joining to the location record
// for `fullname` is load-bearing, not cosmetic — the leaf form silently matches
// nothing, and it is also what the Naghedi-Warehouse app reads to aim its
// Inventory Transfer CSVs (a leaf would transfer stock to the wrong location).
//
// `ship_to` is deliberately NOT synced. The saved search's "Ship To" is an
// addressee that doesn't map to any single line of `transaction.shipaddress`
// (PO1745 has it on line 2, under "Retail Receiving"), and line-parsing an
// address to guess it would be a fabricated value. The upsert COALESCEs, so
// values already loaded from CSV survive untouched; the schema itself calls
// ship_to a secondary signal, never the match key.
export function purchaseOrderSql(since) {
  return `SELECT t.tranid AS po_number, BUILTIN.DF(t.entity) AS vendor,
                 BUILTIN.DF(t.status) AS status,
                 TO_CHAR(t.duedate,'YYYY-MM-DD') AS duedate,
                 loc.fullname AS destination,
                 BUILTIN.DF(tl.item) AS item,
                 tl.quantity, tl.quantityshiprecv
          FROM transaction t
          JOIN transactionline tl ON tl.transaction = t.id
          LEFT JOIN location loc ON loc.id = t.custbody_acs_final_destination
          WHERE t.type='PurchOrd' AND tl.mainline='F'
            AND (t.status IN (${PO_OPEN_CODES.map((c) => `'${c}'`).join(',')})
                 OR t.lastmodifieddate >= TO_DATE('${since}','YYYY-MM-DD'))`
}

// SuiteQL row → the same partial-record shape fromPoReceiving emits, so it
// flows through loadPurchaseOrders untouched. BUILTIN.DF prefixes the status
// with the record type ("Purchase Order : Pending Receipt"); the CSV column
// carries only the bare status, so strip it to keep both paths writing the
// same string.
export function mapPurchaseOrderRow(row) {
  const ordered = Number(row.quantity) || 0
  const received = Number(row.quantityshiprecv) || 0
  return {
    source: 'PoReceiving',
    poNumber: String(row.po_number || '').trim(),
    item: String(row.item || '').trim(),
    vendor: cleanName(row.vendor || ''),
    destination: row.destination || '',
    status: String(row.status || '').replace(/^Purchase Order\s*:\s*/i, '').trim(),
    expectedReceipt: row.duedate || null,
    qtyOrdered: ordered,
    qtyReceived: received,
    qtyRemaining: ordered - received,
  }
}

// Collapse the line rows to one record per (PO#, item) — the table's primary
// key. A PO can legitimately list the same item on several lines, and the
// upsert would otherwise keep only whichever arrived last instead of the total.
// Summed in JS rather than SQL because SuiteQL 500s on GROUP BY over BUILTIN.DF.
export function foldPurchaseOrderLines(rows = []) {
  const byKey = new Map()
  for (const row of rows) {
    const r = mapPurchaseOrderRow(row)
    if (!r.poNumber || !r.item) continue
    const k = `${r.poNumber}@@${r.item}`
    const seen = byKey.get(k)
    if (!seen) { byKey.set(k, r); continue }
    seen.qtyOrdered += r.qtyOrdered
    seen.qtyReceived += r.qtyReceived
    seen.qtyRemaining += r.qtyRemaining
  }
  // Only lines still owing units, mirroring the saved search's own scope —
  // every row the CSV path ever wrote had a remaining quantity.
  return [...byKey.values()].filter((r) => r.qtyRemaining > 0)
}

// ── pre-SO demand: order confirmations ───────────────────────────────────────
// The last table still frozen at the 2026-07-29 CSV export once purchase_orders
// went live. In this account the Estimate record is RENAMED "Order Confirmation"
// (BUILTIN.DF returns "Order Confirmation : Open"), so `type='Estimate'` is the
// right filter despite the app calling them OCs everywhere else.
//
// Scope is the two statuses that mean "no Sales Order created from this yet":
//   A Open · X Expired  (B Processed = converted, and is what the saved search
// excluded so OCs never double-count against `orders`).
// Verified live 2026-08-02: 58 A + 26 X = 84 OCs, exactly the 84 the frozen CSV
// copy held, and every one of its 1,712 lines is still inside this scope — the
// pull is a superset, so nothing legitimate gets pruned on the first run.
//
// ⚠️ Deliberately NO `since` window, unlike purchaseOrderSql. A PO stays the
// same record when it closes, so the PO query widens the net to catch recently
// closed ones and let the prune retire them. An OC that converts flips to B and
// must simply LEAVE the table — widening the window here would pull converted
// OCs back in and double-count real sales orders as open demand. The scope is
// small enough (1,733 lines) to pull whole every cycle, which is also what makes
// pruneOrderConfirmations safe: it is always diffing against a complete set.
export const OC_OPEN_CODES = ['A', 'X']

// ⚠️ `location` must be the location's FULL path, the same trap as
// purchase_orders.destination — this column is the other half of the OC↔PO match
// key and holds values like "Warehouse Bulk : Nordstrom". `fullname` gives the
// path; the leaf alone would silently match nothing. Line location wins over the
// header's: verified live to reproduce the CSV copy exactly, including all 109
// rows where both are empty.
//
// `ship_to` is NOT selected. It is 100% NULL across all 1,712 CSV-loaded rows —
// the export never populated it — so there is nothing to reproduce and no
// NetSuite field that reliably means it (same conclusion as purchase_orders).
// The upsert COALESCEs, so any value already in the column survives.
export function orderConfirmationSql() {
  return `SELECT t.tranid AS oc_number, BUILTIN.DF(t.entity) AS customer,
                 BUILTIN.DF(t.status) AS status, t.otherrefnum AS po_check_number,
                 TO_CHAR(t.startdate,'YYYY-MM-DD') AS startdate,
                 BUILTIN.DF(tl.item) AS item, tl.quantity, tl.itemtype,
                 COALESCE(lloc.fullname, hloc.fullname) AS location
          FROM transaction t
          JOIN transactionline tl ON tl.transaction = t.id
          LEFT JOIN location lloc ON lloc.id = tl.location
          LEFT JOIN location hloc ON hloc.id = t.location
          WHERE t.type='Estimate' AND tl.mainline='F'
            AND t.status IN (${OC_OPEN_CODES.map((c) => `'${c}'`).join(',')})`
}

// SuiteQL row → the same partial-record shape fromOcPipeline emits, so it flows
// through loadOrderConfirmations untouched.
//
// ⚠️ Estimate line quantities come back NEGATIVE (-6 for an order of 6) — the
// CSV column carried the positive figure, so this takes the absolute value.
// A null quantity stays null rather than collapsing to 0: non-item lines (the
// "EU Distributor" discount) genuinely have none, and the upsert COALESCEs, so
// a 0 would overwrite a real number while a null leaves it alone.
export function mapOrderConfirmationRow(row) {
  const q = row.quantity == null || row.quantity === '' ? null : Math.abs(Number(row.quantity))
  return {
    source: 'OcPipeline',
    ocNumber: String(row.oc_number || '').trim(),
    item: String(row.item || '').trim(),
    customer: cleanName(row.customer || ''),
    location: row.location || '',
    status: String(row.status || '').replace(/^Order Confirmation\s*:\s*/i, '').trim(),
    qty: Number.isFinite(q) ? q : null,
    poCheckNumber: row.po_check_number || '',
    orderStartDate: row.startdate || null,
  }
}

// Collapse the line rows to one record per (OC#, item) — the table's primary key.
//
// ⚠️ Summing here FIXES a silent undercount the CSV path has been carrying. An OC
// can list the same item on several lines (an amendment appends to the original
// order), and `loadOrderConfirmations` upserts row-by-row, so the later line
// simply overwrote the earlier one. Live proof: OC1596 lists SN02264NB-TEAK at
// line 7 (53 units) and again at line 120 (5 units); the frozen table records
// **5**, not 58. 15 items on that OC were understated the same way. Both lines
// are open demand for the same SKU, so the total is the honest figure.
//
// The "Memorized" filter mirrors fromOcPipeline's: those are recurring-transaction
// TEMPLATES, not real dated OCs. None appear in the live scope today; the guard
// stays so both paths agree on what counts as a row.
export function foldOrderConfirmationLines(rows = []) {
  const byKey = new Map()
  for (const row of rows) {
    const r = mapOrderConfirmationRow(row)
    if (!r.ocNumber || r.ocNumber === 'Memorized' || !r.item) continue
    // Freight, tax and discount lines are money on the OC, not goods anyone can
    // put on a container — so they can never match a PO and only ever surface as
    // permanent "unassigned demand" (296 open lines led by `UPS® Ground`,
    // `US_TX_NL`, `CA_NL`). Same DENY list as the sales-order roll-up: an unknown
    // itemtype still counts as an item, so a new Assembly or Kit lands in demand
    // rather than vanishing. Dropping them here rather than at read time means
    // pruneOrderConfirmations clears the rows already in the table.
    if (NON_ITEM_LINE_TYPES.includes(String(row.itemtype || '').trim())) continue
    const k = `${r.ocNumber}@@${r.item}`
    const seen = byKey.get(k)
    if (!seen) { byKey.set(k, r); continue }
    if (r.qty != null) seen.qty = (seen.qty ?? 0) + r.qty
  }
  return [...byKey.values()]
}

// ── the pull ─────────────────────────────────────────────────────────────────
// Returns { ok, records, soNumbers, ifNumbers, counts, truncated, warnings }.
// `records` is the flat partial-record list to hand to buildPipeline.
// Soft-fails (never throws) so a scheduled run can log and leave data intact.
// `invoiceWithinDays` is deliberately MUCH wider than `closedWithinDays`: the
// working window governs what needs attention, the document window governs what
// the trail can account for, and those are different questions. 180 days covers
// the 810 history that surfaced this (2026-05 onward) with headroom — measured
// live at 1,113 invoices vs 104 today; 365 days would be 3,553 if a trail ever
// needs to reach further. It does NOT widen `orders`, so no working queue,
// Kanban lane or court-strip count changes.
export async function fetchOrderLifecycle({ closedWithinDays = 30, invoiceWithinDays = 180, now, onStep } = {}) {
  if (!netsuiteConfigured()) return { ok: false, configured: false, records: [] }
  const since = windowStart(closedWithinDays, now)
  const invoiceSince = windowStart(Math.max(invoiceWithinDays, closedWithinDays), now)
  const warnings = []

  // `step` is the progress key from src/model/netsuiteRefreshSteps.js — announced
  // BEFORE the query goes out, so the button names what it is waiting on. Absent
  // on the scheduled path, which has nobody to report to.
  const run = async (label, sql, step) => {
    onStep?.(step)
    const r = await runSuiteQL(sql)
    if (!r.ok) return { fail: `${label}: ${r.needsAuth ? 'auth rejected' : r.error || 'failed'}` }
    if (r.truncated) warnings.push(`${label}: hit the page cap — result is INCOMPLETE`)
    return { rows: r.rows }
  }

  const orders = await run('orders', orderSql(since), 'orders')
  if (orders.fail) return { ok: false, error: orders.fail, records: [] }
  const locs = await run('locations', locationSql(since), 'locations')
  if (locs.fail) return { ok: false, error: locs.fail, records: [] }
  const lines = await run('order lines', orderLineSql(since), 'orderLines')
  if (lines.fail) return { ok: false, error: lines.fail, records: [] }
  const ifs = await run('fulfillments', fulfillmentSql(since), 'fulfillments')
  if (ifs.fail) return { ok: false, error: ifs.fail, records: [] }
  const invs = await run('invoices', invoiceSql(since, invoiceSince), 'invoices')
  if (invs.fail) return { ok: false, error: invs.fail, records: [] }
  const track = await run('tracking', trackingSql(since), 'tracking')
  if (track.fail) return { ok: false, error: track.fail, records: [] }

  // first non-null location per SO
  const locBySo = new Map()
  for (const r of locs.rows) {
    const so = String(r.tranid || '').toUpperCase()
    if (r.location && !locBySo.has(so)) locBySo.set(so, r.location)
  }

  // tracking numbers grouped per IF (multi-box shipments have several)
  const trackByIf = new Map()
  for (const r of track.rows) {
    const k = String(r.if_number || '').toUpperCase()
    if (!k || !r.trackingnumber) continue
    if (!trackByIf.has(k)) trackByIf.set(k, [])
    const arr = trackByIf.get(k)
    if (!arr.includes(r.trackingnumber)) arr.push(r.trackingnumber)
  }

  // IF → Invoice, derived via the shared SO. There is NO direct link to use:
  // probed live 2026-07-31, PreviousTransactionLineLink returns ZERO ItemShip →
  // CustInvc rows, because invoices are billed off the sales order, not the
  // fulfilment. The shared SO is the documented derivation (see CLAUDE.md).
  //
  // Why this is needed: mapFulfillmentRow can't know about invoices, so the live
  // path never wrote `fulfillments.invoice_number` — 148 of 156 rows were null
  // (the 8 survivors are CSV leftovers). getLaunchBay joins
  // `invoices i ON i.inv_number = f.invoice_number`, so the join matched almost
  // nothing and the step-5 gate read "awaiting invoice" even for IFs whose
  // invoice was sitting in the same database. Decoding custbody_invoice_status
  // alone would NOT have fixed the gate.
  //
  // Only an UNAMBIGUOUS SO gets the link. When an SO has several invoices we
  // cannot know which one covers which fulfilment, and guessing would put a
  // payment gate on the wrong shipment — so it stays null and reads as unknown,
  // which is the multi-document decision applied one field down. Rare in
  // practice: 93 of 94 invoiced SOs carry exactly one invoice.
  //
  // ⚠️ Only count an SO WE ACTUALLY PULLED. The wider invoice window (see
  // invoiceSql) surfaces historical invoices whose sales order is long gone from
  // the working set, and those raised the raw count from 1 to 33 — but 32 of the
  // 33 have no order row and no fulfilment here, so "their IFs are left unlinked"
  // described IFs that do not exist. Measured before widening: zero SOs lose a
  // link they hold today. A warning that inflates 1 into 33 trains you to ignore
  // it, so it now reports only ambiguity that can actually cost a gate.
  const { bySo: invBySo, ambiguous: allAmbiguous } = invoiceBySo(invs.rows)
  const pulledSos = new Set(orders.rows.map((r) => String(r.tranid || '').toUpperCase()))
  const ambiguousSos = allAmbiguous.filter((so) => pulledSos.has(so))
  if (ambiguousSos.length) {
    warnings.push(`${ambiguousSos.length} SO(s) have several invoices — their IFs are left unlinked rather than guessed`)
  }

  // Quantities are merged ON TOP of the mapped record rather than passed into
  // mapOrderRow, because they come from a different query with a different grain
  // (one row per line vs one per order). An SO the line pull didn't cover simply
  // gets no quantity keys — undefined, not zero, so the loader's COALESCE keeps
  // the last known value instead of blanking the order to 0 units.
  const qtyBySo = foldOrderLines(lines.rows)
  const orderRecords = orders.rows.map((r) => {
    const so = String(r.tranid || '').toUpperCase()
    return {
      ...mapOrderRow({ ...r, location: locBySo.get(so) || '' }),
      ...(qtyBySo.get(so) || {}),
    }
  })
  const ifRecords = ifs.rows.map(mapFulfillmentRow).map((f) => ({
    ...f,
    trackingNumbers: trackByIf.get(f.ifNumber) || null,
    invoice: invBySo.get(f.soNumber) || null,
  }))
  const invRecords = invs.rows.map(mapInvoiceRow)

  return {
    ok: true,
    records: [...orderRecords, ...ifRecords, ...invRecords],
    soNumbers: orderRecords.map((o) => o.soNumber),
    ifNumbers: ifRecords.map((f) => f.ifNumber),
    counts: {
      orders: orderRecords.length,
      orderLines: lines.rows.length,
      quantified: orderRecords.filter((o) => o.qtyOrdered != null).length,
      terminal: orderRecords.filter((o) => o.terminal).length,
      fulfillments: ifRecords.length,
      invoices: invRecords.length,
    },
    since,
    // What the document window covered this run — recorded by the sync so the
    // trail can honestly say an old 810 "predates our invoice records".
    invoiceSince,
    warnings,
  }
}

// ── the sync ─────────────────────────────────────────────────────────────────
// Pull → buildPipeline → load, all inside ONE transaction (same contract as
// importer.js: a bad row rolls the whole sync back rather than half-writing).
//
// Deliberately does NOT call pruneOrders. That prunes by ABSENCE from the master
// export and cascades to fulfillments — safe for a full open-orders CSV, but a
// live window is a different set, so pruning against it could delete live data.
// The live pull doesn't need it: it observes an order's REAL terminal status and
// records it (stage SHIPPED + Fully Billed), which is the whole point — the app
// sees orders finish instead of having them vanish.
//
// dryRun rolls the transaction back at the end, so every statement is exercised
// against real data and nothing persists.
//
// The purchase-order pull is a SEPARATE query kept off the order-lifecycle path:
// it reads a different transaction type and shares no join with the SO chain, so
// a PO failure has no business killing the outbound sync. It soft-fails into a
// warning for the same reason.
export async function fetchPurchaseOrderLines({ closedWithinDays = 30, now } = {}) {
  if (!netsuiteConfigured()) return { ok: false, configured: false, records: [] }
  const since = windowStart(closedWithinDays, now)
  const r = await runSuiteQL(purchaseOrderSql(since))
  if (!r.ok) {
    return { ok: false, configured: true, records: [], error: r.needsAuth ? 'auth rejected' : r.error || 'failed' }
  }
  return {
    ok: true,
    records: foldPurchaseOrderLines(r.rows),
    // A truncated PO pull must NOT reach prunePurchaseOrders — pruning against a
    // partial set would delete live lines that simply fell off the last page.
    truncated: !!r.truncated,
  }
}

// Pre-SO demand. Separate query for the same reason as the PO one: a different
// transaction type sharing no join with the SO chain, so it soft-fails on its own
// rather than taking the outbound sync down with it.
export async function fetchOrderConfirmationLines() {
  if (!netsuiteConfigured()) return { ok: false, configured: false, records: [] }
  const r = await runSuiteQL(orderConfirmationSql())
  if (!r.ok) {
    return { ok: false, configured: true, records: [], error: r.needsAuth ? 'auth rejected' : r.error || 'failed' }
  }
  return {
    ok: true,
    records: foldOrderConfirmationLines(r.rows),
    // Same rule as the PO pull: a truncated result must never reach the prune,
    // or lines that merely fell off the last page get deleted as "converted".
    truncated: !!r.truncated,
  }
}

export async function syncFromNetsuite({ closedWithinDays = 30, invoiceWithinDays = 180, dryRun = false, onStep } = {}) {
  const pulled = await fetchOrderLifecycle({ closedWithinDays, invoiceWithinDays, onStep })
  if (!pulled.ok) return { ok: false, configured: pulled.configured, error: pulled.error }

  // ⚠️ AN INVOICE RECORD MUST NOT MINT AN ORDER (2026-08-03). buildPipeline
  // merges every record by SO and emits one order per DISTINCT SO it saw — so the
  // moment the invoice pull got its own wider window, 985 historical sales orders
  // appeared here carrying nothing but an invoice: null customer, null location,
  // null status, and a ship date up to 650 days old. computeFlags then read them
  // as live work and app-wide attention went 153 → 1,121, every one of them a
  // phantom OVERDUE. That is the PR #34 "shipped orders read overdue forever" bug
  // at six times the scale.
  //
  // The invoice records still go THROUGH buildPipeline — that is how an order in
  // the working set gets promoted to INVOICED and picks up its gate — they just
  // can't create rows of their own. `soNumbers` is the order pull's own scope, so
  // this keeps `orders` exactly as wide as `orderSql` says it is.
  const pulledSos = new Set(pulled.soNumbers.map((s) => String(s || '').toUpperCase()))
  const orders = buildPipeline(pulled.records, { today: new Date() })
    .filter((o) => pulledSos.has(String(o.soNumber || '').toUpperCase()))
  for (const o of orders) o.source = deriveSource(o.customer, o.location)

  // Inbound supply. Soft-fails into a warning: a broken PO query should leave the
  // outbound sync — and the existing PO rows — exactly as they were.
  onStep?.('purchaseOrders')
  const pos = await fetchPurchaseOrderLines({ closedWithinDays })
  const warnings = [...(pulled.warnings || [])]
  if (!pos.ok && pos.configured !== false) warnings.push(`purchase orders: ${pos.error}`)
  if (pos.truncated) warnings.push('purchase orders: hit the page cap — result is INCOMPLETE, not pruning')

  // Pre-SO demand, soft-failing on the same terms.
  onStep?.('orderConfirmations')
  const ocs = await fetchOrderConfirmationLines()
  if (!ocs.ok && ocs.configured !== false) warnings.push(`order confirmations: ${ocs.error}`)
  if (ocs.truncated) warnings.push('order confirmations: hit the page cap — result is INCOMPLETE, not pruning')

  const { withTransaction } = await import('../db.js')
  const {
    loadOrders, loadFulfillments, loadInvoices, recordInvoiceWindow, recordSnapshot,
    stampApprovedForShipping, stampShippedValue, clearDepartedCustody, clearDepartedDcCustody,
    reconcileFulfillments, archiveNetsuiteShippedShipments, refreshShipmentEdiSnapshots,
    deriveOrderEvents, loadPurchaseOrders, prunePurchaseOrders,
    loadOrderConfirmations, pruneOrderConfirmations,
  } = await import('./loadToDb.js')

  const ROLLBACK = Symbol('dry-run rollback')
  let result
  try {
    result = await withTransaction(async (db) => {
      onStep?.('saveOrders')
      const nOrders = await loadOrders(orders, db)
      onStep?.('saveFulfillments')
      const nFul = await loadFulfillments(pulled.records, db)
      onStep?.('saveInvoices')
      const nInv = await loadInvoices(pulled.records, db)
      onStep?.('stamps')
      await recordInvoiceWindow(pulled.invoiceSince, db)
      await stampApprovedForShipping(pulled.records, db)
      const nCredits = await stampShippedValue(pulled.records, db)
      await clearDepartedCustody(pulled.records, db)
      await clearDepartedDcCustody(db) // the per-DC cargo tags — nothing closed them before 2026-08-06
      // Kill fulfillments that no longer exist in NetSuite, scoped to the SOs we
      // actually pulled (see reconcileFulfillments — never a whole-table prune).
      onStep?.('reconcile')
      const nPhantoms = await reconcileFulfillments(pulled.soNumbers, pulled.ifNumbers, db)
      // Freight NetSuite now says has fully shipped shouldn't still sit on the
      // active routing board (Nima, 2026-08-01 — 7 Bloomingdale's BOLs were
      // stuck there only because nothing ever ran this sync).
      const archived = await archiveNetsuiteShippedShipments(db)
      // Keep already-frozen EDI snapshots current while their 856 is still in
      // the Orderful window (a fresh ASN is PENDING for hours before the 997).
      const nEdiRefreshed = await refreshShipmentEdiSnapshots(db)
      // Inbound supply. Prune only on a complete pull, and only ever against a
      // non-empty set (prunePurchaseOrders guards that too) — a received PO drops
      // out of the open window, so its lines should drop off the table with it.
      onStep?.('savePos')
      let nPos = 0
      let nPosPruned = 0
      if (pos.ok && pos.records.length) {
        nPos = await loadPurchaseOrders(pos.records, db)
        if (!pos.truncated) nPosPruned = await prunePurchaseOrders(pos.records, db)
      }
      // Pre-SO demand. Pruning matters more here than anywhere else: an OC that
      // converts to a Sales Order leaves the scope entirely, and if its lines
      // lingered the app would count the same demand twice — once as an open OC
      // and again as the real order.
      onStep?.('saveOcs')
      let nOcs = 0
      let nOcsPruned = 0
      if (ocs.ok && ocs.records.length) {
        nOcs = await loadOrderConfirmations(ocs.records, db)
        if (!ocs.truncated) nOcsPruned = await pruneOrderConfirmations(ocs.records, db)
      }
      // Last, because it reads the tables everything above has just written.
      onStep?.('events')
      const { inserted: nEvents } = await deriveOrderEvents({ mode: 'sync' }, db)
      await recordSnapshot('netsuiteLive', orders.length, new Date(), db)
      const out = { nOrders, nFul, nInv, nCredits, nPhantoms, archived, nEdiRefreshed, nEvents, nPos, nPosPruned, nOcs, nOcsPruned }
      if (dryRun) {
        const e = new Error('dry run')
        e.code = ROLLBACK
        e.partial = out
        throw e
      }
      return out
    })
  } catch (e) {
    if (e?.code === ROLLBACK) {
      return { ok: true, dryRun: true, ...e.partial, counts: pulled.counts, since: pulled.since, warnings, rolledBack: true }
    }
    return { ok: false, error: e?.message || String(e) }
  }

  // External mirror: open PO lines → the Naghedi-Warehouse app's Supabase
  // (see warehouseFeed.js). AFTER the transaction on purpose — a Supabase
  // hiccup must never roll back our own sync — and only on real runs: the
  // dry-run path has already returned above, and an external write can't be
  // rolled back anyway. Soft-fails into a warning like the PO/OC pulls; its
  // own snapshot row makes "when did the feed last land" queryable.
  const wh = await pushWarehousePoLines()
  let warehousePush = 0
  if (wh.ok) {
    warehousePush = wh.pushed
    const { recordSnapshot } = await import('./loadToDb.js')
    await recordSnapshot('warehousePoFeed', wh.pushed, new Date())
  } else if (wh.configured !== false) {
    warnings.push(`warehouse PO feed: ${wh.error}`)
  }

  // Second mirror, same discipline: stocked item-location quantities →
  // ns_item_location_qtys (the app's inventory view). Independent of the PO
  // push on purpose — one feed failing must not silence the other.
  const inv = await pushWarehouseInventory()
  let warehouseInventoryPush = 0
  if (inv.ok) {
    warehouseInventoryPush = inv.pushed
    const { recordSnapshot } = await import('./loadToDb.js')
    await recordSnapshot('warehouseInventoryFeed', inv.pushed, new Date())
  } else if (inv.configured !== false) {
    warnings.push(`warehouse inventory feed: ${inv.error}`)
  }

  return { ok: true, ...result, warehousePush, warehouseInventoryPush, counts: pulled.counts, since: pulled.since, warnings }
}
