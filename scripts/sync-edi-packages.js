// scripts/sync-edi-packages.js — refresh the routing carton feed from NetSuite.
//
//   npm run sync:packages          apply
//   npm run sync:packages -- --dry exercise everything, roll back
//
// Read-only against NetSuite; the only writes are to our Neon. Safe to run
// mid-packing — each run is a snapshot of the current carton count, so re-run it
// when packing finishes. See src/ingest/ediPackagesLive.js for where the data
// lives and why the feed is replaced rather than upserted.
import { syncEdiPackagesLive } from '../src/ingest/ediPackagesLive.js'
import { pool } from '../src/db.js'

const dry = process.argv.slice(2).some((a) => a === '--dry' || a === '--dry-run')

console.log(`EDI carton feed ← NetSuite${dry ? ' (DRY RUN — nothing persists)' : ''} …`)
const r = await syncEdiPackagesLive({ dryRun: dry })

if (!r.ok) {
  console.error(`✗ ${r.error}`)
  if (r.configured === false) console.error('  NetSuite creds not configured — see npm run check:netsuite')
  await pool.end()
  process.exit(1)
}

console.log(`read ${r.ifCount} unshipped EDI fulfilments · ${r.cartonCount} cartons\n`)
for (const row of r.rows) {
  console.log(`  ${row.poDc.padEnd(14)} cartons=${String(row.cartons).padStart(3)}  ${String(row.weight).padStart(5)} lb  ${String(row.units).padStart(4)} units  ${String(row.cubicFeetRaw).padStart(5)} cu ft (${row.cubicFeetRounded} rounded)  BOL ${row.suggestedBol}`)
}

if (r.skipped) {
  console.log(`\n⚠ ${r.skipped}`)
} else {
  if (r.removed?.length) {
    console.log(`\nremoved ${r.removed.length} PO-DC row(s) no longer in the feed (shipped):`)
    console.log('  ' + r.removed.join(', '))
  }
  console.log(`\n✓ ${r.loaded} rows loaded${r.rolledBack ? ' — then rolled back (dry run)' : ''}`)
}
// Worth surfacing rather than silently scoring 0 cubic feet.
if (r.unparseableBoxes?.length) console.log(`\n⚠ box types with no parseable dimensions: ${r.unparseableBoxes.join(', ')}`)
if (r.orphanCartons) console.log(`⚠ ${r.orphanCartons} carton(s) skipped — fulfilment has no usable PO-DC identifier`)

await pool.end()
