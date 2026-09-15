// src/model/containerDelivery.js — did the container actually get here, and says who?
//
// Step 1 gave a container one identity. This is the leg that identity could not answer:
// the freight is at sea, then it is at the port, then — invisibly — it is at our door,
// and then somebody receives the transfer orders and the units become usable. Until this
// file existed the app could see the first two and the last one, and had nothing at all
// for the step that matters most.
//
// ── ⚠️ PORT ARRIVAL IS NOT DELIVERY, AND NOTHING HERE MAY DERIVE ONE FROM THE OTHER ──
//
// Nima, 2026-09-15: *"59 hasn't arrived it arrived at port, the part where its
// transported to us is the part that is invisible."* I had already made this mistake
// once in this project — read the 59-carton container's port date, called it landed, and
// reported its receipts as overdue. They were not overdue; the freight was on a dock.
//
// GLC WiseGrid reports the vessel reaching the port of discharge. The drayage from the
// port to Glendale is arranged by nobody whose system we can read. So `portArrivedOn` is
// evidence about a SHIP, and this module treats it as a date to display and never as an
// input to the delivery state. db/schema.sql says the same thing at the column.
//
// ── THE THREE STATES, AND WHY THE THIRD ONE IS NOT "NOT DELIVERED" ───────────────
//
//   received   every transfer order has an item receipt. OBSERVED, from NetSuite.
//   delivered  a person recorded that it arrived. ENTERED, and it carries who said so.
//   unknown    neither. NOT the same as "it has not arrived".
//
// ⚠️ THE THIRD STATE IS THE WHOLE POINT. A container at sea and a container sitting in
// the yard since Tuesday that nobody has received both have no receipt — and collapsing
// them into one "not delivered" bucket is how the yard one stays invisible. Every
// counter here partitions on KNOWN facts (see CLAUDE.md: a counter that counts something
// other than its label), so `awaitingReceipt` counts containers a person SAID are here,
// never "everything without a receipt".
//
// ── THE ONE NEW PIECE OF WORK THIS SURFACES ──────────────────────────────────────
//
// delivered (entered) + not yet received (observed) = units on our floor that no order
// can draw on. That is the first genuinely actionable thing the container work produces,
// and it is only expressible because the two facts come from different places and are
// kept apart.
//
// ── ⚠️ "TRANSIT DAYS" IS NOT TIME AT SEA, AND I ALMOST SHIPPED IT AS IF IT WERE ──
//
// `previoustransactionlinelink` gives both ends of the NetSuite chain: the transfer's
// fulfilment (ItemShip) and its receipt (ItemRcpt). Subtracting them is tempting to call
// transit time. It is NOT. Measured on the 59-carton container:
//
//     packing slip pack date   2026-08-17   the factory finished
//     TO fulfilled             2026-08-17   NetSuite bookkeeping — tracks the slip
//     GLC vessel ETD           2026-08-25   the ship actually left, EIGHT DAYS LATER
//
// The fulfilment date is a bookkeeping event that follows the packing slip, not a
// departure. So the span it opens is named for what it really is: the window in which
// the units belong to neither warehouse and no order can use them. That window IS the
// operationally interesting number — it just is not "days at sea", and a column called
// `transitDays` would have joined src/model/fieldAssumptions.js within the month.
//
// Observed across the six containers that have completed the round trip (2026-09-15):
// 0, 7, 15, 28, 34, 39 days. Two of those are air.

/** How we came to believe a container is here. Ordered: the first that applies wins. */
export const DELIVERY_EVIDENCE = {
  RECEIVED: {
    key: 'received',
    label: 'received in NetSuite',
    kind: 'observed',
    detail: 'every transfer order has an item receipt — the units are on the books in Glendale',
  },
  ENTERED: {
    key: 'entered',
    label: 'recorded by a person',
    kind: 'entered',
    detail: 'somebody said it arrived; NetSuite does not know yet',
  },
}

/**
 * ⚠️ NOT EVIDENCE OF DELIVERY — kept here so the reason is written down at the one place
 * somebody would go looking to add it. A port date is the ship's news, not ours.
 */
export const NOT_DELIVERY_EVIDENCE = {
  portArrivedOn: 'the vessel reached the port of discharge; the drayage to us is untracked',
  etaOn: 'the forwarder\'s prediction, which is not an observation of anything',
  packedOn: 'the factory finished packing — it is always before the freight moves',
}

const asDate = (v) => {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(+d) ? null : d
}
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null)

/**
 * Has every transfer order been received?
 *
 * ⚠️ EVERY, AND AN EMPTY LIST IS NOT "EVERY". `[].every()` is true, which would report a
 * container with no recorded China leg as fully received — the units would read as on
 * the shelf because we know nothing about them. Same trap as the least-advanced-TO rule
 * in containerTransfer.containerLeg, from the other direction.
 */
