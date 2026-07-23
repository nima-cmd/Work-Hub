// src/ingest/savedSearches.js
// Maps each NetSuite saved-search CSV shape into partial "pipeline records".
//
// You told me these saved searches WILL be adjusted over time, so every mapper
// reads by column *name* and tolerates missing columns — a renamed or dropped
// column degrades gracefully instead of crashing. When a search changes, we
// update only the relevant mapper here.

import { STAGE } from '../model/stages.js'
import { parseDc, dcAbbrev } from '../model/dc.js'

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

// ── 1) Warehouse Order Pipeline (SO-based) — the consolidated demand+invoice search
// One row per Sales Order carrying demand, approval, and (via the Billing
// Transaction join) its invoice. Because the invoice is on the same row, this
// search alone drives On Hold / Open / Invoiced / Approved. Picked/Packed come
// from the separate fulfillment search and merge in by SO#.
//
// The invoice join columns arrive with generic/duplicate headers, so we read
// them by their exact (parser-disambiguated) names AND accept clean custom
// labels if they're set later:
//   - INV#            = "Invoice Number" | "Maximum of Document Number"
//   - Open/Paid       = "Invoice Status"  | "Maximum of Status (2)" (2nd "Status")
//   - shipping status = "Invoice Shipping Status" | "Maximum of Invoice Status"
// Rows can come from the CSV export (aggregated "Maximum of X" / "Sum of X"
// column names) or a live pull of the same saved search via the NetSuite
// connection (plain column names, duplicate columns suffixed "_1" instead of
// aggregated) — see [[orderful-api-confirmed-shape]]-style memory note on
// NetSuite live-pull field names. Confirmed against real invoiced rows
// 2026-07-13: live "Invoice Status" holds SHIPPING status semantics (Shipped/
// Pending Payment/Approved For Shipping), and live "Status_1" holds the
// Open/Paid In Full invoice status — the field names alone are misleading,
// this was checked against actual data, not assumed.
export function fromOpenSalesOrders(rows) {
  return rows
    .filter((r) => r['Document Number'] && r['Document Number'] !== 'Total')
    .map((r) => {
      const approvalStatus = r['Maximum of Approval Status'] || r['Approval Status'] || ''
      const invoice = refNumber(r['Invoice Number'] || r['Maximum of Document Number'] || r['Document Number_1'] || '')
      const invoiceStatus = r['Maximum of Status (2)'] || r['Status_1'] || (r['Document Number_1'] ? r['Invoice Status'] : '') || '' // Open / Paid In Full
      const shippingStatus = r['Invoice Shipping Status'] || r['Maximum of Invoice Status'] || (r['Document Number_1'] ? '' : r['Invoice Status']) || ''
      const hasInvoice = !!invoice

      // Stage from this row alone: an invoice means it's past packing (Invoiced,
      // which buildPipeline promotes to Approved via shippingStatus); otherwise
      // On Hold blocks fulfillment; otherwise Open. Picked/Packed override via
      // the fulfillment search when furtherStage picks the higher rank.
      let stage = STAGE.OPEN
      if (hasInvoice) stage = STAGE.INVOICED
      else if (/hold/i.test(approvalStatus)) stage = STAGE.ON_HOLD

      // DC + store (Nima, 2026-07-22): fold the 856-ASN search's per-SO "DC Code"
      // + "Store Number" into the Order Pipeline so the DC lives on the order —
      // no separate CSV. Tolerant: use the explicit columns if present, else
      // parse the DC out of the full ship-to name ("… DC - Secaucus : …") when
      // the search returns the hierarchy path; null when neither is available.
      const rawName = r['Maximum of Name'] || r['Maximum of Company Name'] || r['Company Name'] || ''
      const dcCode = (r['DC Code'] || r['Maximum of DC Code'] || '').trim() || dcAbbrev(parseDc(rawName)) || null
      const storeNumber = (r['Store Number'] || r['Maximum of Store Number'] || '').trim() || null

      return {
        source: 'WarehouseOrderPipeline',
        stage,
        soNumber: refNumber(r['Document Number']),
        customer: rawName,
        dc: dcCode,
        storeNumber,
        location: r['Maximum of Location'] || r['Location'] || '',
        poNumber: r['Maximum of PO/Check Number'] || r['PO/Check Number'] || '',
        soStatus: r['Maximum of Status'] || r['Status'] || '',
        approvalStatus,
        isAts: /yes/i.test(r['Maximum of Is ATS Order'] || r['Is ATS Order'] || ''),
        startDate: toDate(r['Maximum of Start Date'] || r['Start Date']),
        endDate: toDate(r['Maximum of End Date'] || r['End Date']),
        qtyOrdered: num(r['Sum of Quantity'] || r['Quantity']),
        qtyAllocated: num(r['Sum of Quantity Committed'] || r['Sum of Allocated Supply'] || r['Quantity Committed']),
        qtyFulfilled: num(r['Sum of Quantity Fulfilled/Received'] || r['Quantity Fulfilled/Received']),
        // invoice side (present only once an invoice exists)
        invoice,
        invoiceStatus,
        shippingStatus,
        amountRemaining: num(r['Invoice Amount Remaining'] || r['Maximum of Amount Remaining'] || r['Amount Remaining']),
        shipDate: toDate(r['Maximum of Ship Date'] || r['Ship Date']),
        cancelDate: toDate(r['Maximum of Order Cancel Date'] || r['Maximum of Cancel Date'] || r['Order Cancel Date']),
      }
    })
}

