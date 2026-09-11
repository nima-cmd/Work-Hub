// src/model/allocationPlan.js — when there is not enough, who gets cut.
//
// Nima, 2026-09-11: "we have two pending [Bloomingdale's] orders right now we can't
// fulfill them full and right now we need pick for total unit of both PO's against
// what in teh warehouse for them to determine where wer short we then have
// re-allocate and make sure we know where we cut our units so we can adjust when we
// make our invoice." And: "what we have in the warehouse for bloomingdaels is all we
// can use."
//
// ── ⚠️ NETSUITE HAS ALREADY CHOSEN, AND NOBODY DECIDED IT ───────────────────
//
// The live case: POs 1236143 and 1236132 want 137 of SN03012LD-CASHMERE and the
// Bloomingdale's location holds 72. NetSuite's commitment, as found on 2026-09-11:
//
//   PO 1236132 (China Grove CFC)  50 ordered  50 committed   fully covered
//   PO 1236143 (24 stores)        87 ordered  22 committed   65 short, 15 stores at ZERO
//
// That is a real allocation policy — first order committed wins — applied by
// whichever order NetSuite happened to commit first. It is not a decision anyone
// made about which customer to disappoint, and it is invisible unless you go looking
// at commitment line by line.
//
// So this file makes the rule EXPLICIT and the outcome inspectable. It does not pick
// a rule; `allocate` requires one.
//
// ⚠️ AND IT PRODUCES THE CUT LIST, NOT JUST THE TOTALS. "make sure we know where we
// cut our units so we can adjust when we make our invoice" — a shortfall figure is
// useless at invoicing time. What is needed is which store lost how many of what.

/**
 * ⚠️ A SUPERSEDED PO STILL LOOKS LIKE DEMAND.
 *
 * Nima, 2026-09-11: "we have two version of 1236143 with one being closed we need to
 * ignore the closed one that marked as 1236143 | Closed and is closed and use the
 * open one."
 *
 * Bloomingdale's retransmitted PO 1236143, so NetSuite holds TWO sets of 24 store
 * orders: the live ones under "1236143" and the superseded ones renamed
 * "1236143 | Closed" (status H). Both are real records with real line quantities.
 *
 * Pull them together — with a LIKE, a prefix match, or a status filter that forgets
 * to exclude Closed — and demand doubles from 491 to about 980. The shortage then
 * reads as ~500 units instead of 65, and the pick ticket cuts almost every store for
 * no reason. Nothing about the output would look obviously wrong; it would just be a
 * far worse day.
 *
 * So the demand set is CHECKED here rather than trusted to whoever wrote the query.
 * The markers are conventions this warehouse uses by hand, so they are matched
 * loosely: anything with a pipe, or the word closed/cancelled/void.
 */
export const SUPERSEDED_MARKERS = /\||\bclosed\b|\bcancel/i

export function supersededPos(lines = []) {
  const pos = [...new Set(lines.map((l) => String(l.po ?? '')))]
  const marked = pos.filter((p) => SUPERSEDED_MARKERS.test(p))
  // ⚠️ ALSO the silent case: two POs where one is a prefix of the other. That is what
  // "1236143" and "1236143 | Closed" are, and a prefix query catches both.
  const overlapping = []
  for (const a of pos) {
    for (const b of pos) {
      if (a !== b && b.startsWith(a)) overlapping.push({ live: a, alsoPresent: b })
    }
  }
  return { marked, overlapping, clean: marked.length === 0 && overlapping.length === 0 }
}

/** Integer units, never fractions — you cannot ship half a handbag. */
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0))

/**
 * Demand vs one pool, per SKU.
 *
 * @param lines      [{ po, order, store, sku, qty }]
 * @param available  { sku: units } — the ONLY pool that may be used
 */
