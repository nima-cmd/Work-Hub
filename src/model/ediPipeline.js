// src/model/ediPipeline.js
// Groups raw Orderful transactions (src/ingest/orderful.js) by Business
// Number — the same join key Airtable's 850 Tracker/856 tables use — into one
// pipeline row per EDI order: which documents have moved, how far along it
// is, and whether anything needs attention (rejected, failed, overdue).
//
// The 850 is the master document (Nima, 2026-07-10) — every 856 and 810 must
// resolve to one. Three ways that happens, checked in priority order:
//   1. A human manually linked it (edi_manual_links) — always visibly flagged,
//      never silently treated as automated.
//   2. Its businessNumber IS a PO# shared with an 850 (the common case).
//   3. Its businessNumber is a BOL that maps to one or more PO#s (the 856
//      ASN/BOL saved-search export — see src/ingest/loadToDb.js).
// Anything left over — an 856/810 with no 850 anywhere — is a real gap, not
// something to bury: it gets its own bucket so it can be linked by hand.

// Rough order documents move in for a wholesale EDI order. Anything not
// listed (846 inventory advice, etc.) still shows in the transaction list,
// it just doesn't move the stage indicator.
// Exact type strings confirmed against real synced data (2026-07-10) — do not
// guess at these, Orderful's naming doesn't match the plain "850/856/810" shorthand.
const STAGE_RANK = {
  '850_PURCHASE_ORDER': 1,
  '860_PURCHASE_ORDER_CHANGE_REQUEST_BUYER_INITIATED': 2,
  '856_SHIP_NOTICE_MANIFEST': 3,
  '810_INVOICE': 4,
}
const STAGE_LABEL = {
  1: 'PO received',
  2: 'PO change requested',
  3: 'Shipped (ASN sent)',
  4: 'Invoiced',
}

function hasIssue(t) {
  return (
    t.validationStatus === 'INVALID' ||
    t.deliveryStatus === 'FAILED' ||
    t.acknowledgmentStatus === 'REJECTED' ||
    t.acknowledgmentStatus === 'OVERDUE'
  )
}

