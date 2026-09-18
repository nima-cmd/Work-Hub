import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCustomsLines, categoryOf, describeLine, toDhlRows, toUpsRows, toCsv,
  HS_CODES, TAX_ID, DHL_COLUMNS, UPS_COLUMNS,
} from '../src/model/customsInvoice.js'

// Real lines off SO12302 (IF7508, Gee Beauty Canada), pulled live 2026-08-14.
const LIVE = [
  { item: 'SN03012LD-SEYCHELLES', displayName: 'St. Barths Small Tote | Seychelles', qty: 3, rate: 114, coo: 'CN', weight: 1.6 },
  { item: 'SN03012LD-CASHMERE', displayName: 'St. Barths Small Tote | Cashmere', qty: 3, rate: 114, coo: 'CN', weight: 1.6 },
  { item: 'SN03012LD-ONYX', displayName: 'St. Barths Small Tote | Onyx', qty: 3, rate: 114, coo: 'CN', weight: 1.6 },
  { item: 'SN27183LD-CASHMERE', displayName: 'Soho Envelope Crossbody | Cashmere', qty: 2, rate: 114, coo: 'CN', weight: 1 },
  { item: 'SN27183LD-CHOCOLATE', displayName: 'Soho Envelope Crossbody | Chocolate', qty: 2, rate: 114, coo: 'CN', weight: 1 },
  { item: 'SN41263LD-ONYX', displayName: 'Porto Medium Half-Moon Bag | Onyx', qty: 1, rate: 154, coo: 'CN', weight: 1.17 },
]

// ⚠️ NIMA'S RULE, VERBATIM: "if multiple bags have the same price they can be counted
// together ... we cant mix a shoe and bag that have the same price together."
test('bags at the same price become ONE line, across styles and colours', () => {
  const b = buildCustomsLines(LIVE)
  const at114 = b.lines.find((l) => l.unitPrice === 114)
  assert.equal(at114.qty, 13)              // 3+3+3 totes + 2+2 crossbodies
  assert.equal(at114.category, 'bag')
  assert.equal(b.lines.length, 2)          // $114 and $154
})

test('a shoe at the SAME price never joins a bag line', () => {
  const b = buildCustomsLines([
    ...LIVE,
    { item: 'NS03090CB-COSTA', displayName: 'St. Barths Slide Raffia | Costa', qty: 4, rate: 114, coo: 'CN', weight: 1.1 },
  ])
  const at114 = b.lines.filter((l) => l.unitPrice === 114)
  assert.equal(at114.length, 2)
  assert.deepEqual(at114.map((l) => l.category).sort(), ['bag', 'shoe'])
  assert.equal(at114.find((l) => l.category === 'shoe').qty, 4)
})

test('each category carries its own tariff code', () => {
  const b = buildCustomsLines([
    { item: 'SN03012LD-ONYX', displayName: 'Tote', qty: 1, rate: 10, coo: 'CN', weight: 1 },
    { item: 'NS03090CB-COSTA', displayName: 'Slide', qty: 1, rate: 10, coo: 'CN', weight: 1 },
  ])
  assert.equal(b.lines.find((l) => l.category === 'bag').hsCode, HS_CODES.bag)
  assert.equal(b.lines.find((l) => l.category === 'shoe').hsCode, HS_CODES.shoe)
  assert.equal(HS_CODES.bag, '4202221000')
  assert.equal(HS_CODES.shoe, '6404193760')
})

// ⚠️ Category comes from the item-number prefix because NetSuite's `class` is EMPTY on
// all 4,127 items. Measured: NS 2,232 · SN 1,699 · zero crossovers.
test('category comes from the item prefix, and anything else is UNKNOWN', () => {
  assert.equal(categoryOf('SN03012LD-ONYX'), 'bag')
  assert.equal(categoryOf('NS03090CB-COSTA'), 'shoe')
  for (const odd of ['CC1234', 'WN0001', 'ST9', '', null]) assert.equal(categoryOf(odd), 'unknown')
})

