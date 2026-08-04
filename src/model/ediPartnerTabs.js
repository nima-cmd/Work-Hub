// src/model/ediPartnerTabs.js — the four per-trading-partner questions Nima
// asked for (2026-08-02), each one a list of the things that need doing:
//
//   1. noSalesOrder  — an 850 landed and NO sales order exists. Something went
//                      wrong: nobody entered it.
//   2. noFulfillment — a sales order exists with no item fulfilment at all.
//                      Something needs doing: pick and pack it.
//   3. notShipped    — an item fulfilment that isn't marked shipped. This is
//                      what's physically in flow right now.
//   4. noAsn         — a PO whose fulfilment has shipped but whose 856 either
//                      was never sent or never reached the partner.
//
// Pure: takes the orders `computeEdiWork` already produced (pipeline + work)
// and reshapes them. Nothing here queries or writes.
//
// ⚠️ THE UNIT CHANGES PER TAB, ON PURPOSE. Tabs 1 and 4 are per PURCHASE ORDER
// (an 850 is a PO; an ASN answers a PO). Tabs 2 and 3 are per SALES ORDER and
// per FULFILMENT, because an EDI PO fans out to one sales order per store —
// PO 50073677 is 25 of them. Rolling 2 and 3 up to the PO would report "1 thing
// to do" for 25 stores' worth of picking. See ediPipeline's `netsuiteOrders`.

const DAY = 86400000

const daysSince = (d, today) => (d ? Math.floor((today - new Date(d).getTime()) / DAY) : null)

// A PO is only genuinely announced when an 856 actually reached the partner.
// Three distinct states, never merged (same rule as [[work-hub-court-strip]]):
//   'none'        — no 856 exists at all → send one
//   'undelivered' — an 856 exists but Orderful never pushed it → go push it
//                   (Orderful auto-send is OFF; the final transmit is manual)
//   'refused'     — delivered, then rejected/overdue → needs READING, not a re-send
const POSITIVE_ACK = new Set(['ACCEPTED', 'ACCEPTED_WITH_ERRORS'])

export function asnState(order) {
  const asns = (order.transactions || []).filter(
    (t) => t.type === '856_SHIP_NOTICE_MANIFEST' && t.direction !== 'IN',
  )
  if (!asns.length) return { state: 'none', txn: null, detail: 'no 856 sent' }
  const good = asns.find((t) => t.deliveryStatus === 'DELIVERED' && POSITIVE_ACK.has(t.acknowledgmentStatus))
  if (good) return { state: 'ok', txn: good, detail: 'delivered & accepted' }

  const delivered = asns.find((t) => t.deliveryStatus === 'DELIVERED')
  if (delivered) {
    const ack = String(delivered.acknowledgmentStatus || 'pending').toLowerCase().replace(/_/g, ' ')
    // Delivered but rejected/overdue is a different job from a re-send — the
    // partner replied and the reply has to be read.
    const refused = ['REJECTED', 'OVERDUE'].includes(delivered.acknowledgmentStatus)
    return { state: refused ? 'refused' : 'undelivered', txn: delivered, detail: `delivered · ack ${ack}` }
  }
  const newest = asns.reduce((a, b) => (new Date(b.createdAt || 0) >= new Date(a.createdAt || 0) ? b : a))
  return {
    state: 'undelivered',
    txn: newest,
    detail: `delivery ${String(newest.deliveryStatus || 'pending').toLowerCase()} — never reached the partner`,
  }
}

// Every sales order attached to a PO. Mirrors ediWork's fallback so an order
// built from an older pipeline shape still reads correctly.
function salesOrdersOf(order) {
  if (order.netsuiteOrders?.length) return order.netsuiteOrders
  return order.netsuiteOrder ? [order.netsuiteOrder] : []
}

// A fulfilment counts as shipped when it carries a real ship date. Status text
// alone is not enough — `actual_ship_date` is the honest evidence the rest of
// the app already ranks on (see [[ship-gate-and-ship-date]]).
const isShipped = (f) => !!f.actualShipDate

