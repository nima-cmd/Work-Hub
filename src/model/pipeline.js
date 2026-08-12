// src/model/pipeline.js
// Merges partial records from every source into ONE order per SO number,
// derives the current stage, and applies your warehouse color/priority rules
// (the legend on the "Packed, Not Yet Shipped" portlet) as machine-readable
// flags.

import { STAGE, STAGE_RANK, furthestStage } from './stages.js'
import { needsPackNudge, preppedLabel } from './prepped.js'
import { shipWindowFlags, shipWindow, isoDay, PACK_LEAD_DAYS } from './shipWindow.js'
import { paymentBlocked } from './paymentGate.js'

const DAY = 86_400_000

// ── WHERE AN INVOICED ORDER SITS ─────────────────────────────────────────────
//
// ⚠️ THIS WAS DEAD ON THE LIVE PATH FOR THE WHOLE LIVE-INGEST ERA (found
// 2026-08-04). The old version keyed off `rec.stage === STAGE.INVOICED`, which
// only the retired CSV mappers ever emit (savedSearches.js). `mapInvoiceRow`
// emits no stage at all, so on the live sync NO order could ever leave PACKED:
// measured live, 0 of 238 orders sat at INVOICED or APPROVED, and both stages —
// with their labels and next-actions — were unreachable.
//
// Three surfaces were lying as a direct result:
//   · the court strip's "need an invoice" chip (`stage === PACKED`) read 4 while
//     all 4 of those orders had an invoice — and the SAME four also read
//     "held for payment", so the strip gave opposite advice about one set of
//     shipments;
//   · routeItems' day plan queued an "Invoice <customer>" task for them;
//   · routeItems' "Ship it out" leg (gated on STAGE.APPROVED) could never fire.
//
// So the promotion is now derived from the ORDER — an invoice number from any
// source — rather than from one mapper remembering to set a stage.
function isInvoiced(o) {
  return !!o.invoice || STAGE_RANK[o.stage] >= STAGE_RANK[STAGE.INVOICED]
}

// Which of the two invoiced stages. Prefers objective evidence over the
// hand-maintained field, the rule PR #47 established for the ship gate: terms +
// what is still owed decide, so a stale `shippingStatus` can neither hold an
// order back nor push it forward (src/model/paymentGate.js).
//
// The ONE exception is the NY waiver — an explicit `Approved For Shipping` on a
// due-on-receipt invoice, which is another office instructing us to ship despite
// the balance (Nima, 2026-08-04). It rides inside `paymentBlocked`, so it reaches
// APPROVED here for free, which is what makes routeItems' "Ship it out" leg fire
// for a waived order. Stale-safe by construction: it only ever unblocks.
function invoicedStage(o) {
  const payments = o.invoicePayments || []
  if (payments.length) {
    // ANY invoice still owing holds the order. Not first-wins: an SO can carry
    // several invoices (the MULTI_DOC case we flag rather than model), and
    // "one of them is paid" is not "clear to ship".
    if (payments.some(paymentBlocked)) return STAGE.INVOICED
    // Nothing is blocking payment — but "Ship it out" is only honest once the
    // goods are actually packed. An invoice can precede its fulfilment, and
    // without this guard such an order would jump straight to APPROVED and read
    // as ready to leave while it is still being picked.
    return hasPackedFulfillment(o) ? STAGE.APPROVED : STAGE.INVOICED
  }
  // No terms or balance on any record — the CSV path, where the hand-maintained
  // "Shipping Status" is the only signal there is. Unchanged behavior.
  const s = (o.shippingStatus || '').toLowerCase()
  if (s.includes('approved for shipping') || s.includes('shipped')) return STAGE.APPROVED
  return STAGE.INVOICED // "Pending Payment", "FOB Pending Approval", etc.
}

function hasPackedFulfillment(o) {
  return o.fulfillments.some((f) => /packed|shipped/i.test(f.status || f.packedStatus || ''))
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
        // A temp order holding stock until the real one arrives. Excluded from
        // getOrders, so it never surfaces as work — see db/schema.sql.
        isPlaceholder: false,
        // Which DC this store consolidates through, and its store number. An
        // EDI PO is one sales order per store, and the DC is what groups them
        // into one cargo tag per PO-DC (Nima, 2026-08-02).
        dc: null,
        storeNumber: null,
        // The ORDER's payment terms — kept under its own name so an invoice
        // record's `terms` can never win the merge (see mapOrderRow).
        orderTerms: null,
        // Payment evidence, one entry per invoice record seen for this SO. Kept
        // as a list rather than folded onto the order because the gate must
        // consider EVERY invoice (see invoicedStage) — a single first-wins
        // `amountRemaining` would let a paid invoice speak for an unpaid one.
        invoicePayments: [],
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
    'billingStatus', 'isPlaceholder', 'dc', 'storeNumber', 'orderTerms',
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

    // advance the order's stage to the furthest point any source reports. Which
    // of the two INVOICED stages an invoice implies is decided after the loop,
    // once every invoice and fulfilment for this SO has been seen — see
    // invoicedStage.
    o.stage = furthestStage(o.stage, rec.stage)

    // The objective half of the ship gate, straight off the invoice record.
    if (rec.terms != null || rec.amountRemaining != null) {
      // `shipGate` rides along per-invoice rather than being read off the folded
      // `o.shippingStatus`: the NY waiver applies to the invoice a person actually
      // approved, and on a multi-invoice SO a first-non-empty fold would let one
      // invoice's approval speak for another's hold.
      o.invoicePayments.push({
        terms: rec.terms ?? null,
        amountRemaining: rec.amountRemaining ?? null,
        shipGate: rec.shippingStatus ?? null,
      })
    }

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
    // An invoice exists, so this order is past "packed — watching for invoice".
    // furthestStage keeps SHIPPED where it is; nothing here can move an order
    // backwards.
    if (isInvoiced(o)) o.stage = furthestStage(o.stage, invoicedStage(o))
    o.flags = computeFlags(o, today)
    o.sources = [...o.sources]
  }
  return [...orders.values()]
}

