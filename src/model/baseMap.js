// src/model/baseMap.js — THE BASE, as data.
//
// Nima, 2026-08-20/21: the home view becomes a command base seen from directly above,
// its buildings drawn from the real `bay.glb` sprites, people moving between them on
// roads — and, crucially, "we would like to be able to use this view to work from".
//
// So this file owns three things, and none of them are pixels:
//
//   1. WHICH BUILDING IS WHICH LANE, and where it sits on the map.
//   2. THE ROAD NETWORK — which buildings are actually connected, because a mover may
//      only travel a road that exists.
//   3. WHAT EACH BUILDING COUNTS, derived from the data the app already loads.
//
// ⚠️ NO NEW ENDPOINT. Every number below comes from what App.jsx already hands every
// view (orders, tasks, emails, events) — so the Base view adds no query load to a
// one-vCPU deploy for the privilege of being the screen that is always open.
//
// ⚠️ POSITIONS ARE PERCENTAGES, not pixels, and they live here rather than in the CSS
// because the LAYOUT IS THE TOPOLOGY: a mover's road is only meaningful if the two
// buildings it runs between are really adjacent on screen. Splitting "where things are"
// from "what connects to what" is how a dot ends up crossing a building.

import { laneFor } from './orderLane.js'
import { paymentBlocked } from './paymentGate.js'
import { SPINE_LABEL } from './orderEvents.js'

// ── The buildings ───────────────────────────────────────────────────────────
//
// `sprite` names a real render from client/public/base — see the README there for
// what each structure actually is and why it carries this lane. Swapping two is a
// one-line change here and nowhere else.
export const BUILDINGS = [
  // ── North row: the desk and the wires ──────────────────────────────────
  {
    key: 'comms', label: 'Comms tower', sprite: 'bldg-06', tone: 'edi',
    x: 10, y: 3, w: 9, h: 13,
    of: 'transmissions to answer', view: 'transmissions',
  },
  {
    key: 'ops', label: 'Ops centre', sprite: 'bldg-01', tone: 'go',
    // The stepped terrace block, tallest on the sheet. The desk.
    x: 32, y: 2, w: 11, h: 15,
    // ⚠️ THIS SAID "open on the day plan" AND COUNTED SOMETHING ELSE (fixed 2026-08-28).
    // It counts open quest_tasks. Measured the day it was found: 15 open tasks against
    // a day plan holding 23 items — 9 EDI routings, 8 ships, 5 email replies and 1
    // invoice, NONE of them tasks. Two different piles, one label.
    //
    // The number is not wrong, the sentence was: open tasks are real and worth counting.
    // ⚠️ It is relabelled rather than recomputed ON PURPOSE — buildRouteItems needs
    // `ediWork` and `labelGaps`, which this view is not given, so counting "the day
    // plan" here would silently undercount it. Trading a wrong label for a wrong number
    // is not a fix. If the day-plan figure is the one wanted, those inputs have to
    // reach the Base first.
    of: 'open tasks', view: 'plan',
  },
  {
    key: 'calendar', label: 'Almanac', sprite: 'bldg-09', tone: 'arrive',
    // A narrow tower — a clock tower, for the view about dates.
    x: 56, y: 3, w: 8, h: 13,
    of: 'ship windows closing or closed', view: 'calendar',
  },
  {
    key: 'datapad', label: 'Archive', sprite: 'bldg-07', tone: 'accent',
    // The data packet surface. ⚠️ NOT COUNTABLE — see `countable` below.
    x: 76, y: 3, w: 10, h: 13,
    of: 'trace anything', view: 'datapad', countable: false,
  },

  // ── Middle row: the flow of goods, west to east ─────────────────────────
  {
    key: 'receiving', label: 'Receiving', sprite: 'bldg-02', tone: 'arrive',
    x: 2, y: 34, w: 13, h: 17,
    of: 'presold, waiting on stock', view: 'allocations',
  },
  {
    key: 'pack', label: 'Pack house', sprite: 'bldg-04', tone: 'hands',
    // Dock doors right around the perimeter.
    x: 30, y: 32, w: 14, h: 19,
    of: 'out on the floor, not back', view: 'kanban',
  },
  {
    key: 'scan', label: 'Scan bay', sprite: 'bldg-04', tone: 'money', flip: true,
    // ⚠️ THE SAME SPRITE AS THE PACK HOUSE, MIRRORED — Nima explicitly allowed
    // duplicating buildings for the new lanes, and a second dock hall beside the
    // first is what a warehouse complex actually looks like. `flip` keeps them
    // visually distinct; the sprite+flip pair is what has to be unique.
    x: 48, y: 33, w: 13, h: 18,
    of: 'scanned back in, needs a label', view: 'scan',
  },
  {
    key: 'launch', label: 'Launch pad', sprite: 'bldg-00', tone: 'holo',
    // The docking ring, twelve bays. East end: where it leaves.
    x: 76, y: 30, w: 17, h: 22,
    of: 'clear for departure', view: 'ship',
  },

  // ── South row: supply and the partners ─────────────────────────────────
  {
    key: 'stock', label: 'Stock depot', sprite: 'bldg-03', tone: 'money',
    // Twin silos beside a long hall — the pool ATS orders pull from.
    x: 10, y: 66, w: 12, h: 16,
    of: 'orders pulling from stock', view: 'table',
  },
  {
    key: 'edi', label: 'EDI relay', sprite: 'bldg-08', tone: 'edi',
    // A long low block: the transmission hall for the partner lane.
    x: 34, y: 67, w: 13, h: 15,
    of: 'partner orders still open', view: 'edi',
  },
  {
    key: 'routing', label: 'Routing yard', sprite: 'bldg-05', tone: 'mid',
    x: 58, y: 67, w: 11, h: 15,
    of: 'freight waiting to be routed', view: 'routing',
  },
  {
    key: 'catalogue', label: 'Catalogue', sprite: 'bldg-03', tone: 'accent', flip: true,
    // ⚠️ THE STOCK DEPOT'S SPRITE, MIRRORED, AND DELIBERATELY SO — the catalogue is the
    // product master for the goods in those silos, so it reads as their twin. The
    // sprite+flip pair is what has to be unique (see the scan bay).
    //
    // Nima, 2026-08-28: the Base is the app and he keeps being pulled out of it; this
    // was the building he named as missing. It is also where the coming UPC label work
    // lands — ⚠️ NOT a new "tools" home, which was my own first instinct and wrong:
    // Catalogue.jsx ALREADY imports the GTIN/UPC master, so UPC labels are the next
    // step in a surface that exists rather than a tool needing somewhere to live.
    x: 74, y: 66, w: 12, h: 16,
    // ⚠️ NOT COUNTABLE, for the Archive's reason. The catalogue's real number is "SKUs
    // not yet uploaded", and that lives behind an import this view is given no feed
    // for. `buildingStates` is built from what App already passes so the always-open
    // screen adds no query load to a one-vCPU deploy — and an INVENTED number sitting
    // among real ones is worse than none at all.
    of: 'UPC and product master', view: 'catalogue', countable: false,
  },
]