export function computeEdiPartnerTabs(orders = [], { today = Date.now(), missedAfterDays = 7 } = {}) {
  // Closed and parked POs are deliberately out of scope: a parked PO has been
  // looked at and set aside on purpose, and chasing it is exactly what the
  // review gate exists to stop.
  const live = orders.filter((o) => !o.work?.closed && !o.work?.parked)

  const noSalesOrder = []
  const noFulfillment = []
  const notShipped = []
  const noAsn = []

  for (const o of live) {
    const partner = o.tradingPartner || '(unknown partner)'
    const sos = salesOrdersOf(o)
    const age = o.work?.age850 ?? null

    // ── 1. an 850 with no sales order ────────────────────────────────────────
    // Gated on stageRank <= 2 — i.e. no 856 and no 810 was ever sent on this PO.
    // Without that gate this list fills with POs that WERE entered, shipped and
    // closed months ago and have simply aged out of the open-order sync window
    // (the sync keeps open orders + anything modified recently). If we announced
    // or invoiced it, a sales order plainly existed.
    // A partner-cancelled PO (current 850 zeroed — ediWork's partnerCancelled)
    // is excluded: "import it" is exactly the wrong instruction for a PO the
    // partner killed. Its card still shows "Cancelled by partner — confirm &
    // close" on the main board.
    if (o.bucket !== 'NO_850_FOUND' && !sos.length && o.stageRank <= 2 && !o.work?.partnerCancelled) {
      noSalesOrder.push({
        businessNumber: o.businessNumber,
        partner,
        age850: age,
        // The claim gets stronger with age; under a week it may just be new.
        missed: age != null && age >= missedAfterDays,
        cancelAfter: o.cancelAfter || null,
        shipNotBefore: o.shipNotBefore || null,
        manuallyLinked: !!o.work?.resolution?.netsuiteRef,
        order: o,
      })
    }

    // ── 2. a sales order with no item fulfilment ─────────────────────────────
    for (const so of sos) {
      if ((so.itemFulfillments || []).length) continue
      noFulfillment.push({
        businessNumber: o.businessNumber,
        partner,
        soNumber: so.soNumber,
        stage: so.stage,
        stageLabel: so.stageLabel || so.stage,
        nextAction: so.nextAction || null,
        cancelAfter: o.cancelAfter || null,
        age850: age,
        order: o,
      })
    }

    // ── 3. an item fulfilment not marked shipped — what's in flow now ────────
    for (const so of sos) {
      for (const f of so.itemFulfillments || []) {
        if (isShipped(f)) continue
        notShipped.push({
          businessNumber: o.businessNumber,
          partner,
          soNumber: so.soNumber,
          ifNumber: f.ifNumber,
          status: f.status || null,
          invoiceNumber: f.invoiceNumber || null,
          cancelAfter: o.cancelAfter || null,
          order: o,
        })
      }
    }

    // ── 4. shipped, but the 856 never landed ─────────────────────────────────
    // "Shipped" here means a fulfilment on THIS PO has a real ship date, not
    // that the whole PO is done — one shipped DC out of 25 is still an
    // unannounced shipment.
    const shippedFs = sos.flatMap((so) =>
      (so.itemFulfillments || []).filter(isShipped).map((f) => ({ ...f, soNumber: so.soNumber })),
    )
    const asn = asnState(o)
    // ⚠️ AN 856 IS ITSELF PROOF WE SHIPPED. Gating this tab purely on "a shipped
    // fulfilment is visible" would have reported **0** while 14 POs had an ASN
    // sitting undelivered in Orderful (measured 2026-08-02) — their sales orders
    // had simply aged out of the open-order sync window, so the shipment was
    // real and the evidence of it wasn't. Either witness qualifies.
    const shippedByAsn = asn.state !== 'none' && asn.state !== 'ok'
    if (asn.state !== 'ok' && (shippedFs.length || shippedByAsn)) {
      const lastShip = shippedFs
        .map((f) => f.actualShipDate)
        .filter(Boolean)
        .sort()
        .pop() || null
      noAsn.push({
        businessNumber: o.businessNumber,
        partner,
        state: asn.state, // 'none' | 'undelivered' | 'refused'
        detail: asn.detail,
        transactionId: asn.txn?.id || null,
        shippedCount: shippedFs.length,
        fulfillments: shippedFs,
        // What tells us this shipped: a fulfilment we can still see, or only
        // the ASN itself. Worth showing — the second kind can't be clicked
        // through to an IF.
        evidence: shippedFs.length ? 'fulfillment' : 'asn',
        lastShipDate: lastShip,
        daysSinceShip: daysSince(lastShip ?? asn.txn?.createdAt, today),
        order: o,
      })
    }
  }

  // Oldest-first inside each list: the thing that has been wrong longest is the
  // thing to do first.
  noSalesOrder.sort((a, b) => (b.age850 || 0) - (a.age850 || 0))
  noFulfillment.sort((a, b) => (b.age850 || 0) - (a.age850 || 0))
  notShipped.sort((a, b) => String(a.ifNumber || '').localeCompare(String(b.ifNumber || '')))
  // A never-sent ASN outranks one that's merely stuck in Orderful, then by age.
  const asnRank = { none: 0, undelivered: 1, refused: 2 }
  noAsn.sort((a, b) => asnRank[a.state] - asnRank[b.state] || (b.daysSinceShip || 0) - (a.daysSinceShip || 0))

  return { noSalesOrder, noFulfillment, notShipped, noAsn }
}

// Per-partner counts for the rail, from the same four lists so a tab and its
// badge can never disagree.
export function ediTabCountsByPartner(tabs) {
  const byPartner = new Map()
  const bump = (partner, key) => {
    if (!byPartner.has(partner)) {
      byPartner.set(partner, { tradingPartner: partner, noSalesOrder: 0, noFulfillment: 0, notShipped: 0, noAsn: 0 })
    }
    byPartner.get(partner)[key]++
  }
  for (const key of ['noSalesOrder', 'noFulfillment', 'notShipped', 'noAsn']) {
    for (const row of tabs[key] || []) bump(row.partner, key)
  }
  return [...byPartner.values()].sort(
    (a, b) => (b.noSalesOrder + b.noAsn) - (a.noSalesOrder + a.noAsn) || b.notShipped - a.notShipped,
  )
}
