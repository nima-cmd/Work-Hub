// test/allocationPlan.test.js — built on the live Bloomingdale's shortage,
// POs 1236143 + 1236132, read from NetSuite 2026-09-11.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shortfall, allocate, invoiceAdjustments, compareRules, RULES, supersededPos, DECIDING_RULES,
} from '../src/model/allocationPlan.js'

// The one contended SKU: 137 wanted, 72 in the Bloomingdale's location.
const CASHMERE = [
  { po: '1236132', order: 'SO12577', store: '0231-CFC', sku: 'SN03012LD-CASHMERE', qty: 50 },
  { po: '1236143', order: 'SO12597', store: '0003', sku: 'SN03012LD-CASHMERE', qty: 10 },
  { po: '1236143', order: 'SO12601', store: '0002', sku: 'SN03012LD-CASHMERE', qty: 10 },
  { po: '1236143', order: 'SO12604', store: '0001', sku: 'SN03012LD-CASHMERE', qty: 10 },
  { po: '1236143', order: 'SO12588', store: '0058', sku: 'SN03012LD-CASHMERE', qty: 6 },
  { po: '1236143', order: 'SO12591', store: '0012', sku: 'SN03012LD-CASHMERE', qty: 6 },
  { po: '1236143', order: 'SO12592', store: '0005', sku: 'SN03012LD-CASHMERE', qty: 6 },
  { po: '1236143', order: 'SO12593', store: '0004', sku: 'SN03012LD-CASHMERE', qty: 6 },
  { po: '1236143', order: 'SO12585', store: '0017', sku: 'SN03012LD-CASHMERE', qty: 1 },
  { po: '1236143', order: 'SO12587', store: '0016', sku: 'SN03012LD-CASHMERE', qty: 1 },
  { po: '1236143', order: 'SO12598', store: '0061', sku: 'SN03012LD-CASHMERE', qty: 1 },
]
const AVAIL = { 'SN03012LD-CASHMERE': 72 }

test('⚠️ ONE SKU IS SHORT, AND THE TOTALS CONCEAL NOTHING HERE', () => {
  const s = shortfall(CASHMERE, AVAIL)
  assert.equal(s.totalDemand, 107)
  assert.equal(s.shortSkus.length, 1)
  const row = s.shortSkus[0]
  assert.equal(row.demand, 107)
  assert.equal(row.available, 72)
  assert.equal(row.short, 35)
  // The per-PO split is what decides who can be cut.
  assert.equal(row.byPo['1236132'], 50)
  assert.equal(row.byPo['1236143'], 57)
})

test('⚠️ A RULE IS REQUIRED — there is no sensible default for who goes short', () => {
  // NetSuite already picked one by accident: first order committed wins, which on
  // the live data gave the CFC all 50 and left 15 stores at zero. Defaulting here
  // would hide the decision the same way.
  assert.throws(() => allocate(CASHMERE, AVAIL), /needs an explicit rule/)
  assert.throws(() => allocate(CASHMERE, AVAIL, { rule: 'whatever' }), /needs an explicit rule/)
})

test('⚠️ NO RULE INVENTS OR LOSES UNITS — but only some ship every one', () => {
  // This asserted "every rule ships exactly the stock" until whole-line-smallest-first
  // existed. That rule legitimately strands units — once every line that FITS is
  // filled, the remainder is smaller than any unfilled line — so the invariant is
  // narrower than it was: shipped + stranded == stock, and shipped + cut == demand.
  // ⚠️ DECIDING_RULES, not every key in RULES — 'as-committed' reads NetSuite's
  // answer back and has nothing to decide, so it has no invariant to satisfy here.
  for (const rule of DECIDING_RULES) {
    const p = allocate(CASHMERE, AVAIL, { rule, ruleOptions: { order: ['1236132', '1236143'] } })
    const shipped = p.lines.reduce((a, l) => a + l.allocated, 0)
    const cut = p.lines.reduce((a, l) => a + l.cut, 0)
    assert.equal(shipped + p.strandedUnits, 72, `${rule}: shipped + stranded != stock`)
    assert.equal(shipped + cut, 107, `${rule}: shipped + cut != demand`)
    assert.ok(shipped <= 72, `${rule} shipped more than exists`)
    for (const l of p.lines) {
      assert.ok(Number.isInteger(l.allocated), `${rule}: fractional units`)
      assert.ok(l.allocated <= l.qty, `${rule}: allocated more than ordered`)
      assert.ok(l.allocated >= 0, `${rule}: negative allocation`)
    }
  }
  // Only the whole-line rule strands anything.
  for (const rule of ['pro-rata', 'fill-smallest-first', 'priority']) {
    assert.equal(allocate(CASHMERE, AVAIL, { rule, ruleOptions: { order: [] } }).strandedUnits, 0, rule)
  }
})

