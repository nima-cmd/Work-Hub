// test/packingSlip.test.js — the parser against two REAL slips and the reference
// CSVs an independent implementation produced from them.
//
// ⚠️ THESE ARE FIXTURES, NOT MOCKS, AND THAT IS THE POINT. The parser this was
// ported from had no tests, and a carton double-count survived on every container
// it ever read. Real files with their own printed totals catch that class; a
// hand-written fixture agrees with whatever bug you had when you wrote it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parsePackingSlip, expandRange, colorToSku, isRawFactorySlip, isMasterPackingList } from '../src/model/packingSlip.js'
import { rowsFromXlsx, rowsFromCsvText, readPackingSlip } from '../src/ingest/packingSlipFile.js'

const F = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'packing-slips')
const bytes = (n) => new Uint8Array(readFileSync(join(F, n)))
const text = (n) => readFileSync(join(F, n), 'utf8')

// Bita's independent output: PO Number,Style Number,Color,SKU,Total Units
function reference(name) {
  const m = new Map()
  for (const line of text(name).trim().split(/\r?\n/).slice(1)) {
    const p = line.split(',')
    m.set(`${p[0]}|${p[3]}`, Number(p[4]))
  }
  return m
}

const SLIPS = [
  { xlsx: '55-container-2026.9.7.xlsx', ref: '55-container.reference.csv',
    label: '55 Container 2026.9.7', cartons: 55, units: 1439, rows: 44,
    pos: ['1747', '1761', '1785', '1820'] },
  { xlsx: '11-air-2026.9.9.xlsx', ref: '11-air.reference.csv',
    label: '11 Air 2026.9.9', cartons: 11, units: 150, rows: 4,
    pos: ['1777', '1820'] },
]

for (const s of SLIPS) {
  test(`⚠️ ${s.label} — EVERY PO+SKU MATCHES THE INDEPENDENT IMPLEMENTATION`, () => {
    // Two parsers written separately, agreeing on a file neither had seen, is the
    // evidence that made porting this a lift rather than a rewrite.
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    const ref = reference(s.ref)
    const got = new Map(c.skuTotals.map((r) => [`${r.poNumber}|${r.sku}`, r.units]))
    const keys = [...new Set([...ref.keys(), ...got.keys()])].sort()
    const diffs = keys.filter((k) => ref.get(k) !== got.get(k))
      .map((k) => `${k}: reference=${ref.get(k) ?? '—'} parser=${got.get(k) ?? '—'}`)
    assert.deepEqual(diffs, [], `differences from the reference CSV:\n${diffs.join('\n')}`)
    assert.equal(got.size, s.rows)
  })

  test(`⚠️ ${s.label} — THE CARTON TALLY EQUALS THE SLIP'S OWN TOTAL`, () => {
    // The regression this port exists to fix. Naghedi-Warehouse reports 110 for
    // this 55-carton container and 22 for the 11-carton air shipment, because the
    // slip's grand-total row inherits a style through fill-down and its own carton
    // count gets added to the sum of the parts.
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    assert.equal(c.cartonCount, s.cartons, 'summary carton count')
    assert.equal(c.boxCount, s.cartons, 'and the number of real boxes agrees with it')
  })

  test(`${s.label} — units and POs match the slip`, () => {
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    assert.equal(c.unitCount, s.units)
    assert.deepEqual([...c.poNumbers].sort(), s.pos)
    assert.equal(c.format, 'factory')
  })

  test(`⚠️ ${s.label} — THE BOXES ACCOUNT FOR EVERY UNIT`, () => {
    // The two outputs must describe the same shipment. If the box map holds fewer
    // units than the import total, something is on a truck that the floor cannot
    // find; more, and a carton has been double-counted.
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    const inBoxes = Object.values(c.cartons)
      .flat()
      .reduce((n, b) => n + b.items.reduce((m, i) => m + i.qty, 0), 0)
    assert.equal(inBoxes, s.units)
  })

  test(`${s.label} — every box number is unique within its PO, and none is zero`, () => {
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    for (const [po, list] of Object.entries(c.cartons)) {
      const nums = list.map((b) => b.box)
      assert.equal(new Set(nums).size, nums.length, `${po} has a duplicate box number`)
      assert.ok(nums.every((n) => Number.isInteger(n) && n > 0), `${po} has a bad box number`)
    }
  })

  test(`${s.label} — nothing is silently skipped`, () => {
    const c = parsePackingSlip(rowsFromXlsx(bytes(s.xlsx)), { containerNum: s.label })
    assert.deepEqual(c.skipped, [], 'a skipped row with a quantity would be lost units')
  })
}

