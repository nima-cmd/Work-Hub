// src/model/postCustody.js — what an order in our possession is WAITING ON.
//
// Nima's complaint that this exists to answer (his biggest ask, three sessions
// running): "when it's back in our possession it no longer really tracks
// possession the way we can read easily to see what is needed."
//
// Measured 2026-08-07, and the number IS the complaint: of the board's cards,
// 26 sat in ONE undifferentiated "Ball's in Our Court" column — 16 Picked, 7
// Invoiced, 3 Approved — while every stage column behind it read 0 and the only
// populated column past it was Shipped (65, all history). The board could say
// "it's here" and nothing else.
//
// ⚠️ THE RULE THAT EXPLAINS THE WHOLE BOUTIQUE BRANCH (Nima, 2026-08-07):
// MARKING PACKED IS THE INVOICE TRIGGER. "we would leave it as picked for
// boutiques so we dont invoice yet"; "we mark as packed on the day of the route
// so it invoiced that day not before". So marking packed must happen on the day
// the goods ship, never earlier — which makes a boutique sitting at `Picked` for
// weeks CORRECT AND DELIBERATE, not a stall.
//
// That is why this file reports what a card is WAITING ON rather than how old it
// is. Ageing a correct holding state is how this board has invented work four
// times now: the 28 tendered-not-idle EDI cards, labelGap's freight and FOB
// lanes, and IF7405 — which I called "the oldest boutique item, 16 days, on no
// surface" when it is packed and waiting for its ship window to open on 08-18
// (SO12344, already paid $13,636). Before flagging age, ask what it is waiting on.

import { paymentBlocked, clearedReason, netTerms } from './paymentGate.js'
import { isDepartureConfirmed, needsDepartureConfirm, inNetFlow, departureLabel } from './netDeparture.js'

// A card is either WORK (we act now) or a WATCH (correct, someone else's move).
// Kept as separate states rather than one backlog — the never-lump rule; summing
// them produces a number nobody can act on.
export const PC = {
  // ── EDI: pack in NetSuite → route → pickup confirmation → departure ──────
  EDI_NEEDS_PACK: 'EDI_NEEDS_PACK',
  EDI_NEEDS_ROUTING: 'EDI_NEEDS_ROUTING',
  EDI_AWAITING_PICKUP: 'EDI_AWAITING_PICKUP',
  EDI_AWAITING_DEPARTURE: 'EDI_AWAITING_DEPARTURE',
  // ── Boutique: label → mark packed/shipped → invoice → payment ───────────
  // (which of packed/shipped depends on the terms — see postCustodyState)
  FOB_PICKUP: 'FOB_PICKUP',
  AWAITING_SHIP_WINDOW: 'AWAITING_SHIP_WINDOW',
  NEEDS_LABEL_OR_ROUTING: 'NEEDS_LABEL_OR_ROUTING',
  NEEDS_MARK_PACKED: 'NEEDS_MARK_PACKED',
  AWAITING_INVOICE: 'AWAITING_INVOICE',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  NEEDS_MARK_SHIPPED: 'NEEDS_MARK_SHIPPED',
  // Net terms only: NetSuite already says Shipped (that is what making the label
  // does now), but the goods cannot leave until the invoice is raised.
  SHIPPED_AWAITING_INVOICE: 'SHIPPED_AWAITING_INVOICE',
  // Invoiced too, so nothing is holding it — but nobody has said it actually went,
  // and under this flow no field can say it for us (src/model/netDeparture.js).
  SHIPPED_AWAITING_DEPARTURE: 'SHIPPED_AWAITING_DEPARTURE',
  // ── Terminal ─────────────────────────────────────────────────────────────
  DEPARTED: 'DEPARTED',
}