// ⚠️ A wrong tariff code is a penalty and a held shipment. An item that is neither a
// bag nor a shoe gets NO code and blocks the form, rather than quietly inheriting one.
test('an unclassified item gets no HS code and stops the document', () => {
  const b = buildCustomsLines([{ item: 'CC0001', displayName: 'Gift Card', qty: 1, rate: 50, coo: 'CN', weight: 0.1 }])
  assert.equal(b.lines[0].hsCode, null)
  assert.equal(b.ready, false)
  assert.match(b.problems[0], /not a bag or a shoe/)
})

test('a clean shipment is ready', () => {
  const b = buildCustomsLines(LIVE)
  assert.equal(b.ready, true)
  assert.deepEqual(b.problems, [])
})

// ⚠️ Weight is PER ITEM on the record, so a line's weight is qty x each. Reading the
// item's own weight onto the line would understate every multi-unit line.
test('line weight is quantity times each, not the item weight', () => {
  const at114 = buildCustomsLines(LIVE).lines.find((l) => l.unitPrice === 114)
  // 14.4 (nine totes at 1.6) + 4 (four crossbodies at 1). Written as the literal
  // because 3*1.6*3 + 2*1*2 evaluates to 18.400000000000002 in floating point — the
  // model rounds, and the rounding is the behaviour worth pinning.
  assert.equal(at114.weightLb, 18.4)
  assert.equal(at114.lineTotal, 13 * 114)
})

// ⚠️ And UPS asks for weight PER ITEM where DHL asks for the line total. Handing the
// same figure to both would overstate every UPS line by its quantity.
test('DHL gets the line weight, UPS gets the per-item weight', () => {
  const b = buildCustomsLines(LIVE)
  const dhl = toDhlRows(b).find((r) => r[4] === 13)
  const ups = toUpsRows(b).find((r) => r[3] === 13)
  assert.equal(dhl[3], 18.4)                       // line total
  assert.equal(ups[6], Math.round((18.4 / 13) * 100) / 100)
  assert.ok(ups[6] < dhl[3])
})

test('the UPS row carries the tax ID as the manufacturer ID', () => {
  const ups = toUpsRows(buildCustomsLines(LIVE))[0]
  assert.equal(ups[2], TAX_ID)
  assert.equal(TAX_ID, '850727470')
})

// ⚠️ UPS caps the description at 70 characters. Built to fit rather than sliced, so it
// never reads as a mistake to whoever checks it.
test('the description fits 70 characters without cutting a word', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    item: 'SN0301' + i, displayName: `Some Rather Long Product Name Number ${i} | Onyx`,
    qty: 1, rate: 99, coo: 'CN', weight: 1,
  }))
  const d = buildCustomsLines(many).lines[0].description
  assert.ok(d.length <= 70, `was ${d.length}: ${d}`)
  assert.ok(!d.endsWith(','))
  assert.match(d, /^Handbag - /)
})

test('the colour is dropped — a declaration describes goods, not variants', () => {
  assert.equal(describeLine({ category: 'bag', names: ['St. Barths Small Tote'] }), 'Handbag - St. Barths Small Tote')
})

// ⚠️ Two origins averaged onto one line is a false declaration. It will essentially
// never happen (CN on 4,119 of 4,127 items) — which is not a reason to allow it.
test('a different country of origin splits the line', () => {
  const b = buildCustomsLines([
    { item: 'SN1-A', displayName: 'Tote', qty: 1, rate: 100, coo: 'CN', weight: 1 },
    { item: 'SN1-B', displayName: 'Tote', qty: 1, rate: 100, coo: 'IT', weight: 1 },
  ])
  assert.equal(b.lines.length, 2)
})

test('totals add up and CSV escapes commas in names', () => {
  const b = buildCustomsLines(LIVE)
  assert.equal(b.totalQty, 14)
  assert.equal(b.totalValue, 13 * 114 + 154)
  const csv = toCsv(DHL_COLUMNS, toDhlRows(b))
  assert.equal(csv.split('\n')[0], DHL_COLUMNS.join(','))
  assert.ok(toCsv(UPS_COLUMNS, toUpsRows(b)).includes('850727470'))
})

test('zero-quantity lines are dropped, not declared', () => {
  assert.equal(buildCustomsLines([{ item: 'SN1', qty: 0, rate: 100, coo: 'CN', weight: 1 }]).lines.length, 0)
})

