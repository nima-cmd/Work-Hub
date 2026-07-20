// src/model/ediWork.js — the work layer on top of computeEdiPipeline (Nima,
// 2026-07-18: "EDI is too basic to function as is"). For every EDI PO it
// answers the two questions that matter:
//   1. Is this OPEN (work left to do) or CLOSED (done)?
//   2. If open — what exactly is needed next?
// Plus the two failure modes that hurt:
//   • MISSED 850 — a PO arrived, days passed, and there's still no matching
//     NetSuite order and no manual resolution: nobody ever entered it.
//   • CANCEL DANGER — the 850's cancel-after date is passing/passed while the
//     order still isn't shipped: ship it or lose it (chargeback bait).
//
// `resolutions` is the manual override table (edi_po_resolutions): a human
// connecting a PO to NetSuite reality the saved searches can't see — a
// NetSuite ref while it stays open, or closing it out entirely (with a note).
// A resolution always wins over inference, and is always visibly flagged.

const DAY = 86400000

export const MISSED_AFTER_DAYS = 7 // 850 with no NetSuite order after this = presumed missed
export const CANCEL_SOON_DAYS = 7

function daysSince(dateish, today) {
  if (!dateish) return null
  return Math.floor((today - new Date(dateish).getTime()) / DAY)
}

// One order from computeEdiPipeline + its resolution → work status.
export function deriveWork(order, resolution = null, today = Date.now()) {
  const r = resolution || null
  const age850 = daysSince(
    order.transactions?.find((t) => t.type === '850_PURCHASE_ORDER')?.createdAt, today,
  )

  // ── closed? ────────────────────────────────────────────────────────────────
  // Manual close always wins. Otherwise docs-complete (810 sent) with nothing
  // broken counts as closed automatically.
  const manuallyCancelled = r?.cancelled === true
  const manuallyClosed = !manuallyCancelled && r?.closed === true
  const autoClosed = order.stageRank >= 4 && !order.hasIssue && !(order.linkGaps?.length)
  const closed = manuallyCancelled || manuallyClosed || autoClosed

  // ── missed-850 detection ───────────────────────────────────────────────────
  // A PO that landed, has no NetSuite order, no resolution, and hasn't shipped:
  // after MISSED_AFTER_DAYS that's "nobody entered this" — the failure Nima
  // found from a month back.
  const missed850 =
    !closed && !r &&
    order.bucket !== 'NO_850_FOUND' &&
    order.stageRank <= 2 &&
    !order.netsuiteOrder &&
    age850 != null && age850 >= MISSED_AFTER_DAYS

  // ── cancel-date danger ─────────────────────────────────────────────────────
  let cancelState = null // 'passed' | 'soon' | null
  let cancelDays = null
  if (!closed && order.cancelAfter && order.stageRank < 3) {
    const d = daysSince(order.cancelAfter, today)
    if (d != null && d >= 0) { cancelState = 'passed'; cancelDays = d }
    else if (d != null && -d <= CANCEL_SOON_DAYS) { cancelState = 'soon'; cancelDays = -d }
  }

  // ── what's needed next (first thing that blocks progress) ─────────────────
  let needed = null
  if (closed) {
    needed = null
  } else if (order.bucket === 'NO_850_FOUND') {
    needed = 'Orphan document — find and link its 850 (no PO on file)'
  } else if (order.hasIssue) {
    const bad = order.transactions.find(
      (t) => t.validationStatus === 'INVALID' || t.deliveryStatus === 'FAILED' ||
             t.acknowledgmentStatus === 'REJECTED' || t.acknowledgmentStatus === 'OVERDUE',
    )
    const what = bad
      ? `${bad.type.split('_')[0]} ${bad.validationStatus === 'INVALID' ? 'invalid' : bad.deliveryStatus === 'FAILED' ? 'failed to deliver' : 'acknowledgment ' + String(bad.acknowledgmentStatus).toLowerCase()}`
      : 'a document has an EDI error'
    needed = `Fix EDI: ${what}`
  } else if (missed850) {
    needed = `Enter in NetSuite — 850 arrived ${age850}d ago, no order found`
  } else if (order.stageRank <= 2 && !order.netsuiteOrder && r?.netsuiteRef) {
    needed = `Progress ${r.netsuiteRef} — linked manually, not shipped yet`
  } else if (order.stageRank <= 2 && !order.netsuiteOrder) {
    needed = 'Enter in NetSuite (no matching order yet)'
  } else if (order.stageRank <= 2 && order.netsuiteOrder && order.netsuiteOrder.stage !== 'SHIPPED') {
    needed = `Fulfill & ship — ${order.netsuiteOrder.soNumber} ${order.netsuiteOrder.nextAction ? '· ' + order.netsuiteOrder.nextAction : ''}`.trim()
  } else if (order.netsuiteOrder?.stage === 'SHIPPED' && order.stageRank < 3) {
    needed = 'Send the 856 ASN — NetSuite shows it shipped'
  } else if (order.stageRank === 3) {
    needed = 'Send the 810 invoice'
  } else if (order.linkGaps?.length) {
    needed = order.linkGaps[0]
  } else {
    needed = 'Review — state unclear'
  }
  if (cancelState === 'passed') needed = `⚠ Cancel date passed ${cancelDays}d ago — ${needed || 'review'}`

  return {
    closed,
    closedBy: manuallyCancelled ? 'cancelled' : manuallyClosed ? 'manual' : autoClosed ? 'docs' : null,
    resolution: r,
    needed,
    missed850,
    age850,
    cancelState,
    cancelDays,
  }
}

// Whole-board derivation: work per order + per-partner open/closed rollups and
// the open:closed ratio Nima wants to track (task-generator fuel later).
export function computeEdiWork(orders = [], resolutions = [], today = Date.now()) {
  const resByBn = new Map(resolutions.map((r) => [r.businessNumber, r]))
  const withWork = orders.map((o) => ({ ...o, work: deriveWork(o, resByBn.get(o.businessNumber) || null, today) }))

  const partners = new Map()
  for (const o of withWork) {
    const key = o.tradingPartner || '(unknown partner)'
    if (!partners.has(key)) {
      partners.set(key, { tradingPartner: key, open: 0, closed: 0, missed: 0, cancelDanger: 0, issues: 0 })
    }
    const p = partners.get(key)
    if (o.work.closed) p.closed++
    else p.open++
    if (o.work.missed850) p.missed++
    if (o.work.cancelState) p.cancelDanger++
    if (o.hasIssue && !o.work.closed) p.issues++
  }
  const partnerList = [...partners.values()]
    .map((p) => ({ ...p, total: p.open + p.closed, closedRatio: p.open + p.closed ? p.closed / (p.open + p.closed) : 0 }))
    .sort((a, b) => b.open - a.open || b.total - a.total)

  const totals = partnerList.reduce(
    (t, p) => ({ open: t.open + p.open, closed: t.closed + p.closed, missed: t.missed + p.missed, cancelDanger: t.cancelDanger + p.cancelDanger }),
    { open: 0, closed: 0, missed: 0, cancelDanger: 0 },
  )

  return { orders: withWork, partners: partnerList, totals }
}
