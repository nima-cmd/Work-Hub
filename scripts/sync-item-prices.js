#!/usr/bin/env node
// npm run sync:prices  [--dry-run]
//
// Pulls NetSuite's price list (the `pricing` sublist) into ns_item_price. Retail Price
// is what the Munbyn hang tag prints; Wholesale Price is what an order line should be
// checked against.
//
// ⚠️ item.baseprice is EMPTY — it queries fine and returns nothing. The sublist is the
// only real source.

import { pool } from '../src/db.js'
import { syncItemPrices } from '../src/ingest/netsuiteItemPrices.js'
import { LEVEL, LEVEL_NAME, isUsablePrice } from '../src/model/itemPrice.js'

const dryRun = process.argv.includes('--dry-run')
const r = await syncItemPrices({ dryRun })

console.log(`\n  NetSuite item prices${dryRun ? '  (DRY RUN — nothing written)' : ''}`)
console.log(`  ${'─'.repeat(72)}`)
if (!r.configured) {
  console.log('  NetSuite is not configured — nothing to do.\n')
  await pool.end()
  process.exit(2)
}
console.log(`  ${r.fetched} price row(s) fetched` + (dryRun ? '' : ` · ${r.upserted} upserted · ${r.swept} swept · ${r.items} item name(s)`))

if (!dryRun) {
  const { rows } = await pool.query(
    `SELECT price_level, level_name, count(*) AS n,
            count(*) FILTER (WHERE unit_price > 0) AS usable
       FROM ns_item_price GROUP BY 1,2 ORDER BY 3 DESC`)
  console.log('')
  for (const x of rows) {
    // ⚠️ "usable" is a SEPARATE count on purpose. A level with 4,230 rows of which 300
    // are zero cannot price 4,230 labels, and one number would say it could.
    console.log(`    ${String(x.price_level).padEnd(3)} ${String(x.level_name || LEVEL_NAME[x.price_level] || '?').padEnd(26)} ${String(x.n).padStart(5)} rows · ${String(x.usable).padStart(5)} usable`)
  }
  const { rows: gap } = await pool.query(
    `SELECT count(*) AS n FROM ns_item_price WHERE price_level = $1 AND NOT (unit_price > 0)`, [LEVEL.RETAIL])
  if (Number(gap[0].n)) {
    console.log(`\n  ⚠️  ${gap[0].n} item(s) carry a Retail Price of zero or less — no label can print for those.`)
  }
}
console.log('')
await pool.end()