export function allReceived(transferOrders = []) {
  if (!transferOrders.length) return false
  return transferOrders.every((t) => asDate(t.receivedOn) != null)
}

/**
 * The date the last transfer order was received — when the container was finished, not
 * when the first piece of it showed up.
 *
 * ⚠️ MAX, NOT MIN. The 321-carton container's receipts are dated 8/17 and 8/18; reading
 * the earliest would date the container a day before part of it was on the books.
 */
export function receivedOn(transferOrders = []) {
  const dates = transferOrders.map((t) => asDate(t.receivedOn)).filter(Boolean)
  if (!dates.length || dates.length !== transferOrders.length) return null
  return iso(new Date(Math.max(...dates.map((d) => +d))))
}

/**
 * Where a container's delivery stands.
 *
 * @param container.transferOrders  [{ toNumber, status, fulfilledOn, receivedOn }]
 * @param container.deliveredOn     ENTERED date somebody recorded, or null
 * @param container.deliveredBy     who recorded it — an entered fact names its author
 * @param container.portArrivedOn   displayed, NEVER consulted for the state
 */
export function deliveryFor(container = {}) {
  const tos = container.transferOrders || []
  const entered = asDate(container.deliveredOn)

  if (allReceived(tos)) {
    const on = receivedOn(tos)
    return {
      state: 'received',
      on,
      evidence: DELIVERY_EVIDENCE.RECEIVED,
      // ⚠️ A person's date is KEPT when NetSuite also knows, rather than overwritten.
      // They answer different questions: when it hit the floor vs when it hit the books,
      // and the gap between them is the receiving backlog we are trying to make visible.
      enteredOn: entered ? iso(entered) : null,
      why: `all ${tos.length} transfer order${tos.length === 1 ? '' : 's'} received`,
      actionable: false,
    }
  }

  if (entered) {
    const open = tos.filter((t) => !asDate(t.receivedOn))
    return {
      state: 'delivered',
      on: iso(entered),
      evidence: DELIVERY_EVIDENCE.ENTERED,
      enteredOn: iso(entered),
      by: container.deliveredBy || null,
      why: container.deliveredBy
        ? `${container.deliveredBy} recorded it arrived on ${iso(entered)}`
        : `recorded as arrived on ${iso(entered)}`,
      // ⚠️ THE ONE ACTIONABLE STATE. It is here and the books do not know.
      actionable: open.length > 0,
      awaitingReceipt: open.map((t) => t.toNumber),
      units: open.reduce((a, t) => a + (Number(t.units) || 0), 0),
    }
  }

  return {
    state: 'unknown',
    on: null,
    evidence: null,
    // ⚠️ SAYS WHAT IS MISSING, not that it has not arrived. The port date is printed in
    // the reason precisely so nobody reads its ABSENCE from the state as a contradiction.
    why: container.portArrivedOn
      ? `at the port on ${iso(container.portArrivedOn)} — the drayage to us is tracked by nobody, so arrival is only known when somebody records it`
      : 'no receipt and nobody has recorded it arriving',
    actionable: false,
  }
}

/**
 * The window in which the units belong to neither warehouse — TO fulfilled to TO
 * received. See the header: this is NOT time at sea and must never be labelled so.
 */
export const UNUSABLE_WINDOW_LABEL = 'days the units were usable by nobody (transfer fulfilled → received)'

export function unusableWindow(transferOrders = []) {
  const spans = transferOrders
    .map((t) => ({ from: asDate(t.fulfilledOn), to: asDate(t.receivedOn) }))
    .filter((s) => s.from && s.to)
  if (!spans.length) return null
  const from = new Date(Math.min(...spans.map((s) => +s.from)))
  const to = new Date(Math.max(...spans.map((s) => +s.to)))
  return { fulfilledOn: iso(from), receivedOn: iso(to), days: Math.round((+to - +from) / 864e5), label: UNUSABLE_WINDOW_LABEL }
}

/**
 * Containers a person said are here and NetSuite has not been told about.
 *
 * ⚠️ THE FILTER IS state === 'delivered', NOT "no receipt". Counting every container
 * without a receipt would sweep in everything still at sea and report freight in the
 * Pacific as a receiving backlog — the counter-label bug this repo keeps finding.
 */
export function awaitingReceipt(containers = []) {
  return containers
    .map((c) => ({ container: c, delivery: deliveryFor(c) }))
    .filter(({ delivery }) => delivery.state === 'delivered' && delivery.actionable)
    .map(({ container, delivery }) => ({
      label: container.containerLabel || container.label || null,
      deliveredOn: delivery.on,
      by: delivery.by,
      transferOrders: delivery.awaitingReceipt,
      units: delivery.units,
      action: `receive ${delivery.awaitingReceipt.length} transfer order${delivery.awaitingReceipt.length === 1 ? '' : 's'} — ${delivery.units} units are on the floor and no order can draw on them`,
    }))
}
