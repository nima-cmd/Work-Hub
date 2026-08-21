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
import { SPINE_LABEL } from './orderEvents.js'

// ── The buildings ───────────────────────────────────────────────────────────
//
// `sprite` names a real render from client/public/base — see the README there for
// what each structure actually is and why it carries this lane. Swapping two is a
// one-line change here and nowhere else.
export const BUILDINGS = [
  {
    key: 'receiving', label: 'Receiving', sprite: 'bldg-02', tone: 'arrive',
    // A shed on legs with an annex, at the west gate: where goods enter the base.
    x: 6, y: 40, w: 15, h: 20,
    of: 'presold, waiting on stock',
    view: 'allocations',
  },
  {
    key: 'stock', label: 'Stock depot', sprite: 'bldg-03', tone: 'money',
    // Twin silos beside a long hall — the pool ATS orders pull from.
    x: 25, y: 62, w: 14, h: 18,
    of: 'orders pulling from stock',
    view: 'table',
  },
  {
    key: 'pack', label: 'Pack house', sprite: 'bldg-04', tone: 'hands',
    // Dock doors right around the perimeter. The busiest building on the base.
    x: 43, y: 34, w: 15, h: 20,
    of: 'out on the floor, not back',
    view: 'kanban',
  },
  {
    key: 'routing', label: 'Routing yard', sprite: 'bldg-05', tone: 'edi',
    x: 62, y: 62, w: 12, h: 16,
    of: 'freight waiting to be routed',
    view: 'routing',
  },
  {
    key: 'launch', label: 'Launch pad', sprite: 'bldg-00', tone: 'holo',
    // The docking ring, twelve bays. East end: where it leaves.
    x: 79, y: 32, w: 18, h: 24,
    of: 'cleared, waiting on the truck',
    view: 'ship',
  },
  {
    key: 'comms', label: 'Comms tower', sprite: 'bldg-06', tone: 'edi',
    x: 28, y: 8, w: 10, h: 14,
    of: 'transmissions to answer',
    view: 'transmissions',
  },
  {
    key: 'ops', label: 'Ops centre', sprite: 'bldg-01', tone: 'go',
    // The stepped terrace block, tallest on the sheet. The desk.
    x: 62, y: 6, w: 13, h: 17,
    of: 'open on the day plan',
    view: 'plan',
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
  { key: 'in-stock', from: 'receiving', to: 'stock' },
  { key: 'stock-pack', from: 'stock', to: 'pack' },
  { key: 'pack-routing', from: 'pack', to: 'routing' },
  { key: 'pack-launch', from: 'pack', to: 'launch' },
  { key: 'routing-launch', from: 'routing', to: 'launch' },
  { key: 'comms-ops', from: 'comms', to: 'ops' },
  { key: 'comms-pack', from: 'comms', to: 'pack' },
  { key: 'ops-launch', from: 'ops', to: 'launch' },
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

  // Labelled and not yet confirmed gone. `labelled` is a boolean the API derives from
  // tracking numbers; departureConfirmedAt is a human attesting it left. A label is
  // NOT a departure — that distinction is why both are read here.
  //
  // ⚠️ AND NOT SHIPPED, for the SAME reason the pack house needed it — this is the
  // second instance of one mistake. Measured live: 44 were labelled-and-unconfirmed,
  // of which only 8 had not shipped. The other 36 shipped weeks ago (oldest 71 days)
  // and were never manually confirmed, because the manual confirmation only exists
  // since 2026-08-13. "Cleared, waiting on the truck" was describing history: no
  // truck is still waiting on a shipment that left in June.
  const labelledUnconfirmed = orders.flatMap((o) =>
    ifsOf(o).filter((f) => f.labelled && !f.departureConfirmedAt))
  const cleared = labelledUnconfirmed.filter((f) => !shipped(f.status))
  // A real backlog, but a different one: departures nobody ever attested. Mostly
  // pre-dating the feature. Named for what it is.
  const neverConfirmed = labelledUnconfirmed.filter((f) => shipped(f.status))

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
    launch: state(cleared.length, cleared, 'fulfillment', (f) => f.ifDate, [
      { key: 'neverConfirmed', label: 'shipped, departure never confirmed', count: neverConfirmed.length, items: neverConfirmed },
    ]),
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
  CUSTODY_OUT: ['stock', 'pack'],
  CUSTODY_IN: ['pack', 'routing'],
  PACKED: ['pack', 'launch'],
  ROUTED: ['pack', 'routing'],
  ASN_SENT: ['routing', 'launch'],
  DEPARTED: ['routing', 'launch'],
  DEPARTURE_CONFIRMED: ['routing', 'launch'],
  INVOICE_SENT: ['ops', 'launch'],
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
