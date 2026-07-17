// src/model/pipeline.js
// Merges partial records from every source into ONE order per SO number,
// derives the current stage, and applies your warehouse color/priority rules
// (the legend on the "Packed, Not Yet Shipped" portlet) as machine-readable
// flags.

import { STAGE, furthestStage } from './stages.js'

const DAY = 86_400_000

// The invoiced search's "Shipping Status" tells us whether an invoiced order
// has already been approved to ship, or is still waiting on payment/approval.
function stageFromShipping(shippingStatus) {
  const s = (shippingStatus || '').toLowerCase()
  if (s.includes('approved for shipping') || s.includes('shipped')) return STAGE.APPROVED
  return STAGE.INVOICED // "Pending Payment", "FOB Pending Approval", etc.
}

export function buildPipeline(allRecords, { today = new Date() } = {}) {
  const orders = new Map()

  const getOrder = (so) => {
    const key = so || 'UNLINKED'
    if (!orders.has(key)) {
      orders.set(key, {
        soNumber: key,
        customer: '',
        location: '',
        poNumber: '',
        stage: null,
        fulfillments: [],
        sources: new Set(),
        shippingStatus: '',
        soStatus: '',
        amountPaid: null,
        shipDate: null,
        startDate: null,
        endDate: null,
        cancelDate: null,
        notes: '',
        daysPending: null,
        invoice: '',
        qtyOrdered: null,
        qtyAllocated: null,
        qtyFulfilled: null,
        isAts: false,
        approvalStatus: '',
        actualShipDate: null,
        billingStatus: '',
      })
    }
    return orders.get(key)
  }

  // Fields we copy straight through from a record onto the order (first
  // non-empty value wins, so richer sources don't get overwritten by blanks).
  const CARRY = [
    'shippingStatus', 'soStatus', 'amountPaid', 'shipDate', 'startDate',
    'endDate', 'cancelDate', 'notes', 'qtyOrdered', 'qtyAllocated',
    'qtyFulfilled', 'isAts', 'invoice', 'approvalStatus', 'actualShipDate',
    'billingStatus',
  ]

  for (const rec of allRecords) {
    // This tracker's spine is Sales Orders — Transfer Orders (TO#) sometimes
    // show up in the Item Fulfillment searches (a TO can have its own IF) but
    // aren't sales pipeline work, so they're not tracked here.
    if (/^TO\d/.test(rec.soNumber || '')) continue

    const o = getOrder(rec.soNumber)
    o.sources.add(rec.source)
    if (rec.customer && !o.customer) o.customer = rec.customer
    if (rec.location && !o.location) o.location = rec.location
    if (rec.poNumber) o.poNumber = rec.poNumber

    // advance the order's stage to the furthest point any source reports
    let recStage = rec.stage
    if (rec.stage === STAGE.INVOICED) recStage = stageFromShipping(rec.shippingStatus)
    o.stage = furthestStage(o.stage, recStage)

    for (const k of CARRY) {
      const empty = o[k] == null || o[k] === '' || o[k] === false
      if (rec[k] != null && rec[k] !== '' && empty) o[k] = rec[k]
    }

    // Picked-fulfillment records don't carry a "Days Pending" column (only a
    // creation date), so compute it here — otherwise the Picked bin never
    // gets an aging/staleness flag. Written back onto `rec` (not just a local)
    // since loadFulfillments() reads the same record objects separately.
    if (rec.daysPending == null && rec.date) {
      rec.daysPending = daysBetween(rec.date, today)
    }
    if (rec.daysPending != null) {
      o.daysPending = Math.max(o.daysPending ?? 0, rec.daysPending)
    }

    // attach the item fulfillment (if this record is one)
    if (rec.ifNumber) {
      o.fulfillments.push({
        ifNumber: rec.ifNumber,
        status: rec.ifStatus || rec.packedStatus || '',
        packedStatus: rec.packedStatus || '',
        daysPending: rec.daysPending,
        invoice: rec.invoice || '',
        actualShipDate: rec.actualShipDate || null,
      })
    }
  }

  for (const o of orders.values()) {
    o.flags = computeFlags(o, today)
    o.sources = [...o.sources]
  }
  return [...orders.values()]
}