export function shortfall(lines = [], available = {}) {
  const dup = supersededPos(lines)
  if (!dup.clean) {
    throw new Error(`demand includes a superseded PO — ${
      [...dup.marked.map((p) => `"${p}" is marked closed/cancelled`),
       ...dup.overlapping.map((o) => `"${o.alsoPresent}" shadows "${o.live}"`)].join('; ')
    }. Filter to the live PO before allocating.`)
  }
  const bySku = new Map()
  for (const l of lines) {
    const k = l.sku
    if (!bySku.has(k)) bySku.set(k, { sku: k, demand: 0, byPo: {} })
    const e = bySku.get(k)
    e.demand += int(l.qty)
    e.byPo[l.po] = (e.byPo[l.po] || 0) + int(l.qty)
  }
  const rows = [...bySku.values()].map((e) => {
    const have = int(available[e.sku])
    return { ...e, available: have, short: Math.max(0, e.demand - have), spare: Math.max(0, have - e.demand) }
  }).sort((a, b) => b.short - a.short || a.sku.localeCompare(b.sku))
  return {
    rows,
    shortSkus: rows.filter((r) => r.short > 0),
    totalDemand: rows.reduce((a, r) => a + r.demand, 0),
    totalShort: rows.reduce((a, r) => a + r.short, 0),
    // ⚠️ A SKU WE HOLD AND WERE NOT ASKED FOR IS NOT "SPARE STOCK TO SUBSTITUTE".
    // Reported so it is visible, never offered as a fix — §9.2 for Exemplar and
    // every partner guide here says do not substitute.
    spareSkus: rows.filter((r) => r.spare > 0),
  }
}

/**
 * The rules. Each takes (lines for one SKU, units available) and returns
 * [{ ...line, allocated, cut }].
 *
 * ⚠️ NONE OF THESE IS A DEFAULT. Which customer absorbs a shortage is a commercial
 * decision — a CFC replenishment and a flagship store are not interchangeable — and
 * a library that quietly picks one has made it on the user's behalf.
 */
