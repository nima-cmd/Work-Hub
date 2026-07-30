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
// NOTE: a role that can't see transactions gets an EMPTY RESULT SET, not an
// error — NetSuite filters by permission silently. So "0 rows" is a FAILURE
// here, not a pass: this account always has sales orders.
if (!tx.ok || tx.rows.length === 0) {
  console.log('❌ Customer read worked, but SALES ORDERS came back ' + (tx.ok ? 'EMPTY.' : 'as an error.'))
  if (tx.ok) {
    console.log('   NetSuite returns an empty set (not an error) when the role lacks')
    console.log('   transaction access — so this is a PERMISSION gap, not a query bug.')
  }
  console.log('\n   Fix on the role (Setup → Users/Roles → Manage Roles → edit it):')
  console.log('     Permissions → Transactions, add with level VIEW:')
  console.log('       • Find Transaction   ← the critical one for SuiteQL')
  console.log('       • Sales Order')
  console.log('       • Item Fulfillment')
  console.log('       • Invoice')
  console.log('   Also check the role is not restricted by subsidiary/department, and')
  console.log('   that "Accessible Subsidiaries" includes the one holding the orders.')
  if (tx.error) console.log(`\n   NetSuite said: ${String(tx.error).slice(0, 600)}`)
  process.exit(1)
}
console.log(`   ✅ Read ${tx.rows.length} sales order(s). Sample: ${tx.rows.map((r) => r.tranid).join(', ')}`)

console.log('\n🎉 NetSuite live ingest is good to go — tell Claude "creds are in" and it can')
console.log('   finish the mappers + sync against real data.')