// ── THE AGE CLOCK ────────────────────────────────────────────────────────────
//
// Days-pending is not urgency on its own. It only means something while the
// order is still racing a date it has not met — and this file was reading it
// unconditionally, which put a red `Nd pending — chase it` chip on states the
// business runs deliberately.
//
// The contradiction Nima saw on screen (2026-08-07): SO12344's card read "Not
// due to ship until Aug 18" (postCustody.js, correct) directly beside a red
// "16d pending — chase it" (here). *"A red chip beats a calm sentence every time
// I look at the board."*
//
// Measured live 2026-08-10 — 153 of 250 orders carried an age flag and exactly
// ONE was genuinely out of runway:
//   · 119 were SHIPPED, some 20–60 days ago, still reading STALE at severity 3.
//     shipWindowFlags has always refused to fire on a shipped order ("a window
//     that has been met is not a window missed"); the age clock never got the
//     same guard.
//   ·  33 had runway left, including SO12344 and the 20 Nordstrom cards routed
//     and tendered for pickup that same morning.
//   ·   1 was real (SO12267, invoiced, ship date 5 days past).
//
// This is the same shape as the four false-positive rounds recorded in
// postCustody.js — a correct holding state read as neglect — one layer down, in
// the severity machinery every other surface sorts and counts on.
//
// Returns:
//   'gone'    — it shipped. The clock stops; nothing to chase.
//   'slack'   — a date exists and there is still runway past the pack lead.
//   'racing'  — inside the pack lead, past due, or no honest date at all
//               (a missing window must not buy silence — it buys the old
//               behaviour, which is the only conservative direction here).
export function ageClock(o, w) {
  if (o?.stage === STAGE.SHIPPED) return 'gone'
  if (w?.shipped) return 'gone'
  if (typeof w?.daysToShip === 'number' && w.daysToShip > PACK_LEAD_DAYS) return 'slack'
  return 'racing'
}

// What the age is worth saying, given the clock.
//
// ⚠️ On 'slack' the flag is kept at severity 0 rather than dropped: "nothing sits
// ignored" outranks "nothing nags me" (the same call prepped.js made for
// PREPPED_HELD). It states the runway instead of demanding a chase, so the chip
// and postCustody's sentence now agree. On 'gone' there is genuinely nothing to
// keep — the order left, and the DEPARTED column already says so.
export function ageFlags(o, clock, w = null) {
  const dp = o?.daysPending
  if (dp == null || clock === 'gone') return []
  if (clock === 'slack') {
    if (dp < 7) return []
    return [{
      key: 'AGING_WITH_RUNWAY',
      label: `Open ${dp}d — not late${runwayPhrase(w)}`,
      severity: 0,
    }]
  }
  if (dp >= 14) return [{ key: 'STALE', label: `${dp}d pending — chase it`, severity: 3 }]
  if (dp >= 7) return [{ key: 'AGING', label: `${dp}d pending`, severity: 1 }]
  return []
}

// The date a runway is measured against, and WHOSE date it is: for an EDI order
// that is the partner's cancel-after, never the sales order's own date (they
// disagree on 12 of 12 open POs — shipWindow.js). One helper so the age chip and
// the pack chip can't word the same fact two ways.
export function runwayPhrase(w) {
  const by = isoDay(w?.mustShipBy)
  if (!by) return ''
  return `, ${w?.source === 'edi' ? 'cancels' : 'ships'} ${by}`
}