// Your warehouse legend, as code. severity: 3 = act now, 2 = caution, 1 = watch.
// Exported so the API/UI compute the exact same flags as the CLI analyzer.
export function computeFlags(o, today) {
  const flags = []
  const ss = (o.shippingStatus || '').toLowerCase()
  const shipDay = o.shipDate ? daysBetween(today, o.shipDate) : null

  const waitingOnPayment =
    ss.includes('pending payment') ||
    o.fulfillments.some((f) => /waiting on payment/i.test(f.packedStatus))
  if (waitingOnPayment) {
    flags.push({ key: 'PENDING_PAYMENT', label: 'Pending payment — do not ship before payment', severity: 2 })
  }

  const fobHold = ss.includes('fob') || o.fulfillments.some((f) => /fob/i.test(f.packedStatus))
  if (fobHold) {
    flags.push({ key: 'FOB_HOLD', label: 'FOB pending approval — verify before shipping', severity: 2 })
  }

  if (shipDay != null && shipDay < 0) {
    flags.push({ key: 'OVERDUE', label: `Ship date ${-shipDay}d overdue`, severity: 3 })
  } else if (shipDay === 0) {
    flags.push({ key: 'DUE_TODAY', label: 'Ship date is today', severity: 2 })
  }

  if (o.daysPending != null && o.daysPending >= 14) {
    flags.push({ key: 'STALE', label: `${o.daysPending}d pending — chase it`, severity: 3 })
  } else if (o.daysPending != null && o.daysPending >= 7) {
    flags.push({ key: 'AGING', label: `${o.daysPending}d pending`, severity: 1 })
  }

  // ── Custody (QR label scans — Nima, 2026-07-17) ────────────────────────────
  // The IF-created → packed gap NetSuite has no record of: each IF's label is
  // scanned OUT when handed to the warehouse and IN when it comes back.
  // State = latest OUT vs latest IN (re-handoffs happen). Only meaningful
  // while the order is still PICKED — once packed, custody has resolved.
  const hasCustodyScans = o.fulfillments.some((f) => f.custodyOut || f.custodyIn)
  if (o.stage === STAGE.PICKED) {
    for (const f of o.fulfillments) {
      const out = f.custodyOut ? new Date(f.custodyOut) : null
      const inn = f.custodyIn ? new Date(f.custodyIn) : null
      if (out && (!inn || out > inn)) {
        // Handed off, not back yet — the aging clock that PICK_STALLED could
        // only guess at now starts from the actual handoff scan.
        const daysOut = daysBetween(out, today)
        if (daysOut >= 3) {
          flags.push({
            key: 'WAREHOUSE_HOLDS',
            label: `${f.ifNumber} with warehouse ${daysOut}d — chase it`,
            severity: 3,
          })
        } else {
          flags.push({
            key: 'WITH_WAREHOUSE',
            label: `${f.ifNumber} with warehouse (scanned out ${daysOut}d ago)`,
            severity: 0,
          })
        }
      } else if (inn) {
        // Back from the warehouse but the order still reads PICKED — our side
        // of the work (mark packed in NetSuite) is the outstanding task.
        flags.push({
          key: 'BACK_NOT_PACKED',
          label: `${f.ifNumber} returned from warehouse — mark it packed`,
          severity: 2,
        })
      } else if (f.ifDate && daysBetween(f.ifDate, today) >= 1) {
        // IF exists but was never scanned out — either the handoff never
        // happened, or it happened unscanned. Print the label and scan it.
        flags.push({
          key: 'NEEDS_HANDOFF_SCAN',
          label: `${f.ifNumber} has no handoff scan — print label & scan OUT`,
          severity: 1,
        })
      }
    }
  }

  // Picked, not yet packed: the warehouse has the paper. Past ~3 days with no
  // movement, the paper may be lost or forgotten — flag it before STALE (14d)
  // would otherwise catch it much later. Suppressed once custody scans exist
  // for this order — the scan-derived flags above tell the precise story.
  if (!hasCustodyScans && o.stage === STAGE.PICKED && o.daysPending != null && o.daysPending >= 3) {
    flags.push({
      key: 'PICK_STALLED',
      label: `Picked ${o.daysPending}d ago, not packed — confirm warehouse has it`,
      severity: 2,
    })
  }

  // Partially fulfilled: one batch already shipped/invoiced, but open units
  // remain that need a SECOND fulfillment or a disposition (ship the rest, or
  // close). Without this, the shipped invoice pushes the order to Approved and
  // it looks done — the open units would silently fall through the cracks.
  // This is the multi-document case we handle by flagging for manual review
  // rather than engineering full multi-IF tracking (see the project decision).
  if (/partially fulfilled/i.test(o.soStatus || '')) {
    const remaining = o.qtyOrdered != null ? o.qtyOrdered - (o.qtyFulfilled ?? 0) : null
    flags.push({
      key: 'PARTIAL',
      label:
        remaining != null && remaining > 0
          ? `Partially fulfilled — ${remaining} units still open, needs 2nd fulfillment or disposition`
          : 'Partially fulfilled — open units need disposition',
      severity: 2,
    })
  }

  // Shortage, read through ATS (see the warehouse-order-lifecycle notes):
  //  - ATS order short      → real STOCK exception; ATS is supposed to ship from
  //                           on-hand stock, so a shortfall means inquire now.
  //  - Non-ATS order short  → NORMAL. Non-ATS is presold against a PO, so it's
  //                           just waiting on its inbound container. Not an alert.
  //
  // TODO (needs a PO-receiving CSV): upgrade a Non-ATS shortage whose PO has
  // already been RECEIVED to a real stall (severity 3) — that's the
  // lost-visibility case (container is in, order still isn't fulfilled).
  //
  // Shortage is only an actionable question while the order is still OPEN —
  // i.e. "do we have stock to fulfill this?". Once an Item Fulfillment exists
  // (Picked and beyond), the fulfillment decision has already been made
  // (e.g. ship the 3 units on hand of a 5-unit order), so a leftover shortfall
  // isn't an alert — it's a settled choice. This also naturally excludes On
  // Hold orders (which sit below OPEN and can't be acted on yet).
  if (o.stage === STAGE.OPEN && o.qtyOrdered != null) {
    const shortBy = o.qtyOrdered - (o.qtyAllocated ?? 0) - (o.qtyFulfilled ?? 0)
    if (shortBy > 0) {
      if (o.isAts) {
        flags.push({ key: 'STOCK_SHORT', label: `ATS stock short ${shortBy} — inquire`, severity: 3 })
      } else {
        flags.push({ key: 'AWAITING_PO', label: `Non-ATS short ${shortBy} — awaiting PO (normal)`, severity: 0 })
      }
    }
  }

  return flags
}

// whole days from `from` to `to` (negative = `to` is in the past)
function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY)
}
function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}
