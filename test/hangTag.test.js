// test/hangTag.test.js — what goes on a Naghedi hang tag.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hangTag, hangTags, tagJoinKey, formatTagPrice, hangTagBlocker } from '../src/model/hangTag.js'

// The row the database returns for the tag Nima photographed.
const BORDEAUX = {
  skuKey: 'SN03012LD|BORDEAUX',
  description: 'St. Barths Small Tote',
  productId: 'SN03012LD',
  color: 'Bordeaux',
  upc: '840470897966',
  retail: '285',
}

test('⚠️ THE PHOTOGRAPHED TAG REPRODUCES, FIELD FOR FIELD', () => {
  // Nima sent a photo instead of describing it, and every field was already in the
  // database. This is that tag, rebuilt: nothing on it was invented.
  const r = hangTag(BORDEAUX)
  assert.equal(r.ok, true)
  assert.deepEqual(
    { name: r.tag.name, style: r.tag.style, color: r.tag.color, upc: r.tag.upc, price: r.tag.price },
    {
      name: 'St. Barths Small Tote',
      style: 'SN03012LD',
      color: 'Bordeaux',
      upc: '840470897966',
      price: '$285.00',
    },
  )
  // And the digits group the way the photo prints them.
  assert.deepEqual(r.tag.human, { lead: '8', left: '40470', right: '89796', check: '6' })
})

test('⚠️ THE JOIN KEY SWAPS THE SEPARATOR — the two tables disagree', () => {
  // ns_item_price.sku is SN03012LD-BORDEAUX; catalogue_skus.sku_key is
  // SN03012LD|BORDEAUX. Joining on the STYLE instead matched 0 of 77 rows — and had it
  // worked it would have been worse: SN03012LD is $240 in Adobe and $285 in Ash, so
  // every tag for the style would have carried one colour's price.
  assert.equal(tagJoinKey('SN03012LD|BORDEAUX'), 'SN03012LD-BORDEAUX')
  assert.equal(tagJoinKey(' sn03012ld|bordeaux '), 'SN03012LD-BORDEAUX')
  assert.equal(tagJoinKey(null), '')
})

test('⚠️ NO PRICE MEANS NO TAG, and it says which field is missing', () => {
  // Five of the 77 catalogue SKUs have no Retail Price — null, not zero. A tag with a
  // blank where the price goes is worse than no tag: it still gets attached to a bag.
  const r = hangTag({ ...BORDEAUX, retail: null })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Retail Price in NetSuite/)
  // ⚠️ Zero is not a price either (itemPrice.js owns that rule; this composes it).
  assert.equal(hangTag({ ...BORDEAUX, retail: 0 }).ok, false)
  assert.equal(hangTag({ ...BORDEAUX, retail: -5 }).ok, false)
})