test('⚠️ THE RULES DISAGREE ABOUT WHO IS DISAPPOINTED, WHICH IS THE POINT', () => {
  const priority = allocate(CASHMERE, AVAIL, { rule: 'priority', ruleOptions: { order: ['1236132', '1236143'] } })
  const cfc = priority.lines.find((l) => l.order === 'SO12577')
  assert.equal(cfc.allocated, 50, 'priority fills the CFC completely')
  assert.ok(priority.zeroed.length > 0, 'and leaves stores with nothing')

  const smallest = allocate(CASHMERE, AVAIL, { rule: 'fill-smallest-first' })
  const cfcSmall = smallest.lines.find((l) => l.order === 'SO12577')
  assert.ok(cfcSmall.cut > 0, 'fill-smallest-first makes the big CFC line absorb the shortage')
  assert.equal(smallest.zeroed.length, 0, 'and every store gets something')

  const pro = allocate(CASHMERE, AVAIL, { rule: 'pro-rata' })
  const cfcPro = pro.lines.find((l) => l.order === 'SO12577')
  assert.ok(cfcPro.cut > 0 && cfcPro.cut < 50, 'pro-rata shares the pain')
})

test('⚠️ PRO-RATA IS DETERMINISTIC — not dependent on row order', () => {
  // Ties are broken by size then by a stable key. If the answer moved when the query
  // returned rows differently, two people would compute two different pick tickets.
  const a = allocate(CASHMERE, AVAIL, { rule: 'pro-rata' })
  const b = allocate([...CASHMERE].reverse(), AVAIL, { rule: 'pro-rata' })
  const key = (p) => p.lines.map((l) => `${l.order}:${l.allocated}`).sort().join(',')
  assert.equal(key(a), key(b))
})

test('no shortage means everyone is filled, whatever the rule', () => {
  const plenty = { 'SN03012LD-CASHMERE': 500 }
  for (const rule of DECIDING_RULES) {
    const p = allocate(CASHMERE, plenty, { rule, ruleOptions: { order: [] } })
    assert.equal(p.cuts.length, 0, rule)
    assert.equal(p.lines.every((l) => l.allocated === l.qty), true, rule)
  }
})

test('⚠️ THE INVOICE VIEW IS PER ORDER, because that is what gets billed', () => {
  // "make sure we know where we cut our units so we can adjust when we make our
  // invoice". A shortfall total is useless at invoicing time; an invoice raised on
  // the ORDERED quantity is an overbill the partner disputes.
  const plan = allocate(CASHMERE, AVAIL, { rule: 'pro-rata' })
  const adj = invoiceAdjustments(plan)
  assert.ok(adj.length > 0)
  for (const o of adj) {
    assert.ok(o.cut > 0, 'only orders that were cut appear')
    assert.equal(o.shipping + o.cut, o.ordered, `${o.order} does not reconcile`)
    assert.ok(o.lines.every((l) => l.cut > 0), 'and only the cut lines within them')
  }
  // Orders shipping nothing are flagged — they may need cancelling, not invoicing.
  const zero = invoiceAdjustments(allocate(CASHMERE, AVAIL, { rule: 'priority', ruleOptions: { order: ['1236132'] } }))
  assert.ok(zero.some((o) => o.shipsNothing))
})