// Work = ours to move today. Watch = correct as it stands; the move is the
// carrier's, accounting's, the customer's, or the calendar's.
export const PC_IS_WORK = {
  [PC.EDI_NEEDS_PACK]: true,
  [PC.EDI_NEEDS_ROUTING]: true,
  [PC.EDI_AWAITING_PICKUP]: false,
  [PC.EDI_AWAITING_DEPARTURE]: false,
  [PC.FOB_PICKUP]: false,
  [PC.AWAITING_SHIP_WINDOW]: false,
  [PC.NEEDS_LABEL_OR_ROUTING]: true,
  [PC.NEEDS_MARK_PACKED]: true,
  [PC.AWAITING_INVOICE]: true,
  [PC.AWAITING_PAYMENT]: false,
  [PC.NEEDS_MARK_SHIPPED]: true,
  // Work, and the whole reason this state exists: without it these cards read
  // Departed and vanish while still physically here.
  [PC.SHIPPED_AWAITING_INVOICE]: true,
  // Work, and one keystroke of it — but it is the only thing standing between
  // "goods still on our floor" and a board that says they are gone.
  [PC.SHIPPED_AWAITING_DEPARTURE]: true,
  [PC.DEPARTED]: false,
}

export const PC_LABEL = {
  [PC.EDI_NEEDS_PACK]: 'Pack in NetSuite',
  [PC.EDI_NEEDS_ROUTING]: 'Needs routing',
  [PC.EDI_AWAITING_PICKUP]: 'Awaiting pickup confirmation',
  [PC.EDI_AWAITING_DEPARTURE]: 'Awaiting departure',
  [PC.FOB_PICKUP]: 'FOB — collected in China',
  [PC.AWAITING_SHIP_WINDOW]: 'Awaiting ship window',
  [PC.NEEDS_LABEL_OR_ROUTING]: 'Needs a label or a routing',
  [PC.NEEDS_MARK_PACKED]: 'Mark packed',
  [PC.AWAITING_INVOICE]: 'Awaiting invoice',
  [PC.AWAITING_PAYMENT]: 'Awaiting payment',
  [PC.NEEDS_MARK_SHIPPED]: 'Mark shipped',
  [PC.SHIPPED_AWAITING_INVOICE]: 'Invoice it to release',
  [PC.SHIPPED_AWAITING_DEPARTURE]: 'Confirm it left',
  [PC.DEPARTED]: 'Departed',
}

// ── Colour per state (Nima, 2026-08-14) ─────────────────────────────────────
//
// His words, mapping 1:1 onto the labels above because he was reading them off the
// board: "needs label or a routing to have the title in blue, awaiting invoice should
// be yellow, awaiting payment red, invoice it to release should be purple, confirm it
// left should be green."
//
// ⚠️ Only the five he named. The rest stay uncoloured on purpose — inventing hues for
// states he did not mention would dilute the ones that mean something, and a board
// where everything is coloured is a board where nothing stands out.
//
// ⚠️ Colour REINFORCES the label, it never replaces it. Every card still shows its
// state in words and sits in a column named for that state, so nothing here is the
// only way to know what a card is — which is what keeps it readable for anyone who
// does not distinguish these hues.
export const PC_COLOR = {
  [PC.NEEDS_LABEL_OR_ROUTING]: 'blue',
  [PC.AWAITING_INVOICE]: 'yellow',
  [PC.AWAITING_PAYMENT]: 'red',
  [PC.SHIPPED_AWAITING_INVOICE]: 'purple',
  [PC.SHIPPED_AWAITING_DEPARTURE]: 'green',
}

// The three Mission Quests tabs (Nima, 2026-08-07 — he asked for tabs so each
// gets real screen space instead of ten columns in one scrolling row).
export const TAB = { ORDERS: 'orders', FULFILMENT: 'fulfilment', ACTION: 'action' }

export const TAB_LABEL = {
  [TAB.ORDERS]: 'Sales Orders',
  [TAB.FULFILMENT]: 'Fulfilment',
  [TAB.ACTION]: 'In Our Possession',
}

// Which tab a card belongs on.
//
//   ① ORDERS     — no fulfilment yet: Pending Approval, Pending Fulfillment.
//   ② FULFILMENT — a fulfilment exists but the goods are not back with us:
//                  fulfilled with NO scan out (his "we need to be aware, since
//                  it should be happening one after another"), or out with
//                  Nestor being packed.
//   ③ ACTION     — "Once its in our possesion we should be taking action."
//
// ⚠️ AN INTERPRETATION, easy to flip if it's wrong: he described ball's-in-our-
// court while describing tab ②, but then said the stages "post this state" are
// what tab ③ is for, and that possession is when we act. Leaving returned cards
// in ② would put all 26 actionable cards there and leave ③ holding nothing but
// 65 shipped orders — the very lump being fixed. So possession STARTS ③.
export function missionTab({ fulfilments = [], custodyState = null, departed = false } = {}) {
  if (departed) return TAB.ACTION
  if (!fulfilments.length) return TAB.ORDERS
  // 'returned' = every carton scanned back; 'partial' = some are (kept distinct
  // upstream so a part-scanned card is never rounded up to fully-back).
  if (custodyState === 'returned' || custodyState === 'partial') return TAB.ACTION
  if (custodyState === 'warehouse') return TAB.FULFILMENT
  return TAB.FULFILMENT
}