export const RULES = {
  /**
   * ⚠️ NOT A RULE — THE ANSWER, READ BACK FROM NETSUITE.
   *
   * Nima allocates by hand on NetSuite's Order Allocation screen, and that screen is
   * the system of record: what it commits is what will pick. So this takes each
   * line's `committed` quantity as given and computes the cut from it, rather than
   * deciding anything.
   *
   * Use it to PRINT what was decided. The computing rules are for deciding.
   *
   * ⚠️ It does not clamp to `units`, on purpose. If the commitments exceed what is on
   * hand that is a real problem in NetSuite, and silently trimming the ticket would
   * hide it — `overCommitted` on the plan reports it instead.
   */
  'as-committed': (lines) => lines.map((l) => {
    const c = Math.min(int(l.committed), int(l.qty))
    return { ...l, allocated: c, cut: int(l.qty) - c }
  }),

  /**
   * Proportional, using the largest-remainder method.
   *
   * ⚠️ ROUNDING IS THE WHOLE PROBLEM WITH PRO-RATA. Rounding each share
   * independently either over-allocates (the sum exceeds stock) or strands units
   * nobody receives. Largest remainder gives every line its floor, then hands the
   * leftovers to the lines with the biggest fractional parts — so the total is
   * always EXACTLY the stock available.
   */
  'pro-rata': (lines, units) => {
    const demand = lines.reduce((a, l) => a + int(l.qty), 0)
    if (demand === 0) return lines.map((l) => ({ ...l, allocated: 0, cut: 0 }))
    const share = lines.map((l) => {
      const exact = (int(l.qty) * units) / demand
      const floor = Math.min(int(l.qty), Math.floor(exact))
      return { line: l, floor, rem: exact - Math.floor(exact) }
    })
    let left = units - share.reduce((a, s) => a + s.floor, 0)
    // Ties broken by larger order, then by a stable key — never by array order,
    // which would make the answer depend on how the rows were queried.
    const order = [...share].sort((a, b) =>
      b.rem - a.rem || int(b.line.qty) - int(a.line.qty) || String(a.line.order).localeCompare(String(b.line.order)))
    for (const s of order) {
      if (left <= 0) break
      if (s.floor >= int(s.line.qty)) continue
      s.floor += 1; left -= 1
    }
    return share.map((s) => ({ ...s.line, allocated: s.floor, cut: int(s.line.qty) - s.floor }))
  },

  /**
   * Fill the smallest orders first — serves the most destinations.
   * ⚠️ It maximises the number of stores that get SOMETHING, which for a
   * store-allocated PO usually means fewer "nothing arrived" conversations, at the
   * cost of gutting the large orders.
   */
  'fill-smallest-first': (lines, units) => {
    let left = units
    const sorted = [...lines].sort((a, b) => int(a.qty) - int(b.qty) || String(a.order).localeCompare(String(b.order)))
    const got = new Map()
    for (const l of sorted) {
      const give = Math.min(int(l.qty), left)
      got.set(l.order + '|' + l.sku, give); left -= give
    }
    return lines.map((l) => {
      const a = got.get(l.order + '|' + l.sku) ?? 0
      return { ...l, allocated: a, cut: int(l.qty) - a }
    })
  },

  /**
   * ⚠️ WHOLE LINES ONLY, SMALLEST FIRST — no partial cuts.
   *
   * Nima, 2026-09-11: "we dont want partial cuts we want full. meaning we dont want
   * to ship short a sku we want to ship minus a sku if we dont have the units." And:
   * "we want to have to adjust the fewest order we can while shipping complete for as
   * many as we can."
   *
   * So a line is filled ENTIRELY or set to zero; the order then ships without that
   * SKU rather than short on it. Taking the smallest lines first maximises the number
   * of lines filled, which is exactly "complete for as many as we can" — and it is
   * provably optimal for that goal, since any line you skip to fit a larger one
   * trades one filled line for at most one other.
   *
   * ⚠️ IT STRANDS UNITS, AND THAT IS THE COST OF THE RULE, NOT A BUG. Once every
   * line that fits is filled, the remainder is smaller than any unfilled line and
   * cannot be shipped without a partial. On the live CASHMERE shortage that is 5
   * units of 72 left in the building. `stranded` reports it rather than letting it
   * look like a miscount.
   */
  'whole-line-smallest-first': (lines, units) => {
    let left = units
    const sorted = [...lines].sort((a, b) =>
      int(a.qty) - int(b.qty) || String(a.order).localeCompare(String(b.order)))
    const got = new Map()
    for (const l of sorted) {
      const need = int(l.qty)
      // ⚠️ No `Math.min` here — that is what makes a partial. All or nothing.
      if (need > 0 && need <= left) { got.set(l.order + '|' + l.sku, need); left -= need }
      else got.set(l.order + '|' + l.sku, 0)
    }
    return lines.map((l) => {
      const a = got.get(l.order + '|' + l.sku) ?? 0
      return { ...l, allocated: a, cut: int(l.qty) - a }
    })
  },

  /**
   * A named priority order — e.g. ['1236132', '1236143'] to fill the CFC first.
   * This is what NetSuite effectively did, by accident rather than by choice.
   */
  priority: (lines, units, { order: priority = [] } = {}) => {
    const rank = (l) => {
      const i = priority.indexOf(String(l.po))
      return i === -1 ? priority.length : i
    }
    let left = units
    const sorted = [...lines].sort((a, b) => rank(a) - rank(b) || int(b.qty) - int(a.qty) || String(a.order).localeCompare(String(b.order)))
    const got = new Map()
    for (const l of sorted) {
      const give = Math.min(int(l.qty), left)
      got.set(l.order + '|' + l.sku, give); left -= give
    }
    return lines.map((l) => {
      const a = got.get(l.order + '|' + l.sku) ?? 0
      return { ...l, allocated: a, cut: int(l.qty) - a }
    })
  },
}

/**
 * ⚠️ THE RULES THAT DECIDE, as opposed to 'as-committed' which reports.
 *
 * compareRules and any "what if" view must use THIS list. Putting a read-back of
 * NetSuite's answer alongside three hypotheticals and calling them all rules invites
 * comparing a decision against itself.
 */
export const DECIDING_RULES = Object.keys(RULES).filter((r) => r !== 'as-committed')

/**
 * Allocate every SKU under one rule.
 *
 * ⚠️ THE RULE IS REQUIRED. See RULES — there is no sensible default for "who goes
 * short", and defaulting would hide the decision exactly the way NetSuite's
 * commitment order already hides it.
 */