test('⚠️ SPARE STOCK IS REPORTED BUT NEVER OFFERED AS A SUBSTITUTE', () => {
  // The real case: SN03013LD-ONYX is wanted 27 and 58 are on hand, so 31 sit spare
  // while CASHMERE is 35 short. Surplus in one colour does not help a shortage in
  // another, and every partner guide here says do not substitute.
  //
  // ⚠️ `spare` only covers SKUs that ARE on an order. Stock held for a SKU nobody
  // asked for is an inventory question, not an allocation one, and folding it in
  // would make this report look like a pick list for things not being shipped.
  const withOnyx = [
    ...CASHMERE,
    { po: '1236132', order: 'SO12577', store: '0231-CFC', sku: 'SN03013LD-ONYX', qty: 15 },
    { po: '1236143', order: 'SO12588', store: '0058', sku: 'SN03013LD-ONYX', qty: 6 },
    { po: '1236143', order: 'SO12592', store: '0005', sku: 'SN03013LD-ONYX', qty: 6 },
  ]
  const s = shortfall(withOnyx, { ...AVAIL, 'SN03013LD-ONYX': 58 })
  assert.equal(s.spareSkus.length, 1)
  assert.equal(s.spareSkus[0].sku, 'SN03013LD-ONYX')
  assert.equal(s.spareSkus[0].spare, 31)
  assert.equal(s.totalShort, 35, 'spare in one colour does not reduce the shortage in another')
})

test('compareRules ships the same total every way — only the victims change', () => {
  const c = compareRules(CASHMERE, AVAIL, { priorityOrder: ['1236132', '1236143'] })
  // ⚠️ The partial-permitting rules all ship the same total — the stock is the stock.
  // whole-line-smallest-first ships LESS, on purpose, because refusing partials
  // leaves a remainder too small for any unfilled line. That is the trade Nima chose.
  const partialOk = c.filter((x) => x.rule !== 'whole-line-smallest-first')
  assert.equal(new Set(partialOk.map((x) => x.shipped)).size, 1, 'the stock is the stock')
  const whole = c.find((x) => x.rule === 'whole-line-smallest-first')
  assert.ok(whole.shipped < partialOk[0].shipped)
  assert.ok(whole.strandedUnits > 0)
  assert.equal(whole.partialLines, 0)
  assert.ok(new Set(c.map((x) => x.linesZeroed)).size > 1, 'who gets nothing differs')
  // ⚠️ A ZEROED LINE IS NOT A ZEROED ORDER. An order can lose one SKU entirely and
  // still ship six others. Reporting lines under an "orders" label overstated the
  // damage of the priority rule by 18 to 0.
  for (const x of c) assert.ok(x.ordersShippingNothing <= x.linesZeroed)
})

test('⚠️ AN ORDER SHIPPING NOTHING IS COUNTED SEPARATELY FROM A ZEROED LINE', () => {
  const oneSku = [
    { po: 'A', order: 'S1', store: 'x', sku: 'K', qty: 10 },
    { po: 'B', order: 'S2', store: 'y', sku: 'K', qty: 10 },
  ]
  const p = allocate(oneSku, { K: 10 }, { rule: 'priority', ruleOptions: { order: ['A', 'B'] } })
  const c = compareRules(oneSku, { K: 10 }, { priorityOrder: ['A', 'B'] }).find((x) => x.rule === 'priority')
  assert.equal(p.zeroed.length, 1)
  assert.equal(c.ordersShippingNothing, 1, 'here the line IS the whole order')
})

