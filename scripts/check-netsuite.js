// scripts/check-netsuite.js — verify the NetSuite TBA credentials work.
// Run: npm run check:netsuite
//
// Prints ONLY pass/fail + row counts. It never prints a secret, so the output is
// safe to paste anywhere (including to Claude). Read-only: the probe is a
// SuiteQL SELECT.

import { netsuiteCreds, runSuiteQL, normalizeAccount } from '../src/ingest/netsuiteApi.js'

const REQUIRED = [
  'NS_ACCOUNT_ID',
  'NS_CONSUMER_KEY',
  'NS_CONSUMER_SECRET',
  'NS_TOKEN_ID',
  'NS_TOKEN_SECRET',
]

const missing = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.log('❌ Not configured yet. Missing from .env.local:')
  for (const k of missing) console.log(`     ${k}`)
  console.log('\n   (Present: ' + (REQUIRED.filter((k) => process.env[k]).join(', ') || 'none') + ')')
  console.log('   See docs/netsuite-api-integration.md for the admin checklist.')
  process.exit(1)
}

const creds = netsuiteCreds()
console.log('✅ All 5 credentials present.')
console.log(`   Account → host/realm: ${normalizeAccount(creds.account)}`)
console.log('\nProbe 1/2: can we authenticate + run SuiteQL?')

const probe = await runSuiteQL('SELECT id, companyname FROM customer', { pageSize: 3, maxPages: 1 })
if (!probe.ok) {
  if (probe.needsAuth) {
    console.log(`❌ Auth rejected (HTTP ${probe.status}). Common causes:`)
    console.log('   • Token/consumer key mismatch, or a secret copied incompletely')
    console.log('   • Token-Based Authentication / REST Web Services not enabled')
    console.log('   • The role lacks "Log in using Access Tokens" or "REST Web Services"')
    console.log('   • Wrong account id (sandbox needs the _SB1 suffix)')
  } else if (probe.configured === false) {
    console.log('❌ Reported unconfigured — a credential is empty.')
  } else {
    console.log(`❌ Failed${probe.status ? ` (HTTP ${probe.status})` : ''}.`)
  }
  // Show NetSuite's own message — it names the missing permission/feature.
  if (probe.error) console.log(`\n   NetSuite said: ${String(probe.error).slice(0, 600)}`)
  process.exit(1)
}
console.log(`   ✅ Authenticated. Read ${probe.rows.length} customer row(s).`)

console.log('\nProbe 2/2: the transaction read the ingest actually needs?')
const tx = await runSuiteQL(
  "SELECT tranid, BUILTIN.DF(status) AS status FROM transaction WHERE type = 'SalesOrd'",
  { pageSize: 3, maxPages: 1 },
)
if (!tx.ok) {
  console.log('❌ Customer read worked but TRANSACTIONS failed — almost certainly a')
  console.log('   permission gap on the role: it needs View on Transactions →')
  console.log('   Find Transaction / Sales Order / Item Fulfillment / Invoice.')
  if (tx.error) console.log(`\n   NetSuite said: ${String(tx.error).slice(0, 600)}`)
  process.exit(1)
}
console.log(`   ✅ Read ${tx.rows.length} sales order(s). Sample: ${tx.rows.map((r) => r.tranid).join(', ')}`)

console.log('\n🎉 NetSuite live ingest is good to go — tell Claude "creds are in" and it can')
console.log('   finish the mappers + sync against real data.')