test('⚠️ a PRESENT BUT INCONSISTENT UPC is refused — the most dangerous case', () => {
  // Presence tests pass it. It would print bars that scan as a different product.
  const r = hangTag({ ...BORDEAUX, upc: '840470897967' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /check digit/)
})

test('every missing text field names itself rather than printing blank', () => {
  assert.match(hangTag({ ...BORDEAUX, productId: '' }).reason, /style number/)
  assert.match(hangTag({ ...BORDEAUX, description: '' }).reason, /product name/)
  assert.match(hangTag({ ...BORDEAUX, color: '' }).reason, /colour/)
  assert.match(hangTag({ ...BORDEAUX, upc: '' }).reason, /no UPC/)
})

test('the price always carries two decimals', () => {
  // "$285" on a printed tag looks unfinished.
  assert.equal(formatTagPrice(285), '$285.00')
  assert.equal(formatTagPrice('285'), '$285.00')
  assert.equal(formatTagPrice(240.5), '$240.50')
  assert.equal(formatTagPrice(null), null)
})

test('⚠️ REFUSALS ARE RETURNED, NOT DROPPED', () => {
  // A tool that silently prints 2 tags when 3 were asked for is how a bag ends up on a
  // shelf untagged with nobody knowing why.
  const { tags, blocked } = hangTags([
    BORDEAUX,
    { ...BORDEAUX, skuKey: 'SN03012LD|INKBLUE', color: 'Ink Blue', upc: '850021312237', retail: null },
    { ...BORDEAUX, skuKey: 'SN03012LD|ONYX', color: 'Onyx', upc: '850021312251', retail: 240 },
  ])
  assert.equal(tags.length, 2)
  assert.equal(blocked.length, 1)
  assert.equal(blocked[0].skuKey, 'SN03012LD|INKBLUE')
  assert.match(blocked[0].reason, /Retail Price/)
  // The blocked row still carries enough to act on it.
  assert.equal(blocked[0].color, 'Ink Blue')
})

test('a clean row is blocked by nothing', () => {
  assert.equal(hangTagBlocker({
    description: 'X', productId: 'Y', color: 'Z', upc: '840470897966', retail: 10,
  }), null)
})

test('the sku key is derived when the row did not carry one', () => {
  const r = hangTag({ ...BORDEAUX, skuKey: undefined, sku_key: undefined })
  assert.equal(r.tag.skuKey, 'SN03012LD|BORDEAUX')
})

test('⚠️ THE SQL JOIN AND tagJoinKey CANNOT DRIFT APART', () => {
  // server/queries.js does the separator swap in SQL, and this module does it in JS.
  // Two implementations of one rule is the shape this repo keeps getting bitten by, and
  // here the cost is a wrong PRICE on a physical tag. This asserts the SQL still performs
  // the same transform, so changing one without the other fails a test rather than
  // printing $240 on a $285 bag.
  const sql = readFileSync(new URL('../server/queries.js', import.meta.url), 'utf8')
  const join = sql.slice(sql.indexOf('const HANG_TAG_SQL'), sql.indexOf('export async function getHangTags'))
  assert.match(join, /upper\(p\.sku\)\s*=\s*upper\(replace\(c\.sku_key,'\|','-'\)\)/,
    'the SQL must uppercase both sides and swap | for - exactly as tagJoinKey does')
  assert.match(join, /level_name = 'Retail Price'/, 'and it must read the Retail level, not Wholesale')
  // ⚠️ And it must NOT join on the style — that matched 0 of 77 and would have carried
  // one colour's price onto every tag for the style.
  assert.doesNotMatch(join, /upper\(p\.sku\)\s*=\s*upper\(c\.product_id\)/)
})

test('⚠️ HANG TAGS TRANSMIT EXACTLY AS THE QR CARGO TAGS DO', () => {
  // Nima, 2026-08-31: "i dont know if the pritner will print correctly if not transmitted
  // like the QR ones are." He was right to ask — the first cut omitted
  // `-o print-scaling=none`, which the QR path has always passed.
  //
  // That flag is not cosmetic for a linear barcode. Without it CUPS may scale the PDF to
  // fit the page, and scaling a UPC-A changes its X-DIMENSION: below 0.0104in it stops
  // reading, and enlarged it no longer matches the quiet zones it was laid out with. A QR
  // code survives scaling. A UPC does not.
  const src = readFileSync(new URL('../server/printLabel.js', import.meta.url), 'utf8')
  const lpCalls = [...src.matchAll(/execFile\(\s*\n?\s*'lp',\s*\[([^\]]+)\]/g)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim())
  // Three printers on this surface: the tag sheet, the single cargo tag, and hang tags.
  assert.equal(lpCalls.length, 3, 'every lp invocation must be accounted for')
  for (const call of lpCalls) {
    assert.match(call, /'-d', cfg\.queue/, 'names the queue explicitly')
    assert.match(call, /'-o', cfg\.media/, 'sets the page size explicitly')
    assert.match(call, /'-o', 'print-scaling=none'/, 'refuses CUPS scaling')
  }
  // And they are all the SAME argument list, so none can drift from the others.
  const normalised = new Set(lpCalls.map((c) => c.replace(/,\s*path\s*$/, '')))
  assert.equal(normalised.size, 1, `lp flags differ between printers: ${[...normalised].join(' || ')}`)
})