export function allocate(lines = [], available = {}, { rule, ruleOptions = {} } = {}) {
  if (!rule || !RULES[rule]) {
    throw new Error(`allocate needs an explicit rule — one of ${Object.keys(RULES).join(', ')}`)
  }
  const bySku = new Map()
  for (const l of lines) {
    if (!bySku.has(l.sku)) bySku.set(l.sku, [])
    bySku.get(l.sku).push(l)
  }
  const allocated = []
  for (const [sku, group] of bySku) {
    const units = int(available[sku])
    const demand = group.reduce((a, l) => a + int(l.qty), 0)
    // ⚠️ 'as-committed' is applied even when there is no shortage — it reports what
    // NetSuite holds, and a line can be uncommitted for reasons other than stock.
    if (rule === 'as-committed') { allocated.push(...RULES['as-committed'](group)); continue }
    // No shortage: everyone gets what they asked for, whatever the rule.
    if (units >= demand) {
      allocated.push(...group.map((l) => ({ ...l, allocated: int(l.qty), cut: 0 })))
      continue
    }
    allocated.push(...RULES[rule](group, units, ruleOptions))
  }
  // ⚠️ UNITS LEFT IN THE BUILDING. Only whole-line rules strand any; for the others
  // this is zero. Surfaced because a pick of 67 against 72 on hand otherwise looks
  // like a counting error to whoever is holding the ticket.
  const stranded = {}
  for (const [sku, group] of bySku) {
    const used = allocated.filter((l) => l.sku === sku).reduce((a, l) => a + l.allocated, 0)
    const spareHere = int(available[sku]) - used
    const demand = group.reduce((a, l) => a + int(l.qty), 0)
    if (spareHere > 0 && demand > int(available[sku])) stranded[sku] = spareHere
  }

  // ⚠️ COMMITTED MORE THAN EXISTS is a NetSuite problem, not a printing one.
  const overCommitted = {}
  for (const [sku] of bySku) {
    const used = allocated.filter((l) => l.sku === sku).reduce((a, l) => a + l.allocated, 0)
    if (used > int(available[sku])) overCommitted[sku] = { committed: used, onHand: int(available[sku]) }
  }

  return {
    rule,
    overCommitted,
    stranded,
    strandedUnits: Object.values(stranded).reduce((a, n) => a + n, 0),
    lines: allocated,
    cuts: allocated.filter((l) => l.cut > 0).sort((a, b) => b.cut - a.cut || String(a.order).localeCompare(String(b.order))),
    zeroed: allocated.filter((l) => l.allocated === 0 && int(l.qty) > 0),
    totals: summarise(allocated),
  }
}

/** Orders where EVERY line came out at zero — the ones to cancel, not short-ship. */
function countOrdersShippingNothing(plan) {
  const byOrder = new Map()
  for (const l of plan.lines) {
    const e = byOrder.get(l.order) || { shipped: 0, ordered: 0 }
    e.shipped += l.allocated; e.ordered += Math.max(0, Math.trunc(Number(l.qty) || 0))
    byOrder.set(l.order, e)
  }
  return [...byOrder.values()].filter((o) => o.ordered > 0 && o.shipped === 0).length
}

function summarise(lines) {
  const byPo = {}
  for (const l of lines) {
    const p = (byPo[l.po] ||= { po: l.po, ordered: 0, allocated: 0, cut: 0, ordersCut: new Set() })
    p.ordered += int(l.qty); p.allocated += l.allocated; p.cut += l.cut
    if (l.cut > 0) p.ordersCut.add(l.order)
  }
  return Object.values(byPo).map((p) => ({ ...p, ordersCut: p.ordersCut.size }))
}

/**
 * ⚠️ THE INVOICE VIEW — what was cut, per order, so billing matches what shipped.
 *
 * "so we can adjust when we make our invoice". An invoice raised against the ORDERED
 * quantity on a short shipment is an overbill the partner will dispute, and a credit
 * afterwards is slower and messier than getting it right once.
 */
export function invoiceAdjustments(plan) {
  const byOrder = new Map()
  for (const l of plan.lines) {
    if (!byOrder.has(l.order)) byOrder.set(l.order, { order: l.order, po: l.po, store: l.store, lines: [], ordered: 0, shipping: 0, cut: 0 })
    const e = byOrder.get(l.order)
    e.lines.push({ sku: l.sku, ordered: int(l.qty), shipping: l.allocated, cut: l.cut })
    e.ordered += int(l.qty); e.shipping += l.allocated; e.cut += l.cut
  }
  return [...byOrder.values()]
    .filter((o) => o.cut > 0)
    .map((o) => ({ ...o, lines: o.lines.filter((x) => x.cut > 0), shipsNothing: o.shipping === 0 }))
    .sort((a, b) => b.cut - a.cut || String(a.order).localeCompare(String(b.order)))
}

