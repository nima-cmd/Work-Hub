// test/itemPrice.test.js — which number belongs on a tag, and which is not a price.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEVEL, isUsablePrice, retailPrice, wholesalePrice, labelBlocker, priceDeviation, pricesByItem, money,
} from '../src/model/itemPrice.js'

// SN03012LD as NetSuite holds it, measured 2026-08-27.
const SMALL_TOTE = { [LEVEL.WHOLESALE]: 114, [LEVEL.RETAIL]: 285 }

test('a price of zero or less is NOT a price', () => {
  // ⚠️ The catalogue really contains these: Retail ranges $0–$635 and Wholesale
  // -$100–$383. A hang tag is read at a register, so $0.00 gets charged.
  for (const bad of [0, '0', -1, -100, null, undefined, '', 'abc', NaN, Infinity]) {
    assert.equal(isUsablePrice(bad), false, String(bad))
  }
  for (const good of [0.01, 114, '285', 285.5]) assert.equal(isUsablePrice(good), true, String(good))
})

test('retail is what the tag prints; wholesale is what a line should bill', () => {
  assert.equal(retailPrice(SMALL_TOTE), 285)
  assert.equal(wholesalePrice(SMALL_TOTE), 114)
  assert.equal(retailPrice({}), null)
  assert.equal(retailPrice({ [LEVEL.RETAIL]: 0 }), null, 'a zero retail is no retail')
})

test('labelBlocker NAMES the missing field', () => {
  // ⚠️ "Cannot print" sends someone hunting. "No Retail Price in NetSuite" is a thing
  // they can go and fix.
  assert.equal(labelBlocker({ levels: SMALL_TOTE, upc: '840470897966' }), null)
  assert.match(labelBlocker({ levels: {}, upc: '840470897966' }), /Retail Price/)
  assert.match(labelBlocker({ levels: { [LEVEL.RETAIL]: 0 }, upc: '840470897966' }), /Retail Price/)
  assert.match(labelBlocker({ levels: SMALL_TOTE, upc: null }), /UPC/)
  assert.match(labelBlocker({ levels: SMALL_TOTE, upc: '   ' }), /UPC/)
})

test('priceDeviation catches the REAL mispricing on SO12300', () => {
  // ⚠️ A stronger check than "one style at two prices": that only fires when an order
  // disagrees with ITSELF. This compares the line to what NetSuite says it should be,
  // so a mispriced line is caught even when every line on the order agrees.
  assert.deepEqual(priceDeviation({ rate: 102, levels: SMALL_TOTE }),
    { charged: 102, list: 114, diff: -12, under: true })
  assert.equal(priceDeviation({ rate: 114, levels: SMALL_TOTE }), null, 'on the list price, no finding')
  assert.equal(priceDeviation({ rate: 130, levels: SMALL_TOTE }).under, false, 'over the list is still a deviation')
})

test('priceDeviation returns null when there is nothing to compare against', () => {
  // ⚠️ An absent comparison is not a finding. Reporting "deviates by -114" because the
  // list price is missing would be a confident number about nothing.
  assert.equal(priceDeviation({ rate: 102, levels: {} }), null)
  assert.equal(priceDeviation({ rate: 102, levels: { [LEVEL.WHOLESALE]: 0 } }), null)
  assert.equal(priceDeviation({ rate: 0, levels: SMALL_TOTE }), null)
  assert.equal(priceDeviation({ rate: null, levels: SMALL_TOTE }), null)
})

test('priceDeviation ignores floating-point noise', () => {
  assert.equal(priceDeviation({ rate: 114.001, levels: SMALL_TOTE }), null)
  assert.ok(priceDeviation({ rate: 113.5, levels: SMALL_TOTE }), 'half a dollar is real')
})

test('pricesByItem keys on the INTERNAL ID, never the sku', () => {
  // ⚠️ A sku MOVES when a weave code changes (SN030xx → SN130xx). Keying on it would
  // silently merge or split items across a rename — the drift weaver_netsuite_item
  // exists to record.
  const m = pricesByItem([
    { internalId: '41140', sku: 'SN03012LD-PACIFIC', priceLevel: '1', unitPrice: 114 },
    { internalId: '41140', sku: 'SN03012LD-PACIFIC', priceLevel: '2', unitPrice: 285 },
    { internalId: '41140', sku: 'SN13012LD-PACIFIC', priceLevel: '8', unitPrice: 114 },
  ])
  assert.equal(m.size, 1, 'one item, despite two spellings of its sku')
  const it = m.get('41140')
  assert.equal(retailPrice(it.levels), 285)
  assert.equal(wholesalePrice(it.levels), 114)
})

test('pricesByItem stores an unusable price as null, not as a number', () => {
  const m = pricesByItem([{ internalId: '1', sku: 'X', priceLevel: '2', unitPrice: 0 }])
  assert.equal(m.get('1').levels['2'], null)
  assert.equal(retailPrice(m.get('1').levels), null)
})

test('pricesByItem drops rows with no item id rather than inventing one', () => {
  const m = pricesByItem([
    { internalId: '', sku: 'X', priceLevel: '2', unitPrice: 5 },
    { internalId: null, priceLevel: '2', unitPrice: 5 },
  ])
  assert.equal(m.size, 0)
})

test('money rounds to cents without float drift reaching a printed tag', () => {
  assert.equal(money(285.005), 285.01)
  assert.equal(money(0.1 + 0.2), 0.3)
  assert.equal(money('114'), 114)
})