// ── 1b) Warehouse Fulfillment Pipeline (IF-based) — Picked/Packed fulfillments
// Replaces the old "Item Fulfilment unpacked" + "Pending Orders" searches with
// one IF-based export. Needed because a Sales-Order search can't see Picked or
// Packed IFs (NetSuite only links a fulfillment to the SO line once it SHIPS).
// Merges into orders by SO# (Created From). Transfer Orders are dropped here.
export function fromFulfillmentPipeline(rows) {
  const stageFor = (s) =>
    /packed/i.test(s) ? STAGE.PACKED : /shipped/i.test(s) ? STAGE.SHIPPED : STAGE.PICKED
  return rows
    .filter(
      (r) => r['Document Number'] && !/transfer order/i.test(r['Maximum of Created From'] || r['Created From'] || ''),
    )
    .map((r) => {
      const ifStatus = r['Maximum of Status'] || r['Status'] || ''
      return {
        source: 'FulfillmentPipeline',
        stage: stageFor(ifStatus),
        soNumber: refNumber(r['Maximum of Created From'] || r['Created From'] || ''),
        ifNumber: refNumber(r['Document Number']),
        customer: cleanName(r['Maximum of Name'] || r['Name'] || ''),
        location: r['Maximum of Location'] || '',
        ifStatus, // Picked / Packed / Shipped
        date: toDate(r['Maximum of Date'] || r['Date']),
      }
    })
}

// ── 2) Item Fulfilment unpacked.csv — IFs picked, or shipped ────────────────
// Widened live 2026-07-08: this search's Status filter now includes Shipped
// alongside Picked (Packed stays owned by the Pending Orders search below),
// so we branch per row instead of assuming the whole file is one stage.
export function fromUnpackedFulfillments(rows) {
  return rows
    // Transfer Orders aren't tracked (this app's spine is Sales Orders) — drop
    // them here, at the source, so downstream code never sees a TO-linked
    // record at all (buildPipeline also skips them, but loadFulfillments/
    // loadInvoices read the raw record list directly, bypassing that skip).
    .filter((r) => r['Document Number'] && !/transfer order/i.test(r['Created From'] || ''))
    .map((r) => {
      const ifStatus = r['Status'] || ''
      const shipped = /shipped/i.test(ifStatus)
      return {
        source: 'ItemFulfilmentUnpacked',
        stage: shipped ? STAGE.SHIPPED : STAGE.PICKED,
        soNumber: refNumber(r['Created From']),
        ifNumber: refNumber(r['Document Number']),
        customer: cleanName(r['Name']),
        ifStatus, // "Picked" or "Shipped"
        date: toDate(r['Date']),
        actualShipDate: shipped ? toDate(r['Date']) : null,
      }
    })
}