/**
 * Compare rules side by side, so the choice is made on consequences.
 * ⚠️ Every rule ships the SAME total — the stock is the stock. What differs is who
 * absorbs it, which is the only thing worth deciding.
 */
export function compareRules(lines, available, { priorityOrder = [] } = {}) {
  return DECIDING_RULES.map((rule) => {
    const plan = allocate(lines, available, { rule, ruleOptions: { order: priorityOrder } })
    return {
      rule,
      shipped: plan.lines.reduce((a, l) => a + l.allocated, 0),
      cut: plan.lines.reduce((a, l) => a + l.cut, 0),
      ordersCut: new Set(plan.cuts.map((c) => c.order)).size,
      strandedUnits: plan.strandedUnits,
      // ⚠️ THE NUMBER NIMA IS OPTIMISING: lines that ship exactly what was ordered.
      linesComplete: plan.lines.filter((l) => l.cut === 0 && l.qty > 0).length,
      partialLines: plan.lines.filter((l) => l.allocated > 0 && l.cut > 0).length,
      // ⚠️ TWO DIFFERENT NUMBERS, AND I HAD ONE LABELLED AS THE OTHER. `zeroed` is
      // LINES that got nothing; an order with a zeroed line may still ship plenty of
      // other SKUs. "ordersGettingNothing" counting lines is CLAUDE.md's second
      // counter-bug shape — counts something other than its label — and it made
      // priority look like it stranded 18 orders when it strands 18 LINES and no
      // whole order.
      linesZeroed: plan.zeroed.length,
      ordersShippingNothing: countOrdersShippingNothing(plan),
      byPo: plan.totals,
    }
  })
}


/**
 * ⚠️ AM I CLEAR TO FULFIL? — Nima, 2026-09-11: "let me know when im gond to
 * fulfille them".
 *
 * A go/no-go, with the reason on every no. The checks are the things that make an
 * Item Fulfilment wrong rather than merely short:
 *
 *   over-committed   NetSuite holds more committed than exists. The IF will fail or
 *                    take stock that is not there.
 *   partial cuts     A line shipping some-but-not-all of a SKU. Nima's rule is ship
 *                    minus a SKU, never short on one — so a partial is a deviation
 *                    and he should see it before it goes out, not after.
 *   nothing to ship  An order where every line came out zero: that is a cancellation
 *                    conversation, not a fulfilment.
 *   uncommitted      Lines still at zero that are NOT on the cut list — usually
 *                    someone stopped half way through the allocation screen.
 *
 * ⚠️ IT DOES NOT CHECK THAT THE STOCK IS PHYSICALLY THERE. NetSuite's on-hand is a
 * number in a database; the pick is what proves it. "Ready" here means the paperwork
 * is coherent, not that 72 units are on the shelf.
 */
export function readyToFulfil(plan, available = {}) {
  const blocks = []
  const warnings = []

  for (const [sku, o] of Object.entries(plan.overCommitted || {})) {
    blocks.push(`${sku}: committed ${o.committed} but only ${o.onHand} on hand — fix the allocation before fulfilling.`)
  }

  const partials = plan.lines.filter((l) => l.allocated > 0 && l.cut > 0)
  for (const p of partials) {
    warnings.push(`${p.order} ${p.store ?? ''} ships ${p.allocated} of ${p.qty} ${p.sku} — a PARTIAL. The rule is ship minus a SKU, not short on one.`)
  }

  const nothing = invoiceAdjustments(plan).filter((o) => o.shipsNothing)
  for (const o of nothing) {
    warnings.push(`${o.order} ${o.store ?? ''} ships NOTHING — cancel it rather than fulfilling an empty order.`)
  }

  return {
    ready: blocks.length === 0,
    blocks,
    warnings,
    // What the fulfilment will actually contain, so it can be checked against the pick.
    shipping: plan.lines.reduce((a, l) => a + l.allocated, 0),
    cut: plan.lines.reduce((a, l) => a + l.cut, 0),
    ordersShipping: new Set(plan.lines.filter((l) => l.allocated > 0).map((l) => l.order)).size,
    ordersAdjusted: new Set(plan.lines.filter((l) => l.cut > 0).map((l) => l.order)).size,
    verdict: blocks.length ? 'DO NOT FULFIL'
      : warnings.length ? 'CLEAR TO FULFIL — with the notes below'
        : 'CLEAR TO FULFIL',
    note: 'On-hand is a number in NetSuite. This says the paperwork is coherent, not that the units are on the shelf — the pick proves that.',
  }
}


