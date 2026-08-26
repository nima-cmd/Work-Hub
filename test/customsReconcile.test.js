// test/customsReconcile.test.js — does the commercial invoice match NetSuite and the box?
import test from 'node:test'
import assert from 'node:assert/strict'
import { styleOf, priceAnomalies, reconcileShipment, reconcileWarnings } from '../src/model/customsReconcile.js'

// SO12300 / IF7594 as measured 2026-08-26 — the shipment that started this.
const SO12300 = [
  { item: 'SN03012LD-BORDEAUX', displayName: 'St. Barths Small Tote | Bordeaux', qty: 1, rate: 102 },
  { item: 'SN03012LD-PACIFIC', displayName: 'St. Barths Small Tote | Pacific', qty: 1, rate: 114 },
  { item: 'SN03012LD-SEYCHELLES', displayName: 'St. Barths Small Tote | Seychelles', qty: 1, rate: 114 },
  { item: 'SN03013LD-BORDEAUX', displayName: 'St. Barths Medium Tote | Bordeaux', qty: 2, rate: 130 },
  { item: 'SN03013LD-ONYX', displayName: 'St. Barths Medium Tote | Onyx', qty: 2, rate: 130 },
]

test('styleOf: the style is the product; the colour is not part of it', () => {
  assert.equal(styleOf('SN03012LD-BORDEAUX'), 'SN03012LD')
  assert.equal(styleOf('SN03013LD-BOTTLE-GREEN'), 'SN03013LD', 'a hyphenated colour still splits at the FIRST hyphen')
  assert.equal(styleOf('SN36223CD'), 'SN36223CD', 'no colour suffix at all')
  assert.equal(styleOf(null), null)
  assert.equal(styleOf(''), null)
})

test('styleOf: one-digit-apart styles are DIFFERENT products', () => {
  // ⚠️ SN03012LD is the Small Tote and SN03013LD the Medium. Any prefix matching here
  // would merge two real products and invent a price anomaly between them.
  assert.notEqual(styleOf('SN03012LD-BORDEAUX'), styleOf('SN03013LD-BORDEAUX'))
})

test('priceAnomalies: catches the real one on SO12300', () => {
  const a = priceAnomalies(SO12300)
  assert.equal(a.length, 1, 'only the Small Tote is split; the Medium is $130 throughout')
  assert.equal(a[0].style, 'SN03012LD')
  assert.equal(a[0].name, 'St. Barths Small Tote')
  assert.equal(a[0].spread, 12)
  // The majority price comes first — the one more likely to be correct.
  assert.deepEqual(a[0].prices.map((p) => [p.price, p.units]), [[114, 2], [102, 1]])
})

test('priceAnomalies: the DISPLAY NAME cannot find it — that is why the style is the key', () => {
  // ⚠️ The name carries the colour, so "…| Bordeaux" and "…| Pacific" are different
  // strings and grouping by name reports nothing. This is the bug the check replaces.
  const byName = new Map()
  for (const l of SO12300) {
    if (!byName.has(l.displayName)) byName.set(l.displayName, new Set())
    byName.get(l.displayName).add(l.rate)
  }
  assert.equal([...byName.values()].filter((s) => s.size > 1).length, 0, 'name-grouping finds nothing')
  assert.equal(priceAnomalies(SO12300).length, 1, 'style-grouping finds it')
})

test('priceAnomalies: one price per style is silent, and zero-qty lines are ignored', () => {
  assert.deepEqual(priceAnomalies([
    { item: 'SN03013LD-ONYX', qty: 2, rate: 130 },
    { item: 'SN03013LD-ROSSO', qty: 2, rate: 130 },
  ]), [])
  assert.deepEqual(priceAnomalies([
    { item: 'SN03013LD-ONYX', qty: 2, rate: 130 },
    { item: 'SN03013LD-ROSSO', qty: 0, rate: 99 },   // cancelled line, not a real price
  ]), [])
})