// ── Declaring the BOX, not the order (2026-09-18) ────────────────────────────
//
// Nima: "lets use that method if possible of IF for units and sales order for price."
// Before this, the form was built entirely from the sales order, so pulling an item off
// the fulfilment left it on the customs declaration and only raised a warning.
// Real case: IF7702 / SO12576, removing SN03014LD-COCOA ($126).

import { declarableLines } from '../src/model/customsInvoice.js'

const SO12576 = [
  { item: 'SN03011LD-ECRU', displayName: 'St. Barths Petit Tote', qty: 1, rate: 98, coo: 'CN', weight: 1 },
  { item: 'SN03012LD-TURMERIC', displayName: 'St. Barths Small Tote', qty: 1, rate: 114, coo: 'CN', weight: 1.6 },
  { item: 'SN03014LD-COCOA', displayName: 'St. Barths Large Tote', qty: 1, rate: 126, coo: 'CN', weight: 2.2 },
]

test('⚠️ an item pulled off the fulfilment leaves the declaration', () => {
  const box = [{ item: 'SN03011LD-ECRU', qty: 1 }, { item: 'SN03012LD-TURMERIC', qty: 1 }]
  const d = declarableLines({ priced: SO12576, shipped: box })
  assert.deepEqual(d.lines.map((l) => l.item), ['SN03011LD-ECRU', 'SN03012LD-TURMERIC'])
  // Named, so the screen can say WHY the form is short of the order.
  assert.deepEqual(d.excluded.map((e) => e.item), ['SN03014LD-COCOA'])
  assert.equal(d.source, 'fulfilment')
  assert.equal(d.verified, true)
})

test('the QUANTITY comes from the box and the PRICE from the order', () => {
  // The order priced 1; the warehouse actually packed 3.
  const d = declarableLines({
    priced: [{ item: 'SN03011LD-ECRU', displayName: 'Petit Tote', qty: 1, rate: 98, coo: 'CN' }],
    shipped: [{ item: 'SN03011LD-ECRU', qty: 3 }],
  })
  assert.equal(d.lines[0].qty, 3)
  assert.equal(d.lines[0].rate, 98)
  // The item's own facts still come from the order's join to the item record.
  assert.equal(d.lines[0].coo, 'CN')
  assert.equal(d.lines[0].displayName, 'Petit Tote')
})

test('⚠️ an item in the box with no price is a PROBLEM, never a zero', () => {
  const d = declarableLines({
    priced: SO12576,
    shipped: [{ item: 'SN03011LD-ECRU', qty: 1 }, { item: 'SN99999LD-MYSTERY', qty: 2 }],
  })
  // It is NOT declared at a guessed value...
  assert.deepEqual(d.lines.map((l) => l.item), ['SN03011LD-ECRU'])
  // ...it is named so the caller can block the document.
  assert.deepEqual(d.unpriced, [{ item: 'SN99999LD-MYSTERY', qty: 2 }])
})

test('⚠️ an unreadable fulfilment falls back to the order, and SAYS it is unverified', () => {
  // Empty cannot mean "the box is empty" — a zero-line customs form for a real
  // shipment is worse than over-declaring. The caller must see verified: false.
  const d = declarableLines({ priced: SO12576, shipped: [] })
  assert.equal(d.lines.length, 3)
  assert.equal(d.source, 'order')
  assert.equal(d.verified, false)
})

test('a box matching the order declares exactly the order', () => {
  const d = declarableLines({
    priced: SO12576,
    shipped: SO12576.map((l) => ({ item: l.item, qty: 1 })),
  })
  assert.equal(d.lines.length, 3)
  assert.deepEqual(d.excluded, [])
  assert.deepEqual(d.unpriced, [])
})

test('a zero-quantity line in the box is not declared', () => {
  const d = declarableLines({
    priced: SO12576,
    shipped: [{ item: 'SN03011LD-ECRU', qty: 1 }, { item: 'SN03012LD-TURMERIC', qty: 0 }],
  })
  assert.deepEqual(d.lines.map((l) => l.item), ['SN03011LD-ECRU'])
})
