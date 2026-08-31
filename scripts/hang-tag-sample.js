// Render hang tags for real catalogue SKUs to a PDF, without printing.
//
// ⚠️ WRITES NOTHING AND PRINTS NOTHING — it exists so a physical label can be checked on
// screen (and against the roll) before a run goes to the printer.
//
//   node --env-file=.env.local scripts/hang-tag-sample.js [count]
import { pool } from '../src/db.js'
import { hangTags, tagJoinKey } from '../src/model/hangTag.js'
import { makeHangTagSheet } from '../server/printLabel.js'

const limit = Number(process.argv[2]) || 6

// ⚠️ The join is on sku_key with its separator swapped, NEVER on the style: the price is
// per COLOUR (SN03012LD is $240 in Adobe, $285 in Ash) and joining on the style would
// print one colour's price on every tag for that style. tagJoinKey owns the transform.
const { rows } = await pool.query(`
  SELECT c.sku_key AS "skuKey", c.description, c.product_id AS "productId", c.color, c.upc,
         p.unit_price AS retail
    FROM catalogue_skus c
    LEFT JOIN ns_item_price p
      ON upper(p.sku) = upper(replace(c.sku_key,'|','-')) AND p.level_name = 'Retail Price'
   ORDER BY c.sku_key`)

const { tags, blocked } = hangTags(rows)
console.log(`${rows.length} catalogue SKUs → ${tags.length} printable · ${blocked.length} blocked`)
for (const b of blocked) console.log(`   ✗ ${b.skuKey}: ${b.reason}`)

// Put the photographed tag first if it is in range, so the sample is comparable.
const bordeaux = tags.find((t) => t.skuKey === 'SN03012LD|BORDEAUX')
const rest = tags.filter((t) => t !== bordeaux)
const pick = [bordeaux, ...rest].filter(Boolean).slice(0, limit)

const { path, drawn } = await makeHangTagSheet(pick)
console.log(`\n${drawn.length} tag(s) rendered → ${path}`)
for (const t of pick) console.log(`   ${t.style.padEnd(11)} ${t.color.padEnd(13)} ${t.upc}  ${t.price}`)
await pool.end()
