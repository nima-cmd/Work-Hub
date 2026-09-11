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

/** Integer units, never fractions — you cannot ship half a handbag. */
const int = (v) => Math.max(0, Math.trunc(Number(v) || 0))

/**
 * Demand vs one pool, per SKU.
 *
 * @param lines      [{ po, order, store, sku, qty }]
 * @param available  { sku: units } — the ONLY pool that may be used
 */
export function shortfall(lines = [], available = {}) {
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
    // No shortage: everyone gets what they asked for, whatever the rule.
    if (units >= demand) {
      allocated.push(...group.map((l) => ({ ...l, allocated: int(l.qty), cut: 0 })))
      continue
    }
    allocated.push(...RULES[rule](group, units, ruleOptions))
  }
  return {
    rule,
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
  return Object.keys(RULES).map((rule) => {
    const plan = allocate(lines, available, { rule, ruleOptions: { order: priorityOrder } })
    return {
      rule,
      shipped: plan.lines.reduce((a, l) => a + l.allocated, 0),
      cut: plan.lines.reduce((a, l) => a + l.cut, 0),
      ordersCut: new Set(plan.cuts.map((c) => c.order)).size,
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
