// scripts/sync-netsuite.js — run the live read-only NetSuite pull.
//
// This existed as a tested module (src/ingest/netsuiteSync.js) with NO caller
// for a week, so Neon quietly drifted from NetSuite: 14 item fulfilments that
// NetSuite had marked Shipped still read Picked/Packed here, which left 7
// Bloomingdale's BOLs stranded on the active routing board (Nima, 2026-08-01).
// The cron (/api/internal/recurring-check) now calls the same function; this is
// the manual/one-off entry point.
//
//   npm run sync:netsuite            apply
//   npm run sync:netsuite -- --dry   exercise every statement, roll it all back
//
// Read-only against NetSuite (SuiteQL over TBA); the only writes are to our Neon.
import { syncFromNetsuite } from '../src/ingest/netsuiteSync.js'
import { pool } from '../src/db.js'

const dryRun = process.argv.slice(2).some((a) => a === '--dry' || a === '--dry-run')
const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1]) || 30

console.log(`NetSuite live sync${dryRun ? ' (DRY RUN — nothing persists)' : ''}, closed-within ${days}d …`)
const r = await syncFromNetsuite({ closedWithinDays: days, dryRun })

if (!r.ok) {
  console.error(`✗ sync failed: ${r.error}`)
  if (r.configured === false) console.error('  NetSuite creds are not configured — see npm run check:netsuite')
  await pool.end()
  process.exit(1)
}

for (const w of r.warnings || []) console.warn(`⚠ ${w}`)
console.log(`pulled since ${r.since}: ${JSON.stringify(r.counts)}`)
console.log(`orders ${r.nOrders} · fulfilments ${r.nFul} · invoices ${r.nInv} · shipped-$ credits ${r.nCredits} · phantom IFs removed ${r.nPhantoms}`)

const archived = r.archived || []
if (archived.length) {
  console.log(`\narchived ${archived.length} routing shipment(s) NetSuite confirms fully shipped:`)
  for (const a of archived) console.log(`  ${a.bolNumber}  ${a.partner} · DC ${a.dc}  POs ${a.memberPos.join(', ')}`)
} else {
  console.log('\nno routing shipments newly confirmed shipped')
}
if (r.rolledBack) console.log('\n(dry run — rolled back, nothing persisted)')

await pool.end()