// Your warehouse legend, as code. severity: 3 = act now, 2 = caution, 1 = watch.
// Exported so the API/UI compute the exact same flags as the CLI analyzer.
export function computeFlags(o, today) {
  const flags = []
  const ss = (o.shippingStatus || '').toLowerCase()

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

  // The ship window (src/model/shipWindow.js). For a boutique order this is the
  // sales order's own ship date, as before. For an EDI order the binding date is
  // the partner's 850 cancel-after instead — the SO date disagreed with it on
  // 12 of 12 open EDI POs, usually by promising a date the partner had already
  // cancelled on, which produced no flag at all.
  flags.push(...shipWindowFlags(o, today))

  // The age clock, read against the runway it is actually racing.
  const w = shipWindow(o, today)
  const clock = ageClock(o, w)
  flags.push(...ageFlags(o, clock, w))

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
        //
        // ...UNLESS we have recorded that our part is already done. `Packed` in
        // NetSuite tells accounting to invoice, so an order we must not invoice yet
        // cannot use it, and Nima asked for an alternative marker (2026-08-05). A
        // PREPPED fulfilment is held back deliberately, so it stops nagging — but it
        // keeps a flag at severity 0 rather than vanishing, because "nothing sits
        // ignored" outranks "nothing nags me". See src/model/prepped.js.
        if (!needsPackNudge({ backInPossession: true, packedInNetsuite: false, preppedAt: f.preppedAt, prepClearedAt: f.prepClearedAt })) {
          flags.push({
            key: 'PREPPED_HELD',
            label: preppedLabel({ ifNumber: f.ifNumber, note: f.prepNote, preppedAt: f.preppedAt }),
            severity: 0,
          })
        } else if (clock === 'slack') {
          // ⚠️ THE SHARPEST CASE OF THE CONTRADICTION, because obeying this chip
          // does real damage rather than just wasting a minute: MARKING PACKED IS
          // THE INVOICE TRIGGER (Nima, 2026-08-07 — "we mark as packed on the day
          // of the route so it invoiced that day not before"). So on a card with
          // runway left, "mark it packed" at severity 2 is not merely early
          // advice, it is advice to invoice the customer early.
          //
          // Measured 2026-08-10: 13 of 13 live BACK_NOT_PACKED rows had runway
          // (4 to 23 days), each also queueing a `Mark packed` leg on the day
          // plan with a NOON deadline. 100% of one lane is a lane bug — the fifth
          // time in this repo (see postCustody.js).
          //
          // Its own key, not a demoted severity: routeItems' PICKED_LEGS keys the
          // NOON deadline on the leg KIND, so a severity-0 BACK_NOT_PACKED would
          // still have queued "do this by noon" for an order shipping in 23 days.
          // The keystroke re-appears as BACK_NOT_PACKED, leg and all, once the
          // clock stops being 'slack' — i.e. inside the pack lead, which is the
          // route day.
          flags.push({
            key: 'PACK_ON_ROUTE_DAY',
            label: `${f.ifNumber} back from the warehouse — mark it packed on the route day${runwayPhrase(w)}`,
            severity: 0,
          })
        } else {
          flags.push({
            key: 'BACK_NOT_PACKED',
            label: `${f.ifNumber} returned from warehouse — mark it packed`,
            severity: 2,
          })
        }
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
  // Same gate as the age clock above: with runway left, a picked-not-packed
  // order is the boutique holding state Nima designed on purpose, and for EDI it
  // is the pack lag that rides along as a note on a routed shipment. Measured
  // 2026-08-10: 28 of 29 live PICK_STALLED rows had runway (20 of them Nordstrom
  // cards already routed AND tendered for pickup that morning), each also
  // minting a "Chase the warehouse" leg on the day plan (routeItems.js).
  if (clock === 'racing' && !hasCustodyScans && o.stage === STAGE.PICKED && o.daysPending != null && o.daysPending >= 3) {
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
  //  - Non-ATS order short  → NOT REPORTED HERE AT ALL. The sales order is the
  //    wrong object to ask (Nima, 2026-08-02): non-ATS demand originates on an
  //    Order Confirmation and is funded by an incoming PO, one PO typically
  //    covering several OCs. That question is answered against item + destination
  //    in src/model/ocPoMatch.js, where both sides are visible; and once the PO
  //    is received the units are simply stock, so there is nothing left to track
  //    at PO level. The old `AWAITING_PO` flag asserted "awaiting PO (normal)"
  //    without ever checking that a PO existed — a promise this object can't keep.
  //
  // Shortage is only an actionable question while the order is still OPEN —
  // i.e. "do we have stock to fulfill this?". Once an Item Fulfillment exists
  // (Picked and beyond), the fulfillment decision has already been made
  // (e.g. ship the 3 units on hand of a 5-unit order), so a leftover shortfall
  // isn't an alert — it's a settled choice. This also naturally excludes On
  // Hold orders (which sit below OPEN and can't be acted on yet).
  if (o.stage === STAGE.OPEN && o.qtyOrdered != null) {
    const shortBy = o.qtyOrdered - (o.qtyAllocated ?? 0) - (o.qtyFulfilled ?? 0)
    if (shortBy > 0 && o.isAts) {
      flags.push({ key: 'STOCK_SHORT', label: `ATS stock short ${shortBy} — inquire`, severity: 3 })
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