export const BUILDING = Object.fromEntries(BUILDINGS.map((b) => [b.key, b]))

/** A building's centre, in the same 0–100 space as its position. Roads run between
 *  centres, so this is the single definition both the map and the movers use. */
export const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

// ── The roads ───────────────────────────────────────────────────────────────
//
// Declared as pairs of buildings, NOT as path strings: the view derives the geometry
// from the two buildings' own positions, so a road cannot drift away from the
// buildings it claims to join when one of them moves.
//
// ⚠️ A leg that is not in this list is not a road, and `roadFor` returns null rather
// than inventing one. That is the whole guarantee — a mover can only ever travel
// between buildings that are genuinely connected.
export const ROADS = [
  // The flow of goods, west to east.
  { key: 'in-stock', from: 'receiving', to: 'stock' },
  { key: 'in-pack', from: 'receiving', to: 'pack' },
  { key: 'stock-pack', from: 'stock', to: 'pack' },
  { key: 'pack-scan', from: 'pack', to: 'scan' },
  { key: 'scan-launch', from: 'scan', to: 'launch' },
  // The partner lane, along the south side.
  { key: 'stock-edi', from: 'stock', to: 'edi' },
  { key: 'pack-edi', from: 'pack', to: 'edi' },
  { key: 'edi-routing', from: 'edi', to: 'routing' },
  { key: 'routing-launch', from: 'routing', to: 'launch' },
  // The catalogue sits at the east end of the supply row, between the partner lane and
  // the door — the two things that ask what a SKU actually is.
  { key: 'routing-catalogue', from: 'routing', to: 'catalogue' },
  { key: 'catalogue-launch', from: 'catalogue', to: 'launch' },
  // The north road: the desk, and the surfaces you read rather than work.
  { key: 'comms-ops', from: 'comms', to: 'ops' },
  { key: 'comms-pack', from: 'comms', to: 'pack' },
  { key: 'ops-calendar', from: 'ops', to: 'calendar' },
  { key: 'ops-scan', from: 'ops', to: 'scan' },
  { key: 'calendar-archive', from: 'calendar', to: 'datapad' },
  { key: 'archive-launch', from: 'datapad', to: 'launch' },
]