test('the reference CSVs are themselves readable, as master lists', () => {
  // ⚠️ And they carry NO cartons. That absence is deliberate: this form can feed
  // the NetSuite import and can never feed the bin map.
  const c = readPackingSlip(text('11-air.reference.csv'), { containerNum: '11 Air 2026.9.9' })
  assert.equal(c.format, 'master')
  assert.equal(c.unitCount, 150)
  assert.deepEqual(c.cartons, {})
  assert.equal(c.cartonCount, null, 'null, not 0 — we do not know, rather than know it is none')
})

test('the two formats are told apart, and not confused', () => {
  const factory = rowsFromXlsx(bytes('11-air-2026.9.9.xlsx'))
  const master = rowsFromCsvText(text('11-air.reference.csv'))
  assert.equal(isRawFactorySlip(factory), true)
  assert.equal(isMasterPackingList(factory), false)
  assert.equal(isMasterPackingList(master), true)
  assert.equal(isRawFactorySlip(master), false)
})

test('an unrecognised sheet is refused, not guessed at', () => {
  assert.throws(() => parsePackingSlip([['Name', 'Qty'], ['thing', 1]]), /Unrecognised packing slip/)
})

test('⚠️ A CARTON RANGE IS CARTONS, NOT A QUANTITY', () => {
  // "3-6" with PACK/CTN 11 is four boxes of eleven — 44 units and four places to
  // look on the floor. Reading it as one box loses three of them.
  assert.deepEqual(expandRange('3-6'), [3, 4, 5, 6])
  assert.deepEqual(expandRange('11'), [11])
  assert.deepEqual(expandRange(''), [])
  assert.deepEqual(expandRange('7 – 10'), [7, 8, 9, 10], 'en dash, as typed by the factory')
  // ⚠️ INHERITED BEHAVIOUR, DOCUMENTED RATHER THAN CHANGED. A span wider than 500
  // is rejected as a mis-key, but the string then falls through to parseInt and
  // yields [3] — so the units land in box 3 instead of nowhere. Faithful to the
  // implementation this was ported from, and a port that quietly changes behaviour
  // is not a port. Worth revisiting: putting a whole line in one wrong box is not
  // obviously better than refusing it.
  assert.deepEqual(expandRange('3-6000'), [3])
})

test('the 3-6 range really does become four boxes of eleven', () => {
  const c = parsePackingSlip(rowsFromXlsx(bytes('11-air-2026.9.9.xlsx')), { containerNum: '11 Air' })
  const bluff = c.cartons['1777'].filter((b) => b.items.some((i) => i.sku === 'SN25013FN-BLUFF'))
  assert.deepEqual(bluff.map((b) => b.box).slice(0, 4), [3, 4, 5, 6])
  for (const b of bluff.slice(0, 4)) assert.equal(b.items.find((i) => i.sku === 'SN25013FN-BLUFF').qty, 11)
})

test('⚠️ A MIXED CARTON KEEPS BOTH SKUS', () => {
  // Carton 11 of the air shipment holds 6 Bluff and 6 Canyon. A continuation row
  // has no CTNS NO. of its own, so it belongs to the carton above it.
  const c = parsePackingSlip(rowsFromXlsx(bytes('11-air-2026.9.9.xlsx')), { containerNum: '11 Air' })
  const box11 = c.cartons['1777'].find((b) => b.box === 11)
  assert.deepEqual(box11.items, [
    { sku: 'SN25013FN-BLUFF', qty: 6 },
    { sku: 'SN25013FN-CANYON', qty: 6 },
  ])
})

