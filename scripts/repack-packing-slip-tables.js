// scripts/repack-packing-slip-tables.js — one-off: rekey the packing_slip tables
// from container_num to container_label.
//
// ⚠️ WHY THIS IS A SCRIPT AND NOT AN `ALTER TABLE ... IF NOT EXISTS` IN schema.sql.
// The change is to the PRIMARY KEY, which is not expressible idempotently, and a
// bare `DROP TABLE` living in the canonical schema would one day run against real
// containers. So it is here, once, guarded.
//
// The bug it fixes: `container_num` is the bare number off the slip — "55",
// "11 Air", "321" — and it REPEATS. A 55-carton container ships most seasons, so the
// next "55" would have overwritten this one's lines and cartons, and the box lookup
// the tables exist to serve would have answered with the wrong shipment.
// `container_label` is `<num> carton <y.m.d>`, which is unique and is also the exact
// string NetSuite holds inside every generated External ID.
//
// ⚠️ IT REFUSES TO RUN once anything real is stored. It drops, and the four tables
// were created by the unmerged feat/packing-slip-import branch, so the only rows it
// can legitimately discard are the two test containers loaded while building it.
// Pass --force only if you have decided the stored slips are expendable, and know
// that a slip is the ONLY record of which box an item arrived in.
//
//   node --env-file=.env.local scripts/repack-packing-slip-tables.js
//   npm run migrate        # recreates them in the new shape

import { pool, DB_TARGET } from '../src/db.js'

const TEST_CONTAINERS = ['55 Container 2026.9.7', '11 Air 2026.9.9']
const force = process.argv.includes('--force')

console.log(`\n  Database: ${DB_TARGET}`)

const { rows } = await pool.query('SELECT container_num FROM packing_slip ORDER BY container_num')
const stored = rows.map((r) => r.container_num)
const unexpected = stored.filter((c) => !TEST_CONTAINERS.includes(c))

if (stored.length) console.log(`  Stored containers: ${stored.join(' · ')}`)

if (unexpected.length && !force) {
  console.error(`\n  ✗ REFUSING. These are not the branch's test containers:\n`)
  for (const c of unexpected) console.error(`      ${c}`)
  console.error(`\n    Dropping them destroys the only record of which box their items`)
  console.error(`    arrived in — NetSuite records the receipt, not the packing.`)
  console.error(`    Re-import them from their .xlsx after migrating, or pass --force.\n`)
  await pool.end()
  process.exit(1)
}

await pool.query('DROP TABLE IF EXISTS packing_slip_carton, packing_slip_line, packing_slip_revision, packing_slip CASCADE')
console.log('\n  ✓ Dropped. Now run:  npm run migrate\n')
await pool.end()
