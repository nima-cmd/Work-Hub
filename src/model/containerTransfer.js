// src/model/containerTransfer.js — the China → US leg of a container, as transfer orders.
//
// Nima, 2026-09-15, explaining the flow: "we receive the units in china to mark the date
// that the factory completes them... the receive is for accounting... 30 percent is paid
// up front when the PO start the rest is paid upon completition. Once we recieve the
// units in china if they are coming to the US we have a transfer order which we leave a
// link to the original PO in the transfer order... the transfer order is then fulfilled,
// usually to a ship state that way the units can't be used for any order in china and
// aren't in the LA warehouse either."
//
// So the chain is:
//
//   PO  →  Item Receipt in China   the factory finished; this date is the INVOICE date
//       →  Transfer Order per PO   memo carries the container label
//       →  TO fulfilled            Pending Receipt = in transit, usable by nobody
//       →  TO received             the units are finally in Glendale
//
// ⚠️ THIS IS NOT THE OUTBOUND TRANSFER FEATURE AND MUST NOT BE FOLDED INTO IT.
// src/model/transferOrder.js tracks transfers to Office and Consignment, and its header
// records Nima's reason for that scope in his own words: "its genuinely work we want to
// track its NOT A CONTAINER BEING SHIPPED TO US IN THE SHAPE OF A TRANSFER ORDER." That
// file also says widening TRACKED_DESTINATIONS is "a decision, never a guess". So these
// live here instead — same NetSuite record type, a different question.
//
// ⚠️ THE MEMO IS THE CONTAINER LABEL — BUT NOT ALWAYS BYTE FOR BYTE, AND I CLAIMED IT
// WAS. It matched exactly for two of the three live containers and not the third:
//
//   packing slip   "55 LCL carton 2026.9.7"
//   TO memo        "55 LCL to LA carton 2026.9.7"
//
// Four transfer orders, 1,439 units, silently unmatched on an exact compare. So the key
// is the STRUCTURE both strings share rather than the whole string: every label is
// "<carton count> …words… carton <YYYY.M.D>", and the count plus the date identify the
// container. That is derived from the format, not from string similarity — a fuzzy
// match here would eventually attach a transfer order to the wrong freight.
//
// ⚠️ AND A COLLISION IS REFUSED, NOT RESOLVED. Two containers with the same carton count
// on the same date would key identically; `containerKey` callers must treat a duplicate
// key as unmatchable rather than picking one.

/** NetSuite's status strings for a transfer order, in the order they happen. */
export const TO_STATES = {
  'Transfer Order : Pending Approval': { leg: 'not yet released', arrived: false, order: 0 },
  'Transfer Order : Pending Fulfillment': { leg: 'not yet shipped from China', arrived: false, order: 1 },
  'Transfer Order : Pending Receipt': { leg: 'in transit', arrived: false, order: 2 },
  'Transfer Order : Partially Received': { leg: 'partly landed', arrived: 'partly', order: 3 },
  'Transfer Order : Received': { leg: 'landed in Glendale', arrived: true, order: 4 },
  'Transfer Order : Closed': { leg: 'closed', arrived: true, order: 5 },
}

export const legFor = (status) => TO_STATES[String(status ?? '').trim()] || null

/** Normalise a memo for matching. Trim only — used for the exact pass. */
export const memoKey = (memo) => String(memo ?? '').trim()

/**
 * The structural key both a slip label and a TO memo produce: carton count + date.
 *
 * "55 LCL carton 2026.9.7"        → "55|2026.9.7"
 * "55 LCL to LA carton 2026.9.7"  → "55|2026.9.7"
 *
 * Returns null when the string is not in that shape, so a memo like "PO1616Transfer"
 * cannot accidentally key to anything.
 */
export function containerKey(label) {
  const s = String(label ?? '').trim()
  const count = s.match(/^\s*(\d+)\b/)
  const date = s.match(/(\d{4}\.\d{1,2}\.\d{1,2})\s*$/)
  if (!count || !date) return null
  return `${Number(count[1])}|${date[1]}`
}

/**
 * Group transfer orders under the container their memo names.
 *
 * ⚠️ A TO WHOSE MEMO MATCHES NO CONTAINER IS RETURNED, NOT DROPPED. TO217 and TO215
 * exist in the same date range with memos "" and "PO1616Transfer" — a transfer order
 * that is not a container leg is normal, and one that SHOULD be and has a typo'd memo
 * is exactly the thing that must not vanish silently.
 */