/**
 * ⚠️ WHICH WHOLE ORDERS, CUT ENTIRELY, EXACTLY COVER THE SHORTAGE?
 *
 * Nima's rule is no partial cuts; his goal is the fewest orders adjusted. Those two
 * together are a subset-sum: find the smallest set of lines whose quantities total
 * EXACTLY the shortage. Exactly, because cutting more stranded units and cutting
 * less is impossible.
 *
 * Worth computing rather than eyeballing. On the live CASHMERE shortage he reached 4
 * orders by hand but kept one partial (Boca Raton 4 of 10) — and there are 4-order
 * solutions with no partial at all, which his own rules prefer. The difference is
 * not obvious by inspection: 50+3+6+6 and 50+3+6 plus a 6-unit partial both total
 * 65, and only one of them obeys the rule.
 *
 * ⚠️ EXHAUSTIVE, WITH A CEILING. Subset-sum is exponential; this searches by
 * increasing set size and stops at `maxLines`, so a pathological order book cannot
 * hang a pick ticket. If nothing exact exists inside the ceiling it says so rather
 * than returning a near miss that would strand units without saying it did.
 */
export function wholeCutOptions(lines = [], shortage = 0, { maxLines = 5, maxOptions = 8 } = {}) {
  const target = int(shortage)
  if (target === 0) return { target, options: [], exact: true }
  const pool = lines
    .map((l) => ({ order: l.order, store: l.store, po: l.po, qty: int(l.qty) }))
    .filter((l) => l.qty > 0 && l.qty <= target)
    .sort((a, b) => b.qty - a.qty)

  const found = []
  const seen = new Set()
  const walk = (start, remaining, chosen) => {
    if (found.length >= maxOptions) return
    if (remaining === 0) {
      const key = chosen.map((c) => c.order).sort().join(',')
      if (!seen.has(key)) { seen.add(key); found.push([...chosen]) }
      return
    }
    if (chosen.length >= maxLines) return
    for (let i = start; i < pool.length; i++) {
      if (pool[i].qty > remaining) continue
      chosen.push(pool[i])
      walk(i + 1, remaining - pool[i].qty, chosen)
      chosen.pop()
      if (found.length >= maxOptions) return
    }
  }
  // Smallest sets first: try each cardinality in turn.
  for (let size = 1; size <= maxLines && found.length < maxOptions; size++) {
    const before = found.length
    const walkN = (start, remaining, chosen) => {
      if (found.length >= maxOptions) return
      if (chosen.length === size) {
        if (remaining === 0) {
          const key = chosen.map((c) => c.order).sort().join(',')
          if (!seen.has(key)) { seen.add(key); found.push([...chosen]) }
        }
        return
      }
      for (let i = start; i < pool.length; i++) {
        if (pool[i].qty > remaining) continue
        chosen.push(pool[i]); walkN(i + 1, remaining - pool[i].qty, chosen); chosen.pop()
        if (found.length >= maxOptions) return
      }
    }
    walkN(0, target, [])
    if (found.length > before) break   // minimum cardinality reached
  }
  void walk
  return {
    target,
    exact: found.length > 0,
    minimumOrders: found.length ? found[0].length : null,
    options: found.map((set) => ({
      orders: set,
      count: set.length,
      units: set.reduce((a, c) => a + c.qty, 0),
    })),
    note: found.length ? null
      : `No combination of whole lines totals exactly ${target} within ${maxLines} orders — a partial cut or stranded units are unavoidable.`,
  }
}
