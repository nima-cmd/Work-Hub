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

// ── The buildings ───────────────────────────────────────────────────────────
//
// `sprite` names a real render from client/public/base — see the README there for
// what each structure actually is and why it carries this lane. Swapping two is a
// one-line change here and nowhere else.
export const BUILDINGS = [
  {
    key: 'receiving', label: 'Receiving', sprite: 'bldg-02', tone: 'arrive',
    // A shed on legs with an annex, at the west gate: where goods enter the base.
    x: 6, y: 40, w: 15,
    of: 'presold, waiting on stock',
    view: 'allocations',
  },
  {
    key: 'stock', label: 'Stock depot', sprite: 'bldg-03', tone: 'money',
    // Twin silos beside a long hall — the pool ATS orders pull from.
    x: 25, y: 62, w: 14,
    of: 'orders pulling from stock',
    view: 'table',
  },
  {
    key: 'pack', label: 'Pack house', sprite: 'bldg-04', tone: 'hands',
    // Dock doors right around the perimeter. The busiest building on the base.
    x: 43, y: 34, w: 15,
    of: 'out on the floor, not back',
    view: 'kanban',
  },
  {
    key: 'routing', label: 'Routing yard', sprite: 'bldg-05', tone: 'edi',
    x: 62, y: 62, w: 12,
    of: 'freight waiting to be routed',
    view: 'routing',
  },
  {
    key: 'launch', label: 'Launch pad', sprite: 'bldg-00', tone: 'holo',
    // The docking ring, twelve bays. East end: where it leaves.
    x: 79, y: 32, w: 18,
    of: 'cleared, waiting on the truck',
    view: 'ship',
  },
  {
    key: 'comms', label: 'Comms tower', sprite: 'bldg-06', tone: 'edi',
    x: 28, y: 8, w: 10,
    of: 'transmissions to answer',
    view: 'transmissions',
  },
  {
    key: 'ops', label: 'Ops centre', sprite: 'bldg-01', tone: 'go',
    // The stepped terrace block, tallest on the sheet. The desk.
    x: 62, y: 6, w: 13,
    of: 'open on the day plan',
    view: 'plan',
  },
]

export const BUILDING = Object.fromEntries(BUILDINGS.map((b) => [b.key, b]))

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
  const onTheFloor = orders.flatMap((o) => ifsOf(o).filter((f) => f.custodyOut && !f.custodyIn))

  // EDI freight that exists as a fulfilment but has not shipped.
  const toRoute = orders
    .filter((o) => lane(o) === 'edi')
    .flatMap((o) => ifsOf(o).filter((f) => !shipped(f.status)))

  // Labelled and not yet confirmed gone. `labelled` is a boolean the API derives from
  // tracking numbers; departureConfirmedAt is a human attesting it left. A label is
  // NOT a departure — that distinction is why both are read here.
  const cleared = orders.flatMap((o) =>
    ifsOf(o).filter((f) => f.labelled && !f.departureConfirmedAt))

  const unread = emails.filter((e) => e.isUnread ?? e.is_unread ?? false)
  const openTasks = tasks.filter((t) => t.status !== 'done')

  return {
    receiving: { count: waitingOnStock.length, items: waitingOnStock },
    stock: { count: fromStock.length, items: fromStock },
    pack: { count: onTheFloor.length, items: onTheFloor },
    routing: { count: toRoute.length, items: toRoute },
    launch: { count: cleared.length, items: cleared },
    comms: { count: unread.length, items: unread },
    ops: { count: openTasks.length, items: openTasks },
  }
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
      label: e.label || e.eventType,
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