// A fulfilment that was created but never scanned out — the gap Nima wants to
// see, because the two steps are meant to happen back to back.
//
// ⚠️ A SHIPPED fulfilment is NOT this gap. Live 2026-08-07 the column was 3 for 3
// false — IF7142, IF7231 and IF7238 all shipped long ago and carry no scan
// because custody scanning did not exist yet. Those are the pre-custody rows
// [[ship-date-retro-audit]] already established are uncheckable forever, and
// nothing can be done about them now. The gap is only meaningful while the goods
// have not left.
export function fulfilledNeverScanned({ custodyOut, custodyIn, status } = {}) {
  if (/shipped/i.test(status || '')) return false
  return !custodyOut && !custodyIn
}

const isPacked = (f) => /packed|shipped/i.test(f?.status || '') || !!f?.packedStatus

// The least-advanced fulfilment is the one holding the shipment up, so a PO
// group takes its state from that one rather than from an average.
function blockingFulfilment(fulfilments = []) {
  const unpacked = fulfilments.filter((f) => !isPacked(f))
  return unpacked[0] || fulfilments[0] || null
}

// What is this card waiting on?
//
// `routing` is the routing_shipment covering the card's POs (null if none yet).
// `shipWindow` is the order's window (src/model/shipWindow.js). `today` is
// passed in, never read from the clock, so the states are testable.
export function postCustodyState(card = {}, today = new Date()) {
  const { source, location, fulfilments = [], invoices = [], routing = null, shipWindow = null, departed = false, terms = null } = card
  const edi = source === 'edi'

  // ── The Net-terms boutique flow (Nima, 2026-08-11) ──────────────────────────
  //
  // "an order with net 30 will not go to the pack state when a label is created
  // but the shipped state. These can go out once and invoice is created and
  // printed for them."
  //
  // So for a boutique order on Net terms, making the label is what marks it
  // SHIPPED in NetSuite — and the goods are still standing here afterwards,
  // waiting for the invoice. Two consequences, both handled below:
  //
  //   1. `Shipped` stops meaning "gone" for these. Every terminal check in this
  //      file has to ask "invoiced?" first, or the card reads Departed and drops
  //      off the board while it is physically on the floor. ⚠️ Today the
  //      invariant holds perfectly — 57 of 57 shipped boutique fulfilments are
  //      invoiced (measured 2026-08-11) — which is exactly why nothing has ever
  //      needed to check, and exactly why this would have gone unnoticed.
  //   2. The advice at the label step changes. "Mark it packed, which raises the
  //      invoice" is the DUE-ON-RECEIPT chain; on Net terms he marks it shipped
  //      and the invoice follows.
  //
  // Scope confirmed with him: all Net terms (30/45/60 — 64 of 100 open orders on
  // 2026-08-11), boutique only, and "printed" is NOT modelled — the invoice
  // existing is the signal, and printing is the physical act that follows it.
  // Tracking the print would mean a new hand-maintained field, which is the
  // shape that produced `packed_status` and `shipping_status`.
  const netFlow = !edi && netTerms(terms)
  // Named apart from the `invoiced` local further down on purpose: that one asks
  // about the BLOCKING fulfilment, this asks whether the order has an invoice at
  // all. Both readings are defensible and they are used for different questions,
  // so they are kept as two names rather than one silently reused.
  const hasInvoice = invoices.length > 0 || fulfilments.some((f) => !!f?.invoice)

  // ── Terminal: it left. Check EVERY kind of evidence before anything else. ─
  //
  // ⚠️ `departed` (the order's own SHIPPED stage) is checked here because two
  // live cards — SO12263 Pluto LA and SO12234 Centre Point Nantucket — are
  // SHIPPED with ZERO fulfilment rows. Without this they fell through every
  // branch to "needs a carrier label", on orders that have already gone and have
  // nothing to label. An empty array also makes `.every()` return TRUE, so the
  // shipped test below must keep its length guard.
  //
  // ⚠️ ON THE NET FLOW, "SHIPPED" IS NOT EVIDENCE OF DEPARTURE. It is evidence a
  // LABEL was made — the goods leave later, once the invoice is raised and
  // printed. So the release check runs BEFORE all three terminal tests, because
  // every one of them would otherwise answer "Departed" first and win.
  //
  // It requires a fulfilment: an order marked SHIPPED with no fulfilment rows at
  // all (SO12263, SO12234) never took the label path, so there is nothing here
  // to release and the old answer is right.
  const allShipped = fulfilments.length > 0 && fulfilments.every((f) => /shipped/i.test(f.status || ''))
  if (netFlow && fulfilments.length && (departed || allShipped)) {
    if (!hasInvoice) {
      return state(PC.SHIPPED_AWAITING_INVOICE,
        `Marked shipped on ${String(terms).trim()} — raise the invoice and print it, then it can go out`)
    }
    // Invoiced, so nothing is holding it — but has it actually GONE? Under this
    // flow no field can answer that (netDeparture.js), so it takes a human. The
    // epoch keeps orders marked shipped under the OLD flow out: back then the
    // keystroke happened at the dock, so it already meant departed.
    const newFlowFuls = fulfilments.filter((f) => inNetFlow({
      terms, source, shipDate: f.actualShipDate, netTerms,
    }))
    const unconfirmed = newFlowFuls.filter((f) => needsDepartureConfirm({
      shipped: true, invoiced: true, confirmed: isDepartureConfirmed(f),
    }))
    if (unconfirmed.length) {
      const f0 = unconfirmed[0]
      const days = f0.actualShipDate
        ? Math.floor((today - new Date(f0.actualShipDate)) / 86400000)
        : null
      return state(PC.SHIPPED_AWAITING_DEPARTURE,
        departureLabel({ shipDate: f0.actualShipDate, daysSince: days }))
    }
  }
  if (departed) return state(PC.DEPARTED, 'Departed')
  if (fulfilments.length && fulfilments.every((f) => /shipped/i.test(f.status || ''))) {
    return state(PC.DEPARTED, 'Departed')
  }
  if (routing?.shippedAt) return state(PC.DEPARTED, 'Departed')
  // Nothing to act on without a fulfilment — the label, the pack keystroke and
  // the invoice all hang off one. missionTab already sends these to tab ①; this
  // returns NULL rather than naming a state, because inventing one here is how a
  // card with nothing to do acquires work. Callers skip a null.
  if (!fulfilments.length) return null

  if (edi) {
    // ⚠️ READ THE FURTHEST EVIDENCE FIRST, not the chain in order.
    //
    // His chain is pack-in-NetSuite → route → pickup → departure. But live on
    // 2026-08-07 all 9 Nordstrom BOLs are routed AND tendered for Monday while
    // their fulfilments still read `Picked` in NetSuite: the status lags the
    // physical reality (the goods are on a pallet). Walking the chain in order
    // would tell him to "pack" a shipment a carrier has already been booked for
    // — the exact false positive this whole file exists to stop.
    //
    // So placement follows the furthest thing we can PROVE happened (the same
    // principle as furthestStage in stages.js), and the missing keystroke rides
    // along as a note instead of becoming the card's state.
    const packLag = fulfilments.length > 0 && fulfilments.some((f) => !isPacked(f))
    const note = packLag ? ' · still reads Picked in NetSuite' : ''

    if (routing?.bolNumber && routing.status !== 'needs_routing') {
      // The carrier + date arrive together when a tender is accepted
      // (src/ingest/manhattanTender.js), so their ABSENCE is the honest signal
      // that we're still waiting — not a guess about status strings.
      if (!routing.carrier || !routing.shipDate) {
        return state(PC.EDI_AWAITING_PICKUP, `Routed — waiting on the carrier to confirm a pickup${note}`)
      }
      // Confirmed. A WATCH, and saying so is the entire point: 28 cards in
      // exactly this state were once reported as "nothing done, oldest 16 days".
      const when = fmtDay(routing.shipDate)
      return state(PC.EDI_AWAITING_DEPARTURE, `Pickup confirmed — ${routing.carrier}${when ? ` on ${when}` : ''}${note}`)
    }
    // Not routed yet. NetSuite must be told it's packed first — that is what
    // makes an EDI shipment routable ("letting us know that the EDI shipment
    // been packed and ready for the next stage routing").
    if (packLag || !fulfilments.length) {
      return state(PC.EDI_NEEDS_PACK, 'Mark it packed in NetSuite — that is what makes it routable')
    }
    return state(PC.EDI_NEEDS_ROUTING, 'Packed and ready — route it')
  }

  // ── Boutique ────────────────────────────────────────────────────────────
  // FOB first: we never dispatch it, so it never needs a label from us. Keyed
  // on `location`, matching labelGap's rule rather than inventing a second one.
  if (/china/i.test(location || '')) {
    return state(PC.FOB_PICKUP, 'In China awaiting collection — the China warehouse confirms it')
  }

  const f = blockingFulfilment(fulfilments)
  const labelled = fulfilments.length > 0 && fulfilments.every((x) => x.labelled)
  const packed = fulfilments.length > 0 && fulfilments.every(isPacked)

  if (!packed) {
    if (!labelled) {
      // Waiting on the CALENDAR, not on us. IF7405/SO12344 is this state: packed
      // on the floor, deliberately `Picked` in NetSuite so it isn't invoiced
      // early, waiting for 2026-08-18.
      //
      // ⚠️ NOT `shipWindow.notOpenYet` — that field is about an EDI partner's
      // 850 window (shipNotBefore) and is false for every boutique, whose window
      // has source 'so' and a null `opens`. A boutique's window IS its own ship
      // date. Keying on notOpenYet put all 15 of these into "needs a label".
      //
      // Measured 2026-08-07: 15 of 15 unlabelled boutique orders in our
      // possession have a FUTURE ship date, every one already paid — so keying
      // this wrong invents 15 label jobs. A finding that is 100% one lane is a
      // lane bug (the fourth time in this repo).
      const daysToShip = shipWindow?.daysToShip
      if (typeof daysToShip === 'number' && daysToShip > 0) {
        const when = fmtDay(shipWindow.soShipDate ?? shipWindow.mustShipBy)
        return state(PC.AWAITING_SHIP_WINDOW, when
          ? `Not due to ship until ${when} — route it and mark packed that day`
          : 'Waiting for the ship window to open')
      }
      // ⚠️ THE HONEST BUCKET. Nima's two boutique cases — "create a label" vs
      // "requires us to route" — need a signal to tell apart, and we do not
      // have a confirmed one yet (the candidate is the SO's requested ship
      // method / third-party carrier account). Rather than key the lane on a
      // guess — which is how the last four false-positive rounds happened —
      // this state names BOTH options and lets the human pick.
      return state(PC.NEEDS_LABEL_OR_ROUTING, 'Needs a carrier label — or a routing, if this one ships freight')
    }
    // Labelled but not packed. WHICH keystroke comes next depends on the terms,
    // and this is the second half of the 2026-08-11 flow change: on Net terms the
    // label takes it straight to Shipped, skipping Packed entirely, and the
    // invoice is raised afterwards. Telling him to "mark it packed, which raises
    // the invoice" would be advice from the other flow — and on these orders it
    // would raise the invoice a step early, which is the same damage the
    // BACK_NOT_PACKED chip was doing before PR #83.
    if (netFlow) {
      return state(PC.NEEDS_MARK_SHIPPED,
        `Labelled on ${String(terms).trim()} — mark it shipped, then raise the invoice`)
    }
    return state(PC.NEEDS_MARK_PACKED, 'Labelled — mark it packed, which raises the invoice')
  }

  // ⚠️ PACKED DOES NOT IMPLY LABELLED, and assuming it did made this file
  // under-report. Live: IF7412 is Packed AND invoiced AND has no label — the
  // order got marked packed before its label existed. labelGap already gets this
  // right (its ordering is document → invoice → ship decision, the outstanding
  // DOCUMENT winning because it is the earlier step and is work regardless of
  // what payment is doing). Matching that ordering here is what makes the two
  // surfaces agree instead of drift — the same reason getShipDepartures was
  // reworked to derive from the launch bay rather than keep a second copy.
  if (!labelled) {
    return state(PC.NEEDS_LABEL_OR_ROUTING, 'Packed but carries no carrier label — create one')
  }

  // Packed and labelled. Invoice, then payment, then tell NetSuite it went.
  const invoiced = invoices.length > 0 || !!f?.invoice
  if (!invoiced) return state(PC.AWAITING_INVOICE, 'Packed — raise the invoice')

  // ⚠️ NOT `amountRemaining > 0`. A raw balance is not a hold, and testing it
  // that way was wrong three separate ways — all three already solved in
  // paymentGate.js, which is why this defers to it instead of re-deriving:
  //   • the NY office's `Approved For Shipping` is a one-way WAIVER. Live:
  //     SO12334 / INV11477 owes $3,262.53 AND is waived, so it is shippable.
  //     My own version parked it while labelGap correctly said "mark it shipped".
  //   • Net terms that have not come due are not a hold (the shape behind the
  //     retracted "70 unpaid" — 105 of 109 were simply not due).
  //   • "No Payment Required" carries a balance forever by design.
  const blocking = invoices.filter((i) => paymentBlocked({
    terms: i.terms, amountRemaining: i.amountRemaining, shipGate: i.shippingStatus,
  }))
  if (blocking.length) {
    const owed = blocking.reduce((n, i) => n + (Number(i.amountRemaining) || 0), 0)
    return state(PC.AWAITING_PAYMENT, `Invoiced — waiting on payment ($${owed.toLocaleString()})`)
  }

  // Labelled, invoiced, and clear to go — the last keystroke is ours. This state
  // exists because leaving it out made the possession tab read 0 work while
  // labelGap correctly listed three fulfilments needing it.
  const why = clearedReason(invoices[0] ? {
    terms: invoices[0].terms, amountRemaining: invoices[0].amountRemaining, shipGate: invoices[0].shippingStatus,
  } : {})
  return state(PC.NEEDS_MARK_SHIPPED, `Clear to ship${why ? ` (${why})` : ''} — mark it shipped in NetSuite`)

  function state(key, waitingOn) {
    return { key, label: PC_LABEL[key], waitingOn, isWork: PC_IS_WORK[key] }
  }
}

