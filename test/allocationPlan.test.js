// test/allocationPlan.test.js — built on the live Bloomingdale's shortage,
// POs 1236143 + 1236132, read from NetSuite 2026-09-11.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortfall, allocate, invoiceAdjustments, compareRules, RULES } from '../src/model/allocationPlan.js'

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

test('⚠️ EVERY RULE SHIPS EXACTLY THE STOCK — no fractions, none stranded', () => {
  // Rounding each pro-rata share independently either over-allocates or leaves units
  // nobody receives. Largest remainder gives every line its floor then hands out the
  // leftovers, so the total is always exactly what is on hand.
  for (const rule of Object.keys(RULES)) {
    const p = allocate(CASHMERE, AVAIL, { rule, ruleOptions: { order: ['1236132', '1236143'] } })
    const shipped = p.lines.reduce((a, l) => a + l.allocated, 0)
    assert.equal(shipped, 72, `${rule} shipped ${shipped}`)
    assert.equal(p.lines.reduce((a, l) => a + l.cut, 0), 35, rule)
    for (const l of p.lines) {
      assert.ok(Number.isInteger(l.allocated), `${rule}: fractional units`)
      assert.ok(l.allocated <= l.qty, `${rule}: allocated more than ordered`)
      assert.ok(l.allocated >= 0, `${rule}: negative allocation`)
    }
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
  for (const rule of Object.keys(RULES)) {
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
  assert.equal(new Set(c.map((x) => x.shipped)).size, 1, 'the stock is the stock')
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