test('⚠️ WHOLE-LINE MEANS NO PARTIAL CUTS, EVER', () => {
  // Nima: "we dont want partial cuts we want full. meaning we dont want to ship
  // short a sku we want to ship minus a sku if we dont have the units." A line is
  // filled entirely or zeroed; the order ships WITHOUT that SKU rather than short
  // on it. The absence of a Math.min in that rule is the whole implementation.
  const p = allocate(CASHMERE, AVAIL, { rule: 'whole-line-smallest-first' })
  for (const l of p.lines) {
    assert.ok(l.allocated === 0 || l.allocated === l.qty,
      `${l.order} got a partial: ${l.allocated} of ${l.qty}`)
  }
  assert.equal(p.lines.filter((l) => l.allocated > 0 && l.cut > 0).length, 0)
})

test('⚠️ IT STRANDS UNITS, AND THAT IS THE PRICE OF THE RULE', () => {
  // Once every line that fits is filled, the remainder is smaller than any unfilled
  // line and cannot ship without a partial. Reported, because a pick of 67 against
  // 72 on hand otherwise reads as a counting error to whoever holds the ticket.
  const p = allocate(CASHMERE, AVAIL, { rule: 'whole-line-smallest-first' })
  const shipped = p.lines.reduce((a, l) => a + l.allocated, 0)
  assert.ok(shipped < 72, 'some stock cannot be used without a partial')
  assert.equal(p.stranded['SN03012LD-CASHMERE'], 72 - shipped)
  assert.equal(p.strandedUnits, 72 - shipped)
  // Rules that permit partials strand nothing.
  assert.equal(allocate(CASHMERE, AVAIL, { rule: 'pro-rata' }).strandedUnits, 0)
})

test('⚠️ SMALLEST-FIRST MAXIMISES COMPLETE LINES — the stated goal', () => {
  // "we want to have to adjust the fewest order we can while shipping complete for
  // as many as we can." Filling small lines first is optimal for that: skipping one
  // to fit a larger line trades one filled line for at most one other.
  const whole = allocate(CASHMERE, AVAIL, { rule: 'whole-line-smallest-first' })
  const complete = whole.lines.filter((l) => l.cut === 0).length
  // No alternative whole-line selection fills more lines than smallest-first.
  const sizes = CASHMERE.map((l) => l.qty).sort((a, b) => a - b)
  let n = 0, left = 72
  for (const q of sizes) { if (q <= left) { left -= q; n++ } }
  assert.equal(complete, n)
  // And the big lines are the ones dropped.
  assert.equal(whole.lines.find((l) => l.order === 'SO12577').allocated, 0, 'the 50-unit CFC line')
})

test('the whole-line rule still never over-allocates or goes negative', () => {
  const p = allocate(CASHMERE, AVAIL, { rule: 'whole-line-smallest-first' })
  assert.ok(p.lines.reduce((a, l) => a + l.allocated, 0) <= 72)
  for (const l of p.lines) assert.ok(l.allocated >= 0 && l.allocated <= l.qty)
})

test('an order cut on one SKU still ships its others', () => {
  // "ship minus a sku" — the order goes out, just without that line.
  const mixed = [
    { po: 'P', order: 'S1', store: 'a', sku: 'SHORT', qty: 50 },
    { po: 'P', order: 'S1', store: 'a', sku: 'PLENTY', qty: 5 },
    { po: 'P', order: 'S2', store: 'b', sku: 'SHORT', qty: 5 },
  ]
  const p = allocate(mixed, { SHORT: 5, PLENTY: 999 }, { rule: 'whole-line-smallest-first' })
  const s1short = p.lines.find((l) => l.order === 'S1' && l.sku === 'SHORT')
  const s1plenty = p.lines.find((l) => l.order === 'S1' && l.sku === 'PLENTY')
  assert.equal(s1short.allocated, 0, 'the contended SKU is dropped whole')
  assert.equal(s1plenty.allocated, 5, 'and the rest of the order still ships')
  assert.equal(invoiceAdjustments(p).find((o) => o.order === 'S1').shipsNothing, false)
})