// ── 3) Pending Orders.csv — IFs packed, waiting on invoice/payment/ship ─────
export function fromPendingOrders(rows) {
  return rows
    .filter((r) => r['Document Number'] && !/transfer order/i.test(r['Created From'] || ''))
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

// ── Warehouse PO Receiving Pipeline.csv — inbound supply (Purchase Orders) ──
// Line-level export (one row per PO/Item), NOT grouped — unlike the SO search,
// we need per-item quantities to match against short demand. Rows with no
// Item are PO header/total rows with nothing to match on; drop them here so
// the loader never sees a null half of its (po_number, item) primary key.
//
// "Ship To" is a channel proxy Nima added: "000 NAGHEDI" = ecomm/boutique
// in-house receiving; any named customer (Nordstrom, Yagi, Mitchells, Saint
// Bernard, etc.) means the container was produced FOR that account directly.
// "Final Naghedi Destination" is the actual OC↔PO match key (see naghedi-
// locations memory) — Ship To is a secondary signal, not a replacement.
export function fromPoReceiving(rows) {
  return rows
    .filter((r) => r['Document Number'] && r['Item'])
    .map((r) => ({
      source: 'PoReceiving',
      poNumber: refNumber(r['Document Number']),
      item: r['Item'].trim(),
      vendor: cleanName(r['Name'] || ''),
      shipTo: cleanName(r['Ship To'] || ''),
      destination: r['Final Naghedi Destination'] || '',
      status: r['Status'] || '', // Pending Receipt / Partially Received / Pending Billing/Partially Received
      qtyOrdered: num(r['Quantity']),
      qtyReceived: num(r['Quantity Fulfilled/Received']),
      qtyRemaining: num(r['Quantity Remaining']),
      expectedReceipt: toDate(r['Due Date/Receive By']),
    }))
}

// ── 856 ASN / BOL search — the Orderful 856↔850 join key ───────────────────
// Nima's existing export for Airtable's "NetSuite Fulfillments" table. BOL is
// what an Orderful 856 transaction's businessNumber actually matches for some
// partners (e.g. a Shopbop 856's businessNumber is a UPS tracking number, not
// the PO#) — so this is what re-links a fragmented ASN back to its PO. The
// trailing rows with no PO DC Identifier ("-") are garbage from the search
// itself, dropped here.
export function fromEdiFulfillments(rows) {
  return rows
    .filter((r) => r['PO DC Identifier'] && r['PO DC Identifier'] !== '-')
    .map((r) => ({
      poDcIdentifier: r['PO DC Identifier'],
      poNumber: r['Maximum of PO Number'] || '',
      dc: r['Maximum of DC'] || '',
      bol: r['Maximum of BOL'] || '',
      scac: r['Maximum of SCAC'] || '',
      proNumber: r['Maximum of Pro Number'] || '',
      dcCity: r['Maximum of DC City'] || '',
      shipDate: toDate(r['Maximum of Ship Date']),
      ediSynced: (r['EDI Synced'] || '').trim().toLowerCase() === 'yes',
    }))
}

// ── Warehouse OC Pipeline.csv — pre-SO demand (Order Confirmations) ────────
// NetSuite record type: Estimate, filtered to "no Sales Order created from it
// yet" so this never double-counts against fromOpenSalesOrders. Two kinds of
// noise to drop at the source:
//   - "Memorized" rows: recurring-transaction TEMPLATES, not real dated OCs —
//     no Status/Location, just a placeholder for future auto-generation.
//   - rows with no Item: nothing to match on.
// "PO/Check Number" here is a free-text production-run/collection label
// (e.g. "Bloom Fall Shoe 2025", "NordFebStore26") confirmed on real data —
// NOT the numeric internal PO# from fromPoReceiving, so it is NOT the OC<->PO
// join key. Item + Location (vs purchase_orders.destination) is.
export function fromOcPipeline(rows) {
  return rows
    .filter((r) => r['Document Number'] && r['Document Number'] !== 'Memorized' && r['Item'])
    .map((r) => ({
      source: 'OcPipeline',
      ocNumber: refNumber(r['Document Number']),
      item: r['Item'].trim(),
      customer: cleanName(r['Name'] || ''),
      shipTo: cleanName(r['Ship To'] || ''),
      location: r['Location'] || '',
      status: r['Status'] || '', // Open / Expired
      qty: num(r['Quantity']),
      poCheckNumber: r['PO/Check Number'] || '',
      orderStartDate: toDate(r['Order Start Date']),
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
      invoiceStatus: r['Status'] || '', // same source; loadInvoices reads invoiceStatus
      shippingStatus: r['Shipping Status'] || '', // Pending Payment / FOB Pending Approval / Approved For Shipping
      amountPaid: num(r['Amount Paid']),
      shipDate: toDate(r['Ship Date']),
      startDate: toDate(r['Start Date']),
      cancelDate: toDate(r['Cancel Date']),
      notes: r['Notes'] || '',
      approvalStatus: r['Approval Status'] || '',
    }))
}

// ── EDIPackagesVolume.csv — the routing feed (searchid=3947, Nima 2026-07-22) ─
// Pre-aggregated per PO-DC (one row per "<PO>-<DCcode>"), from the packing done
// in NetSuite's Orderful tab (customrecord_hb_edi_packages). Feeds the Routing
// view, which consolidates these rows into one shipment/BOL per DC. The export
// carries a trailing "Total" summary row — dropped here.
//
//   PO Number - DC        "7527064-CG"  → poNumber 7527064, dc CG
//   Total Weight (lbs)    per PO-DC, summed again across POs in the rollup
//   Carton Count / Total Units
//   Cubic Feet (Rounded)  the feed's own per-row round-up (kept for cross-check)
//   Cubic Feet            raw — what the rollup sums then ceils per DC
//   BOL                   the feed's *suggested* BOL ("<PO>DC<code>"); the app
//                         mints its own guaranteed-unique number, so this is
//                         reference-only.
export function fromEdiPackagesVolume(rows) {
  return rows
    .filter((r) => {
      const id = (r['PO Number - DC'] || '').trim()
      return id && id.toLowerCase() !== 'total'
    })
    .map((r) => {
      const id = (r['PO Number - DC'] || '').trim()
      const dash = id.indexOf('-')
      const poNumber = dash === -1 ? id : id.slice(0, dash).trim()
      const dc = dash === -1 ? '' : id.slice(dash + 1).trim()
      return {
        poDc: id,
        poNumber,
        dc,
        weight: num(r['Total Weight (lbs)']),
        cartons: num(r['Carton Count']),
        units: num(r['Total Units']),
        cubicFeetRounded: num(r['Cubic Feet (Rounded)']),
        cubicFeetRaw: num(r['Cubic Feet']),
        suggestedBol: (r['BOL'] || '').trim(),
      }
    })
}