test('the order memo is carried off column B', () => {
  const c = parsePackingSlip(rowsFromXlsx(bytes('55-container-2026.9.7.xlsx')), { containerNum: '55 Container' })
  assert.equal(c.poMeta['1785'].memo, 'Ecomm Order 1')
  assert.equal(c.poMeta['1761'].memo, 'Brights Capsule')
  assert.equal(c.poMeta['1747'].memo, 'Special Ecomm Net Bag')
})

test('a colour becomes the SKU form, spaces and all', () => {
  assert.equal(colorToSku('Miami Pink'), 'MIAMI-PINK')
  assert.equal(colorToSku(' onyx '), 'ONYX')
  assert.equal(colorToSku(null), '')
})

test('⚠️ MIAMI PINK SURVIVES THE ROUND TRIP', () => {
  // A two-word colour is where a naive join breaks; the reference CSV spells it
  // SN11051LD-MIAMI-PINK, so anything else is a SKU NetSuite will not match.
  const c = parsePackingSlip(rowsFromXlsx(bytes('55-container-2026.9.7.xlsx')), { containerNum: '55 Container' })
  const row = c.skuTotals.find((r) => r.sku === 'SN11051LD-MIAMI-PINK')
  assert.ok(row, 'SN11051LD-MIAMI-PINK missing')
  assert.equal(row.units, 40)
  assert.equal(row.poNumber, '1761')
})

test('⚠️ AN ACCESSORY LINE IS NOT CARGO, AND A REAL STRAP IS', async () => {
  const { isNonMerchandise } = await import('../src/model/packingSlip.js')
  // Nima: "firstly the strap shouldn't be counted its not a real item." The slip
  // carried "straps-CHOCOLATE", 5 units against PO1758, with no PO line to receive
  // against — straps travel WITH a bag, nothing was purchased.
  assert.equal(isNonMerchandise('straps-CHOCOLATE'), true)
  assert.equal(isNonMerchandise('straps-onyx'), true)

  // ⚠️ AND NETSUITE HOLDS 32 REAL STRAP ITEMS. STRAP-PETIT-* and STRAP-SMALL-* are
  // Inventory Items that can be ordered and received; a blanket "anything with
  // strap" rule would silently lose real stock. Singular and SIZED is the tell.
  assert.equal(isNonMerchandise('STRAP-PETIT-CASHMERE'), false)
  assert.equal(isNonMerchandise('STRAP-SMALL-ONYX'), false)
  assert.equal(isNonMerchandise('STRAP'), false)

  // Anchored on the whole SKU — a style code containing the letters must not match.
  assert.equal(isNonMerchandise('SN03011LD-STRAPS-MOCHA'), false)
  assert.equal(isNonMerchandise('SN02262NB-CHOCOLATE'), false)
  assert.equal(isNonMerchandise(''), false)
  assert.equal(isNonMerchandise(null), false)
})

test('⚠️ EXCLUDED LINES ARE REPORTED, NOT DISCARDED', async () => {
  const { parsePackingSlip } = await import('../src/model/packingSlip.js')
  // A master packing list is the simpler of the two shapes: SKU + Total Units.
  // Straps come back on `nonMerchandise` with their own count rather than vanishing
  // — silently dropping a line is how a real shortage hides.
  const rows = [
    ['PO#', 'SKU', 'Total Units'],
    ['1747', 'SN02262NB-CHOCOLATE', 54],
    ['1758', 'straps-CHOCOLATE', 5],
    ['1758', 'STRAP-PETIT-CASHMERE', 3],
  ]
  const out = parsePackingSlip(rows, { containerNum: '59 cartons LCL to LA', containerDate: '2026.8.17' })

  assert.equal(out.unitCount, 57, '54 + 3 real strap units, NOT the 5 accessories')
  assert.equal(out.nonMerchandiseUnits, 5)
  assert.deepEqual(out.nonMerchandise.map((r) => r.sku), ['straps-CHOCOLATE'])
  assert.ok(!out.skuTotals.some((r) => /^straps-/i.test(r.sku)))
  // ⚠️ A sized strap stays in the cargo, because it is real stock.
  assert.ok(out.skuTotals.some((r) => r.sku === 'STRAP-PETIT-CASHMERE'))
  // ⚠️ And an accessory-only PO does not appear as a PO we are receiving against.
  assert.deepEqual([...out.poNumbers].sort(), ['1747', '1758'])
})