/** The road joining two buildings, either way round, or null when none exists. */
export function roadFor(from, to) {
  return ROADS.find(
    (r) => (r.from === from && r.to === to) || (r.from === to && r.to === from),
  ) || null
}

// ── What each building counts ───────────────────────────────────────────────

const ifsOf = (o) => o.fulfillments || []
const shipped = (s) => /shipped/i.test(String(s || ''))

/**
 * One number per building, from the data App already has.
 *
 * Every count below is a COUNT OF THINGS YOU COULD ACT ON, not a total — this view
 * exists to be worked from, and "319 orders" is not work. Where a building's honest
 * number is zero it stays zero; a building is never padded to look busy.
 */
export function buildingStates({ orders = [], tasks = [], emails = [], events = [] } = {}) {
  const lane = (o) => laneFor(o)?.key || null

  // Presold with nothing fulfilled yet — the order side of "waiting on the factory".
  // NOT a container count: containers are inbound stock, and this view gets no
  // container feed, so claiming one here would be a number with no source.
  const waitingOnStock = orders.filter(
    (o) => lane(o) !== 'stock' && lane(o) !== 'edi' && !ifsOf(o).length && !shipped(o.stage),
  )
  const fromStock = orders.filter((o) => lane(o) === 'stock' && !shipped(o.stage))

  // Out of our hands and not back: the custody gap, which is the real question the
  // pack house answers. custodyOut with no custodyIn — observed scans, both of them.
  //
  // ⚠️ AND NOT SHIPPED, which was missing and made this counter 100% WRONG. Measured
  // on live data before shipping: 14 fulfilments had an open custody tag and ALL 14
  // had already shipped — IF7447 scanned out 31 Jul, shipped 5 Aug, tag never closed.
  // Zero were genuinely on the floor. So "out on the floor, not back" was describing
  // departed freight: the counts-something-other-than-its-label shape, and the same
  // never-closed-tag finding as PR #67's DC lane.
  //
  // A finding that is 100% one thing is the tell that the rule is wrong, not the data.
  const openTag = orders.flatMap((o) => ifsOf(o).filter((f) => f.custodyOut && !f.custodyIn))
  const onTheFloor = openTag.filter((f) => !shipped(f.status))
  // The rest are STALE TAGS — paperwork, not goods. Surfaced under their own name
  // rather than folded into a number about the floor. Never lump.
  const staleTags = openTag.filter((f) => shipped(f.status))

  // EDI freight that exists as a fulfilment but has not shipped.
  const toRoute = orders
    .filter((o) => lane(o) === 'edi')
    .flatMap((o) => ifsOf(o).filter((f) => !shipped(f.status)))

  // ── The launch pad: what is CLEAR, and what is GROUNDED and why ──────────
  //
  // Nima, 2026-08-21: "launch bay should show us whats clear for departure i.e need to
  // be marked as shipped and whats grounded categorized by its reason missing invoice
  // missing payment etc."
  //
  // ⚠️ THE REASONS COME FROM paymentGate.js, NOT FROM A FRESH SET OF RULES. That module
  // already holds the policy, including two decisions no new code would have guessed:
  // net terms that have gone PAST DUE do NOT block a shipment (chasing an invoice is
  // not a shipping decision), and the NY office's "Approved For Shipping" is a one-way
  // waiver over an open balance. Re-deriving "missing payment" here would have quietly
  // contradicted the Ship Desk.
  //
  // Order matters: the FIRST thing that grounds it is the reason reported, because a
  // fulfilment with no label AND no invoice is not two problems — the label is the one
  // to act on.
  const groundedReason = (o, f) => {
    if (/fob/i.test(f.packedStatus || '')) return 'FOB — collected in China, we make no label'
    if (!f.labelled) return 'no label yet'
    const inv = (o.invoices || [])[0] || null
    if (!f.invoice && !inv) return 'no invoice yet'
    if (paymentBlocked({ terms: o.terms, amountRemaining: inv?.amountRemaining, shipGate: inv?.shippingStatus })) {
      return 'awaiting payment'
    }
    return null   // nothing grounds it
  }

  const clear = []
  const groundedBy = new Map()
  for (const o of orders) {
    for (const f of ifsOf(o)) {
      if (shipped(f.status)) continue          // already gone; not the launch pad's question
      const why = groundedReason(o, f)
      if (!why) { clear.push(f); continue }
      if (!groundedBy.has(why)) groundedBy.set(why, [])
      groundedBy.get(why).push(f)
    }
  }
  // Biggest pile first — that is the one worth clearing.
  const groundedAlerts = [...groundedBy.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([why, items]) => ({ key: `grounded-${why}`, label: why, count: items.length, items }))

  // Scanned back in and still without a label: the Launch Bay's own "back in our
  // hands — label it and get it out" list, which is the scan bay's question.
  const backNeedsLabel = orders.flatMap((o) =>
    ifsOf(o).filter((f) => f.custodyIn && !f.labelled && !shipped(f.status)))

  // Partner orders still open — the EDI book. Distinct grain from the routing yard,
  // which counts that lane's FULFILMENTS awaiting a routing request.
  const ediOpen = orders.filter((o) => laneFor(o)?.key === 'edi' && !shipped(o.stage))

  // The one thing on this base that is about a DATE rather than a state — which is
  // what the calendar is for: ship windows closing, plus the ones already closed and
  // still sitting there, because those are the urgent half.
  //
  // ⚠️ KEYED ON window_end, NOT cancel_date. The first version read `cancelDate` and
  // reported 0 — measured: cancelDate is NULL on all 121 unshipped orders, so that
  // counter could never fire at all. `window_end` is NetSuite's own `enddate`, the
  // real ship window ingested in PR #118, and it is populated on 43 of them. An
  // always-empty column dressed as a deadline is the unreachable-branch shape.
  const soon = orders.filter((o) => {
    if (shipped(o.stage) || !o.windowEnd) return false
    const days = (new Date(o.windowEnd).getTime() - Date.now()) / 86400000
    return days <= 7
  })

  const unread = emails.filter((e) => e.isUnread ?? e.is_unread ?? false)
  const openTasks = tasks.filter((t) => t.status !== 'done')

  // `kind` tells the work panel WHAT it is listing, so it can render a fulfilment
  // differently from an email without guessing from the shape of the object.
  // `oldest` is the age of the thing that has sat here longest — the one secondary
  // fact that is honestly derivable for every building, and the one that answers
  // "is this pile stale or just busy".
  const state = (count, items, kind, stamp, alerts = []) => ({
    count, items, kind, oldest: oldestOf(items, stamp),
    // A second, DIFFERENTLY-NAMED fact about this building. Alerts exist so a real
    // finding never has to be smuggled into the headline count to be seen.
    alerts: alerts.filter((a) => a.count > 0),
  })
  return {
    receiving: state(waitingOnStock.length, waitingOnStock, 'order', (o) => o.startDate),
    stock: state(fromStock.length, fromStock, 'order', (o) => o.startDate),
    pack: state(onTheFloor.length, onTheFloor, 'fulfillment', (f) => f.custodyOut, [
      { key: 'staleTags', label: 'custody tags never closed', count: staleTags.length, items: staleTags },
    ]),
    routing: state(toRoute.length, toRoute, 'fulfillment', (f) => f.ifDate),
    // ⚠️ The headline is CLEAR FOR DEPARTURE — things to go and mark shipped. Zero is
    // a real and common answer, and it must not be padded with grounded freight.
    launch: state(clear.length, clear, 'fulfillment', (f) => f.ifDate, groundedAlerts),
    scan: state(backNeedsLabel.length, backNeedsLabel, 'fulfillment', (f) => f.custodyIn),
    edi: state(ediOpen.length, ediOpen, 'order', (o) => o.startDate),
    calendar: state(soon.length, soon, 'order', (o) => o.windowEnd),
    // ⚠️ NOT COUNTABLE. The Archive is a way IN to anything, not a backlog — a number
    // here would have to be invented, and an invented number on a base of real ones is
    // worse than none. The view renders its label instead.
    datapad: state(0, [], 'none', () => null),
    // ⚠️ NOT COUNTABLE either — see the building. The view renders its label instead.
    catalogue: state(0, [], 'none', () => null),
    comms: state(unread.length, unread, 'email', (e) => e.receivedAt || e.received_at),
    ops: state(openTasks.length, openTasks, 'task', (t) => t.createdAt || t.created_at),
  }
}

