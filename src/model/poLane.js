// src/model/poLane.js — where a PO's stock is actually going, and who it is for.
//
// `purchase_orders.destination` is `custbody_acs_final_destination` resolved through
// `location.fullname` (src/ingest/netsuiteSync.js). The app has stored it since the PO
// table went live and has never once asked what it MEANS — every screen shows the raw
// location name, so "Virtual Warehouse" and "Warehouse Bulk : Nordstrom" sit side by
// side as if they were the same kind of answer. They are not: one is our own retail
// stock, the other is bought against a partner's order.
//
// ── ⚠️ "China" IS A DESTINATION, AND IT MEANS THE STOCK IS NOT COMING ────────────
//
// Measured on the 80 open POs (2026-09-18): China 20 · no destination 20 · Virtual
// Warehouse 17 · Warehouse 7 · Warehouse Bulk : Nordstrom 7 · Bloomingdale's 5 ·
// Saint Bernard 2 · Shopbop 2.
//
// A PO whose final destination is China is FOB — the goods are collected there and
// never enter our warehouse (see [[fob-china-pickup-lane]]: 0 of 12 ever had a label).
// Counting those units as inbound supply for a drop would promise a launch merchandise
// that is, by design, somebody else's problem to collect.
//
// ── ⚠️ AND THIS IS THE HEADER FIELD, NOT THE LINE'S `location` ───────────────────
//
// The PO LINE's `location` is China on essentially every PO because that is the receive
// default, and reading it instead gave two wrong answers in one sitting. `destination`
// here comes from the transaction HEADER's `custbody_acs_final_destination`. The two
// look identical in a result set and mean opposite things — the line says where it is
// now, the header says where it is going.
//
// ── ⚠️ NO DESTINATION IS ITS OWN ANSWER, ON A QUARTER OF THE BOARD ───────────────
//
// 20 of 80 open POs carry no final destination at all. That is not "unclassified noise"
// to be swept into a default lane — it is 20 POs nobody has said where to send, which is
// a question worth surfacing rather than a gap worth filling. Defaulting them to retail
// would be [[default-is-not-an-answer]] with freight attached.

/**
 * The lanes, in the order a person cares about them. `key` is stable; `label` is what a
 * screen shows.
 *
 * ⚠️ `fob` IS NOT A PLACE WE RECEIVE. It is kept in the list so the units are visible
 * and excluded from anything that means "stock arriving here" — see `arrivesHere`.
 */
export const LANES = {
  retail: { key: 'retail', label: 'Retail', detail: 'our own ecom stock (Virtual Warehouse)', arrivesHere: true },
  boutique: { key: 'boutique', label: 'Boutique', detail: 'the boutique/wholesale floor (Warehouse)', arrivesHere: true },
  partner: { key: 'partner', label: 'Partner', detail: 'bought against a partner order (Warehouse Bulk)', arrivesHere: true },
  fob: { key: 'fob', label: 'FOB China', detail: 'collected in China — never enters our warehouse', arrivesHere: false },
  unknown: { key: 'unknown', label: 'No destination', detail: 'nobody has said where this goes', arrivesHere: false },
}

export const LANE_ORDER = ['retail', 'boutique', 'partner', 'fob', 'unknown']

/**
 * Classify one `destination` string into a lane.
 *
 * @returns {{ lane: string, label: string, partner: string|null, destination: string|null, why: string }}
 *
 * ⚠️ THE PARTNER NAME IS CARRIED, NOT DISCARDED. "Warehouse Bulk : Nordstrom" and
 * "Warehouse Bulk : Shopbop" are both the partner lane and they are not interchangeable
 * — a Nordstrom PO late for a drop is a chargeback, a Shopbop one is not. Folding them
 * into one bucket would erase exactly the distinction the lane exists to draw.
 *
 * ⚠️ MATCHED ON THE FULL PATH'S PARTS, NOT `includes`. `String.includes('Warehouse')`
 * is true for "Virtual Warehouse" and for every "Warehouse Bulk : X", so a substring
 * test collapses three lanes into one. The path is split on ':' and the ROOT decides.
 */
export function poLane(destination) {
  const raw = String(destination ?? '').trim()
  if (!raw) {
    return {
      lane: 'unknown', label: LANES.unknown.label, partner: null, destination: null,
      why: 'no final destination on the PO — nobody has said where this stock goes',
    }
  }
  // "Warehouse Bulk : Nordstrom" → ['Warehouse Bulk', 'Nordstrom']
  const parts = raw.split(':').map((p) => p.trim()).filter(Boolean)
  const root = parts[0] || raw
  const leaf = parts.length > 1 ? parts[parts.length - 1] : null

  if (/^china$/i.test(root)) {
    return {
      lane: 'fob', label: LANES.fob.label, partner: null, destination: raw,
      why: 'the final destination is China — FOB, collected there and never received here',
    }
  }
  if (/^warehouse bulk$/i.test(root)) {
    return {
      lane: 'partner', label: LANES.partner.label, partner: leaf, destination: raw,
      why: leaf ? `bulk stock bought for ${leaf}` : 'bulk stock for a partner the location does not name',
    }
  }
  if (/^virtual warehouse$/i.test(root)) {
    return {
      lane: 'retail', label: LANES.retail.label, partner: null, destination: raw,
      why: 'Virtual Warehouse is our own ecom stock',
    }
  }
  if (/^warehouse$/i.test(root)) {
    return {
      lane: 'boutique', label: LANES.boutique.label, partner: null, destination: raw,
      why: 'the Warehouse floor — boutique and wholesale stock',
    }
  }
  // ⚠️ AN UNRECOGNISED LOCATION IS NAMED, NOT BUCKETED. NetSuite's location tree is
  // edited by people; a new destination should show up as a question on the screen
  // rather than be quietly absorbed into whichever lane sorts first.
  return {
    lane: 'unknown', label: LANES.unknown.label, partner: null, destination: raw,
    why: `"${raw}" is not a location this app recognises as a lane`,
  }
}

/**
 * The lane breakdown for a set of PO lines, by units.
 *
 * @param lines [{ destination, units }]
 *
 * ⚠️ A BREAKDOWN, NEVER ONE LANE. A PO can carry lines for several destinations, and a
 * season certainly does — reporting "the lane" for a season that is 900 retail units and
 * 300 Nordstrom units would erase the partner deadline, which is the one with a penalty.
 */
export function laneBreakdown(lines = []) {
  const by = new Map()
  let total = 0
  for (const l of lines) {
    const units = Number(l.units) || 0
    const c = poLane(l.destination)
    // Partner lanes are kept apart by partner; the others are one bucket each.
    const key = c.lane === 'partner' && c.partner ? `partner:${c.partner}` : c.lane
    const e = by.get(key) || { ...c, units: 0 }
    e.units += units
    by.set(key, e)
    total += units
  }
  const order = (l) => {
    const i = LANE_ORDER.indexOf(l.lane)
    return i === -1 ? LANE_ORDER.length : i
  }
  return {
    total,
    lanes: [...by.values()].sort((a, b) => order(a) - order(b) || b.units - a.units),
    // ⚠️ The units that will actually turn up here. FOB and unrouted stock are real and
    // are NOT arriving, so a "how much is coming for Holiday" figure must exclude them.
    arriving: [...by.values()].filter((l) => LANES[l.lane]?.arrivesHere).reduce((a, l) => a + l.units, 0),
  }
}
