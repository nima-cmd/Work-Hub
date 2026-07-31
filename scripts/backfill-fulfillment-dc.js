// scripts/backfill-fulfillment-dc.js — one-off: pull EVERY EDI fulfilment's
// (PO, DC) so departures can be counted per BOL back through history.
//
// The scheduled sync only looks at the last 30 days, which is right for keeping
// up but leaves older shipments without a DC — and those are exactly the ones a
// historical departure count needs. Run this once after migrating.
//
//   node --env-file=.env.local scripts/backfill-fulfillment-dc.js [--dry]
import { syncFulfillmentDc } from '../src/ingest/fulfillmentDc.js'

const dry = process.argv.includes('--dry')
console.log(`Fulfilment → DC backfill${dry ? ' (dry run)' : ''} …`)
const r = await syncFulfillmentDc({ dryRun: dry })
if (!r.ok) {
  console.error('✗', r.error || 'failed')
  process.exit(1)
}
console.log(`  pulled ${r.pulled} EDI fulfilment(s) from NetSuite`)
console.log(`  ${r.unusable} skipped — no usable PO-DC identifier (junk keys like "KSA-")`)
console.log(`${r.rolledBack ? '↩ rolled back' : '✓'} ${r.loaded} row(s) ${r.rolledBack ? 'would load' : 'loaded'}`)
process.exit(0)