// The order the ③ columns read left to right — the flow, EDI above boutique.
export const PC_ORDER = [
  PC.EDI_NEEDS_PACK, PC.EDI_NEEDS_ROUTING, PC.EDI_AWAITING_PICKUP, PC.EDI_AWAITING_DEPARTURE,
  PC.NEEDS_LABEL_OR_ROUTING, PC.NEEDS_MARK_PACKED, PC.AWAITING_INVOICE, PC.AWAITING_PAYMENT, PC.NEEDS_MARK_SHIPPED,
  PC.SHIPPED_AWAITING_INVOICE, PC.SHIPPED_AWAITING_DEPARTURE,
  PC.AWAITING_SHIP_WINDOW, PC.FOB_PICKUP, PC.DEPARTED,
]

// Find the routing shipment covering a card's PO. routing_shipment is keyed by
// (partner, DC) and rolls up 1..many POs, so the PO is looked up inside
// memberPos — the card has no shipment id of its own.
export function routingForPo(shipments = [], poNumber) {
  if (!poNumber) return null
  const hits = shipments.filter((s) => (s.memberPos || []).includes(String(poNumber)))
  if (!hits.length) return null
  // An un-departed shipment is the live one; a PO can also appear on an older
  // shipped BOL from a previous cycle.
  const live = hits.filter((s) => !s.shippedAt)
  if (!live.length) return hits[0]
  // ⚠️ ONE PO CARD CAN SPAN MANY BOLs. routing_shipment's grain is (partner, DC)
  // and Nordstrom splits one PO across up to 9 DCs — live 2026-08-07, PO
  // 50073677 alone covers 9 BOLs. Returning whichever came first would let the
  // card claim "pickup confirmed" while a sibling DC was still unrouted. Take
  // the LEAST advanced, for the same reason blockingFulfilment does: the one
  // furthest behind is what actually holds the shipment up.
  return live.slice().sort((a, b) => routingRank(a) - routingRank(b))[0]
}

// How far along a single routing shipment is. Only used to pick the laggard
// among a card's shipments — deliberately not exported as a state.
function routingRank(s) {
  if (!s?.bolNumber || s.status === 'needs_routing') return 0
  if (!s.carrier || !s.shipDate) return 1
  return 2
}

function fmtDay(v) {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