test('reconcile: IF7594 agrees item for item', () => {
  const shipped = SO12300.map(({ item, qty }) => ({ item, qty }))
  const r = reconcileShipment({ priced: SO12300, shipped })
  assert.equal(r.checked, true)
  assert.equal(r.agrees, true)
  assert.equal(r.pricedUnits, 7)
  assert.equal(r.shippedUnits, 7)
})

test('reconcile: a SWAP keeps the total identical and MUST still be caught', () => {
  // ⚠️ The failure the old total-count check could not see. Same 7 units, different
  // goods — every declared line wrong, and the form names what is not in the box.
  const shipped = SO12300.map(({ item, qty }) => ({ item, qty }))
  shipped[4] = { item: 'SN03013LD-ROSSO', qty: 2 }   // Rosso shipped instead of Onyx
  const r = reconcileShipment({ priced: SO12300, shipped })
  assert.equal(r.pricedUnits, r.shippedUnits, 'the totals agree — which is why a total is not a check')
  assert.equal(r.agrees, false)
  assert.deepEqual(r.notShipped.map((x) => x.item), ['SN03013LD-ONYX'])
  assert.deepEqual(r.notPriced.map((x) => x.item), ['SN03013LD-ROSSO'])
})

test('reconcile: short-ships, over-ships and unpriced extras each name themselves', () => {
  const r = reconcileShipment({
    priced: [{ item: 'A', qty: 5 }, { item: 'B', qty: 2 }],
    shipped: [{ item: 'A', qty: 3 }, { item: 'C', qty: 1 }],
  })
  assert.deepEqual(r.quantityDiffs, [{ item: 'A', priced: 5, shipped: 3 }])
  assert.deepEqual(r.notShipped, [{ item: 'B', qty: 2 }])
  assert.deepEqual(r.notPriced, [{ item: 'C', qty: 1 }])
  assert.equal(r.agrees, false)
})

test('reconcile: an unreadable fulfilment is NOT CHECKED, never "agrees"', () => {
  // ⚠️ Treating an empty read as an empty box would report all 14 items as missing and
  // bury a lookup failure under a pile of confident findings.
  const r = reconcileShipment({ priced: SO12300, shipped: [] })
  assert.equal(r.checked, false)
  assert.equal(r.agrees, false)
  assert.deepEqual(r.notShipped, [], 'it does not manufacture findings out of a failed read')
  assert.equal(r.shippedUnits, 0)
})

test('reconcile: the tripled IF lines roll up, they do not multiply', () => {
  // An IF writes -qty/+qty/-qty; only the POSITIVE InvtPart lines are the shipment.
  // Given those, two rows for one item are summed rather than deduped away — the old
  // item|qty dedup collapsed two genuine lines of equal quantity into one.
  const r = reconcileShipment({
    priced: [{ item: 'A', qty: 4 }],
    shipped: [{ item: 'A', qty: 2 }, { item: 'A', qty: 2 }],
  })
  assert.equal(r.agrees, true)
  assert.equal(r.shippedUnits, 4)
})

test('warnings: read as instructions to a person, and a clean check produces none', () => {
  const clean = reconcileShipment({ priced: SO12300, shipped: SO12300.map(({ item, qty }) => ({ item, qty })) })
  assert.deepEqual(reconcileWarnings(clean, [], { ifNumber: 'IF7594', soNumber: 'SO12300' }), [])

  const w = reconcileWarnings(clean, priceAnomalies(SO12300), { ifNumber: 'IF7594', soNumber: 'SO12300' })
  assert.equal(w.length, 1)
  assert.match(w[0], /St\. Barths Small Tote/)
  assert.match(w[0], /\$114 x2/)
  assert.match(w[0], /\$102 x1/)

  const unread = reconcileShipment({ priced: SO12300, shipped: [] })
  assert.match(reconcileWarnings(unread, [], { ifNumber: 'IF7594' })[0], /NOT been checked/)
})
