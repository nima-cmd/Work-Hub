// scripts/check-asn-cartons.js — did every carton that shipped get announced?
//
//   npm run check:asn-cartons                 # POs from the 5 most recent ASNs
//   npm run check:asn-cartons -- --since 60   # 856-or-shipping activity in 60d
//   npm run check:asn-cartons -- --recent 20  # widen the count-based window
//   npm run check:asn-cartons -- --all        # every PO any outbound 856 covers
//                                             #   (the full audit — minutes, and
//                                             #    mostly historical findings)
//   npm run check:asn-cartons -- --po 7527086 --po 7776940
//   npm run check:asn-cartons -- --no-write   # don't touch the check tables
//
// Read-only against NetSuite and Orderful. By default it DOES write its verdict
// to Neon (asn_carton_check / asn_carton_run) — the same rows the EDI tab reads,
// so running this by hand refreshes what the app shows. Pass --no-write to leave
// them alone.
//
// The work itself lives in src/ingest/asnCartonSync.js so this and the scheduled
// caller run identical code; everything below is presentation. Why the scope is
// by PO rather than by date, and why the PO set has to be closed over the ASNs
// first, are documented there.
import { syncAsnCartons } from '../src/ingest/asnCartonSync.js'
import { undeclaredByFulfilment, asnSummary } from '../src/model/asnCartonCheck.js'
import { pool } from '../src/db.js'

function parseArgs(argv) {
  const pos = []
  let recent = 5
  let all = false
  let sinceDays = null
  let write = true
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--po' && argv[i + 1]) pos.push(argv[++i])
    else if (argv[i] === '--recent' && argv[i + 1]) recent = Number(argv[++i]) || 5
    else if (argv[i] === '--all') all = true
    else if (argv[i] === '--since' && argv[i + 1]) sinceDays = Number(argv[++i]) || null
    else if (argv[i] === '--no-write') write = false
  }
  return { pos, recent, all, sinceDays, write }
}

const main = async () => {
  const { pos, recent, all, sinceDays, write } = parseArgs(process.argv.slice(2))
  if (pos.length) console.log(`Checking ${pos.length} PO(s): ${pos.join(', ')}\n`)
  else if (all) console.log('Checking every PO with an outbound 856 — the full audit\n')
  else if (sinceDays) console.log(`Checking POs with 856 or shipping activity in the last ${sinceDays} days\n`)
  else console.log(`Checking the POs of the ${recent} most recent ASNs\n`)

  const r = await syncAsnCartons({ pos, recent, all, sinceDays, persist: write, log: (m) => console.log(m) })
  if (!r.ok) { console.error(r.error); process.exit(1) }
  if (r.empty) { console.log(r.reason); return }

  if (r.undelivered.length) {
    console.log(`  ⚠ not delivered (announced nothing): ${r.undelivered.map((d) => `${d.business_number}[${d.delivery_status}]`).join(', ')}`)
  }

  const result = r.result
  if (!r.run.shipped) { console.log('\nNothing shipped on these POs yet — nothing to reconcile.'); return }

  console.log(`\n── ${asnSummary(result)} — ${result.status.toUpperCase()}`)
  const c = result.counts
  console.log(`   matched ${c.matched} · unannounced ${c.undeclared} · phantom ${c.phantom} · blank SSCC ${c.blankSscc} · duplicated ${c.duplicated}`)
  if (c.reDeclared) {
    // Accounts for the difference between the raw declared count printed above
    // and the unique carton count here, so the two never look contradictory.
    console.log(`   ${c.reDeclared} carton(s) announced on more than one ASN (re-sent 856s) — usually benign`)
  }

  if (result.undeclared.length) {
    console.log('\n⚠ SHIPPED BUT NEVER ANNOUNCED — these partners received unexpected cartons:')
    for (const g of undeclaredByFulfilment(result)) {
      console.log(`   ${g.ifNumber || '(unknown IF)'} [${g.poDc || '?'}] — ${g.ssccs.length} carton(s)`)
      for (const s of g.ssccs.slice(0, 5)) console.log(`      ${s}`)
      if (g.ssccs.length > 5) console.log(`      … ${g.ssccs.length - 5} more`)
    }
  }
  if (result.phantom.length) {
    console.log('\n⚠ ANNOUNCED BUT NOT IN NETSUITE — the partner is waiting for a box that may not exist:')
    for (const p of result.phantom.slice(0, 10)) console.log(`   ${p.sscc} on ${p.declaredOn.join(', ')}`)
    if (result.phantom.length > 10) console.log(`   … ${result.phantom.length - 10} more`)
  }
  if (result.blankSscc.length) {
    const ifsBlank = [...new Set(result.blankSscc.map((b) => b.ifNumber))]
    console.log(`\n⚠ ${result.blankSscc.length} carton(s) have NO SSCC — unreconcilable either way: ${ifsBlank.join(', ')}`)
  }
  if (result.duplicated.length) {
    console.log('\n⚠ DUPLICATE SSCC — one license plate on more than one carton:')
    for (const d of result.duplicated) console.log(`   ${d.sscc} ×${d.count} (${d.ifNumbers.join(', ')})`)
  }
  if (result.clean) console.log('\n✓ Every shipped carton is on a delivered ASN.')
  if (write) console.log('\nSaved — the EDI tab now shows this run.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => pool.end())