// `netsuiteOrders` (from the main SO pipeline, keyed by PO#, with the same
// stage/nextAction labels the rest of the app uses — see src/model/stages.js)
// lets us track a PO's real physical state from the moment its 850 lands,
// without re-deriving NetSuite's own pipeline:
//   - NEEDS_IMPORT: only an 850 exists, NetSuite hasn't shipped it — hasn't
//     started moving yet (no SO, or SO still early-stage).
//   - NEEDS_ASN: NetSuite already shows it shipped, but Orderful has no 856
//     yet — an EDI compliance gap, not a warehouse one.
//   - CANNOT_LINK: has an 850, but a further document (856/810) exists with
//     no matching NetSuite fulfillment/invoice.
//   - NO_850_FOUND: an 856 or 810 exists with no 850 anywhere — the master
//     document is missing; needs a manual link (see `manualLinks`).
export function computeEdiPipeline(transactions = [], fulfillments = [], netsuiteOrders = [], manualLinks = [], documentPoRefs = []) {
  const bolToPoNumbers = new Map() // bol -> Set<po_number>
  const fulfillmentsByPoNumber = new Map() // po_number -> fulfillment[]
  for (const f of fulfillments) {
    if (f.bol && f.poNumber) {
      if (!bolToPoNumbers.has(f.bol)) bolToPoNumbers.set(f.bol, new Set())
      bolToPoNumbers.get(f.bol).add(f.poNumber)
    }
    if (f.poNumber) {
      if (!fulfillmentsByPoNumber.has(f.poNumber)) fulfillmentsByPoNumber.set(f.poNumber, [])
      fulfillmentsByPoNumber.get(f.poNumber).push(f)
    }
  }

  // Extracted straight from each 856/810's own message body (see
  // src/ingest/orderful.js) — more authoritative than the BOL guess, since
  // it's the PO reference the document itself carries, not an inferred join.
  const docPoRefsByTxnId = new Map()
  for (const r of documentPoRefs) {
    if (!docPoRefsByTxnId.has(r.transactionId)) docPoRefsByTxnId.set(r.transactionId, new Set())
    docPoRefsByTxnId.get(r.transactionId).add(r.poNumber)
  }

  const netsuiteByPoNumber = new Map()
  for (const o of netsuiteOrders) {
    if (o.poNumber) netsuiteByPoNumber.set(o.poNumber, o)
  }

  const manualLinkByTxnId = new Map(manualLinks.map((l) => [l.transactionId, l]))

  const byBusinessNumber = new Map()
  const addTo = (key, t) => {
    if (!byBusinessNumber.has(key)) byBusinessNumber.set(key, [])
    byBusinessNumber.get(key).push(t)
  }
  for (const t of transactions) {
    const manualLink = manualLinkByTxnId.get(t.id)
    const docPoRefs = docPoRefsByTxnId.get(t.id)
    const bolPoNumbers = bolToPoNumbers.get(t.businessNumber)
    if (manualLink) {
      addTo(manualLink.businessNumber, { ...t, manualLinkNote: manualLink.note || null })
    } else if (docPoRefs && docPoRefs.size) {
      for (const po of docPoRefs) addTo(po, t)
    } else if (bolPoNumbers && bolPoNumbers.size) {
      for (const po of bolPoNumbers) addTo(po, t)
    } else {
      addTo(t.businessNumber || `(no business number: ${t.id})`, t)
    }
  }

  const orders = [...byBusinessNumber.entries()].map(([businessNumber, txns]) => {
    // A shared BOL can duplicate the same ASN into several PO groups above —
    // dedupe by transaction id so one order doesn't show it twice.
    const sorted = [...new Map(txns.map((t) => [t.id, t])).values()].sort(
      (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
    )
    const stageRank = sorted.reduce((max, t) => Math.max(max, STAGE_RANK[t.type] || 0), 0)
    const tradingPartner = sorted.find((t) => t.tradingPartner)?.tradingPartner || null
    const netsuiteOrder = netsuiteByPoNumber.get(businessNumber) || null
    const netsuiteShipped = netsuiteOrder?.stage === 'SHIPPED'
    const po850 = sorted.find((t) => t.type === '850_PURCHASE_ORDER')
    const hasManualLinks = sorted.some((t) => manualLinkByTxnId.has(t.id))

    // Only meaningful when we DO have a currently-open NetSuite order to check
    // against — if there's no netsuiteOrder at all, that usually just means
    // it's already shipped/closed and aged out of the open pipeline, not a
    // real linking failure (see [[orderful-api-confirmed-shape]] memory).
    const linkGaps = []
    if (netsuiteOrder) {
      if (stageRank >= 3 && !netsuiteOrder.itemFulfillments?.length) {
        linkGaps.push('ASN sent, no matching NetSuite fulfillment found')
      }
      if (stageRank >= 4 && !netsuiteOrder.invoices?.length) {
        linkGaps.push('Invoice sent, no matching NetSuite invoice found')
      }
    }

    let bucket = 'OTHER'
    if (!po850) bucket = 'NO_850_FOUND'
    else if (stageRank <= 1 && !netsuiteShipped) bucket = 'NEEDS_IMPORT'
    else if (netsuiteShipped && stageRank < 3) bucket = 'NEEDS_ASN'
    else if (linkGaps.length) bucket = 'CANNOT_LINK'

    return {
      businessNumber,
      tradingPartner,
      stage: STAGE_LABEL[stageRank] || 'Unrecognized document',
      stageRank,
      hasIssue: sorted.some(hasIssue),
      hasManualLinks,
      lastUpdatedAt: sorted.reduce((max, t) => (t.lastUpdatedAt > max ? t.lastUpdatedAt : max), sorted[0]?.lastUpdatedAt || null),
      shipNotBefore: po850?.shipNotBefore || null,
      cancelAfter: po850?.cancelAfter || null,
      transactions: sorted,
      fulfillments: fulfillmentsByPoNumber.get(businessNumber) || [],
      netsuiteOrder,
      linkGaps,
      bucket,
    }
  })

  const partners = new Map()
  for (const o of orders) {
    const key = o.tradingPartner || '(unknown partner)'
    if (!partners.has(key)) {
      partners.set(key, {
        tradingPartner: key, orderCount: 0, issueCount: 0,
        needsImportCount: 0, needsAsnCount: 0, cannotLinkCount: 0, no850Count: 0,
      })
    }
    const p = partners.get(key)
    p.orderCount++
    if (o.hasIssue) p.issueCount++
    if (o.bucket === 'NEEDS_IMPORT') p.needsImportCount++
    if (o.bucket === 'NEEDS_ASN') p.needsAsnCount++
    if (o.bucket === 'CANNOT_LINK') p.cannotLinkCount++
    if (o.bucket === 'NO_850_FOUND') p.no850Count++
  }

  return {
    partners: [...partners.values()].sort((a, b) => b.orderCount - a.orderCount),
    orders: orders.sort((a, b) => new Date(b.lastUpdatedAt || 0) - new Date(a.lastUpdatedAt || 0)),
  }
}