test('⚠️ A SUPERSEDED PO IN THE DEMAND SET IS REFUSED', () => {
  // Bloomingdale's retransmitted 1236143, so NetSuite holds two sets of 24 store
  // orders: the live "1236143" and the superseded "1236143 | Closed" (status H).
  // Pulled together — by a LIKE, a prefix, or a status filter that forgets H —
  // demand doubles from 491 to ~980, the shortage reads as ~500 instead of 65, and
  // the ticket cuts nearly every store for no reason. Nothing would look wrong.
  const withClosed = [
    ...CASHMERE,
    { po: '1236143 | Closed', order: 'SO12500', store: '0002', sku: 'SN03012LD-CASHMERE', qty: 10 },
  ]
  assert.throws(() => shortfall(withClosed, AVAIL), /marked closed/)
  assert.throws(() => shortfall(withClosed, AVAIL), /Filter to the live PO/)
})

test('⚠️ AND THE SILENT CASE: one PO shadowing another by prefix', () => {
  // "1236143" and "1236143 | Closed" — a prefix query catches both, which is exactly
  // how the wrong set gets pulled without anyone typing the word "closed".
  const shadowed = [
    { po: '1236143', order: 'A', store: 'x', sku: 'K', qty: 5 },
    { po: '1236143-OLD', order: 'B', store: 'y', sku: 'K', qty: 5 },
  ]
  assert.throws(() => shortfall(shadowed, { K: 5 }), /shadows/)
})

test('the real demand set passes the check', () => {
  // 25 orders across exactly two POs, no closed variants.
  const s = supersededPos(CASHMERE)
  assert.equal(s.clean, true)
  assert.deepEqual(s.marked, [])
  assert.deepEqual(s.overlapping, [])
})

test("⚠️ 'as-committed' PRINTS NETSUITE'S DECISION, IT DOES NOT MAKE ONE", () => {
  // Nima allocates by hand on the Order Allocation screen, and that screen is the
  // system of record — what it commits is what will pick. The live commitment on
  // 2026-09-11 for SN03012LD-CASHMERE: CFC 0 of 50, Boca Raton 4 of 10, Orlando 0
  // of 2, Sherman Oaks 0 of 3, Soho 0 of 4; everything else full.
  const lines = [
    { po: '1236132', order: 'SO12577', store: '0231-CFC', sku: 'K', qty: 50, committed: 0 },
    { po: '1236143', order: 'SO12601', store: '0002', sku: 'K', qty: 10, committed: 4 },
    { po: '1236143', order: 'SO12588', store: '0058', sku: 'K', qty: 6, committed: 6 },
  ]
  const p = allocate(lines, { K: 72 }, { rule: 'as-committed' })
  assert.equal(p.lines.find((l) => l.order === 'SO12577').cut, 50)
  assert.equal(p.lines.find((l) => l.order === 'SO12601').allocated, 4)
  assert.equal(p.lines.find((l) => l.order === 'SO12601').cut, 6)
  assert.equal(p.lines.find((l) => l.order === 'SO12588').cut, 0)
})

test('⚠️ AND IT REPORTS A COMMITMENT THAT EXCEEDS STOCK RATHER THAN TRIMMING IT', () => {
  // Silently clamping the ticket to what is on hand would hide a real NetSuite
  // problem behind a tidy-looking piece of paper.
  const lines = [{ po: 'P', order: 'S1', store: 'a', sku: 'K', qty: 100, committed: 100 }]
  const p = allocate(lines, { K: 10 }, { rule: 'as-committed' })
  assert.equal(p.lines[0].allocated, 100)
  assert.deepEqual(p.overCommitted.K, { committed: 100, onHand: 10 })
})

test('as-committed never invents units beyond what was ordered', () => {
  const lines = [{ po: 'P', order: 'S1', store: 'a', sku: 'K', qty: 5, committed: 99 }]
  const p = allocate(lines, { K: 99 }, { rule: 'as-committed' })
  assert.equal(p.lines[0].allocated, 5)
  assert.equal(p.lines[0].cut, 0)
})