/** The earliest timestamp across items, or null. Null when nothing carries one —
 *  never `now`, which would report a stale pile as fresh. */
function oldestOf(items, stamp) {
  let out = null
  for (const it of items) {
    const v = stamp(it)
    if (!v) continue
    const t = new Date(v).getTime()
    if (Number.isNaN(t)) continue
    if (out === null || t < out) out = t
  }
  return out === null ? null : new Date(out).toISOString()
}

// ── Movers: work in transit, on the road it actually travelled ──────────────
//
// The mockup asked whether the movers mean anything. They do: a mover IS a document
// that just changed lanes, and the road it travels is that transition. Nothing is
// invented — every one of these comes from a ledger event that already exists.
//
// ⚠️ An event whose transition has no road is DROPPED, not placed somewhere near. A
// dot off the network would be the one thing this whole model exists to prevent.
const EVENT_LEG = {
  PO_RECEIVED: ['receiving', 'stock'],
  IF_CREATED: ['stock', 'pack'],
  // Custody is SCANNED, and the scan bay is where that happens — so these two now
  // travel the pack↔scan road rather than standing in for a routing move.
  CUSTODY_OUT: ['pack', 'scan'],
  CUSTODY_IN: ['scan', 'pack'],
  PACKED: ['scan', 'launch'],
  ROUTED: ['edi', 'routing'],
  ASN_SENT: ['routing', 'launch'],
  DEPARTED: ['routing', 'launch'],
  DEPARTURE_CONFIRMED: ['scan', 'launch'],
  INVOICE_SENT: ['ops', 'calendar'],
  TASK_DONE: ['comms', 'ops'],
}