export function groupByContainer(transferOrders = [], containerLabels = []) {
  const exact = new Map(containerLabels.map((l) => [memoKey(l), l]))

  // ⚠️ A STRUCTURAL KEY SHARED BY TWO CONTAINERS IS DROPPED, NOT GUESSED AT. Same carton
  // count, same date, two different containers — picking one attaches real freight to
  // the wrong label, which is worse than leaving it unmatched for someone to look at.
  const byKey = new Map()
  const collided = new Set()
  for (const l of containerLabels) {
    const k = containerKey(l)
    if (!k) continue
    if (byKey.has(k)) { collided.add(k); continue }
    byKey.set(k, l)
  }
  for (const k of collided) byKey.delete(k)

  const byContainer = new Map()
  const unmatched = []
  const matchedLoosely = []
  for (const to of transferOrders) {
    const memo = memoKey(to.memo)
    let label = exact.get(memo) || null
    if (!label) {
      const k = containerKey(memo)
      if (k && byKey.has(k)) { label = byKey.get(k); matchedLoosely.push({ to: to.toNumber, memo, label }) }
    }
    if (!label) { unmatched.push(to); continue }
    if (!byContainer.has(label)) byContainer.set(label, [])
    byContainer.get(label).push(to)
  }
  // `matchedLoosely` is reported so a label that only matches structurally is visible
  // rather than silently equated.
  return { byContainer, unmatched, matchedLoosely, collided: [...collided] }
}

/**
 * Where one container's freight actually is, from its transfer orders.
 *
 * ⚠️ THE CONTAINER'S STATE IS THE LEAST-ADVANCED TO, NOT THE MOST. Six TOs where five
 * are received and one is in transit is a container that has NOT landed — reporting the
 * furthest-along leg would call it done while a PO is still at sea.
 */
export function containerLeg(transferOrders = []) {
  if (!transferOrders.length) {
    return { known: false, why: 'no transfer orders carry this container label — the China leg is not recorded' }
  }
  const legs = transferOrders.map((t) => ({ to: t.toNumber, status: t.status, ...(legFor(t.status) || { leg: 'unrecognised status', order: -1 }) }))
  const unrecognised = legs.filter((l) => l.order === -1)
  const least = legs.reduce((a, b) => (b.order < a.order ? b : a))
  const units = transferOrders.reduce((a, t) => a + (Number(t.units) || 0), 0)
  return {
    known: true,
    leg: least.leg,
    arrived: legs.every((l) => l.arrived === true),
    transferOrders: legs,
    units,
    // ⚠️ Named rather than folded in — a status string we do not recognise is a change
    // at NetSuite's end, and guessing which leg it means is how a container silently
    // reads as landed.
    unrecognised: unrecognised.map((l) => `${l.to}: "${l.status}"`),
    mixed: new Set(legs.map((l) => l.order)).size > 1,
  }
}

/**
 * What is left to do for a container, in words.
 *
 * ⚠️ PORT ARRIVAL IS NOT DELIVERY, AND THE APP CANNOT SEE THE DIFFERENCE. Nima,
 * 2026-09-15: "59 hasn't arrived it arrived at port, the part where its transported to
 * us is the part that is invisible." GLC reports the vessel reaching the port of
 * discharge; the drayage from there to Glendale is tracked by nobody we can read. So a
 * container that has arrived at port and whose TOs are still Pending Receipt is the
 * NORMAL state, not a missed step — and this must never tell someone to receive a
 * transfer order on the strength of a port date.
 */
export function nextAction(container = {}) {
  const leg = containerLeg(container.transferOrders || [])
  if (!leg.known) return { action: 'record the China leg', why: leg.why, blocking: false }
  if (leg.arrived) return { action: 'nothing — landed and received', why: null, blocking: false }
  if (leg.leg === 'in transit') {
    return {
      action: 'wait for delivery, then receive the transfer orders',
      why: container.portArrivedOn
        ? `GLC shows it at the port on ${container.portArrivedOn}. The drayage to Glendale is not tracked anywhere we can read, so arrival at the door is only known when someone says so.`
        : 'still at sea by the forwarder\'s reckoning.',
      blocking: false,
      transferOrders: leg.transferOrders.map((l) => l.to),
    }
  }
  return { action: `not shipped yet — ${leg.leg}`, why: null, blocking: false }
}