/**
 * Turn recent ledger events into movers.
 *
 * @param events    the app's own ledger feed (decorated order_events)
 * @param limit     how many to put on the roads at once — this is a live view, not a
 *                  log, and forty dots on one road is noise rather than information.
 * @param perRoad   the most one road may carry.
 *
 * ⚠️ SPREAD ACROSS THE NETWORK, not first-come. Taking the newest N off the feed
 * looked right until it ran on live data: five of the eight movers came out as
 * identical "Task done" dots on the comms→ops road, because tasks get completed in
 * bursts. Five indistinguishable dots on one road say less than three varied ones
 * across three roads — and a base where only one street is ever busy reads as broken
 * rather than quiet. So this fills round-robin: each road takes its newest, then its
 * next, up to perRoad.
 */
export function moversFrom(events = [], { limit = 8, perRoad = 2 } = {}) {
  // Bucket by road, keeping feed order (newest first) within each.
  const byRoad = new Map()
  for (const e of events) {
    const leg = EVENT_LEG[e.eventType]
    if (!leg) continue
    const road = roadFor(leg[0], leg[1])
    if (!road) continue          // no road, no mover — never placed approximately
    if (!byRoad.has(road.key)) byRoad.set(road.key, [])
    byRoad.get(road.key).push({
      id: String(e.id),
      road: road.key,
      from: leg[0],
      to: leg[1],
      docType: e.docType || null,
      docNumber: e.docNumber || null,
      // ⚠️ LABEL IT HERE, do not trust the caller to have done it. /api/events
      // returns undecorated rows (no `label`) while /api/ledger returns decorated
      // ones — so the ticker read "PO_RECEIVED · Receiving → Stock depot", shouting
      // an enum at the reader on the one feed the Base view actually uses. Falling
      // back through SPINE_LABEL makes it read the same whichever feed it is given.
      label: e.label || SPINE_LABEL.get(e.eventType) || e.eventType,
      at: e.occurredAt || null,
      tone: BUILDING[leg[0]]?.tone || 'muted',
    })
  }

  // Round-robin across roads in ROADS order, so the pass is deterministic — the same
  // feed always produces the same base, which matters because this view re-renders on
  // every pulse and dots jumping roads between renders would read as movement.
  const out = []
  for (let round = 0; round < perRoad && out.length < limit; round++) {
    for (const r of ROADS) {
      const queue = byRoad.get(r.key)
      if (!queue || !queue[round]) continue
      out.push(queue[round])
      if (out.length >= limit) break
    }
  }
  return out
}

/** Is this event type something that can appear as a mover at all? */
export const isMoverEvent = (t) => Object.prototype.hasOwnProperty.call(EVENT_LEG, t)
