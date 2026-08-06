#!/usr/bin/env node
// npm run check:label-records
//
// For every label bought in ShipStation, did the tracking number and the freight
// figure reach NetSuite? (Nima, 2026-08-06 — the manual step ShipStation costs us.)
//
// Read-only on both sides. The rule lives in src/model/labelRecordCheck.js so it is
// tested; this script only fetches and prints.
//
// ⚠️ Three field facts this depends on, each learned the hard way:
//   • Tracking on a fulfilment is reachable ONLY via the TrackingNumberMap join —
//     transaction.trackingnumbers is not a queryable field.
//   • `shippingcost` is NOT_EXPOSED to SuiteQL on EVERY transaction type (tested
//     against SalesOrd, ItemShip and CustInvc with a passing baseline). The invoice
//     REST record carries it; that is the only route.
//   • The ITEM FULFILMENT REST record needs 'Fulfill Sales Orders' at EDIT even to
//     GET, so the freight figure is read from the INVOICE — which is the document
//     Nima cares about anyway.

import { pool } from '../src/db.js'
import { runSuiteQL, restGet } from '../src/ingest/netsuiteApi.js'
import { labelRecordGap, summarizeLabelRecords, RECORD_GAP } from '../src/model/labelRecordCheck.js'

const money = (n) => `$${Number(n || 0).toFixed(2)}`

const { rows: labels } = await pool.query(`
  SELECT order_key, if_number, scope, tracking_number, shipment_cost, voided
  FROM shipstation_order
  WHERE tracking_number IS NOT NULL
  ORDER BY if_number, order_key
`)

if (!labels.length) {
  console.log('No ShipStation labels harvested yet — run npm run sync:shipstation-tracking first.')
  process.exit(0)
}

const ifNumbers = [...new Set(labels.map((l) => l.if_number).filter(Boolean))]
const quoted = ifNumbers.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',')

// Tracking numbers recorded on each fulfilment.
const tq = await runSuiteQL(`
  SELECT c.tranid AS if_number, tn.trackingnumber
  FROM transaction c
  JOIN TrackingNumberMap m ON m.transaction = c.id
  JOIN trackingnumber tn ON tn.id = m.trackingnumber
  WHERE c.tranid IN (${quoted})`)
const nsTracking = new Map()
for (const r of (tq.rows || [])) {
  if (!nsTracking.has(r.if_number)) nsTracking.set(r.if_number, [])
  nsTracking.get(r.if_number).push(r.trackingnumber)
}

// The invoice for each fulfilment, from Neon (the sync already derives it via the
// shared sales order — see invoiceBySo for why that is the only available link).
const { rows: invRows } = await pool.query(
  `SELECT if_number, invoice_number FROM fulfillments WHERE if_number = ANY($1::text[])`, [ifNumbers])
const invoiceByIf = new Map(invRows.map((r) => [r.if_number, r.invoice_number]))

// The freight figure on those invoices — REST only, and only for invoices that exist.
const invNumbers = [...new Set([...invoiceByIf.values()].filter(Boolean))]
const invoiceCost = new Map()
if (invNumbers.length) {
  const iq = await runSuiteQL(
    `SELECT id, tranid FROM transaction WHERE tranid IN (${invNumbers.map((n) => `'${n}'`).join(',')})`)
  for (const row of (iq.rows || [])) {
    const r = await restGet(`invoice/${row.id}`)
    // ⚠️ A failed read must not read as "no figure recorded" — that would invent work.
    invoiceCost.set(row.tranid, r.ok ? { cost: r.data?.shippingCost ?? null, ok: true } : { cost: null, ok: false })
  }
}

const results = labels.map((l) => {
  const invoiceNumber = invoiceByIf.get(l.if_number) || null
  const seen = invoiceNumber ? invoiceCost.get(invoiceNumber) : null
  // If we could not READ the invoice, treat the figure as unknown rather than absent.
  const unreadable = invoiceNumber && seen && !seen.ok
  const verdict = labelRecordGap({
    ssTracking: l.tracking_number,
    ssCost: Number(l.shipment_cost || 0),
    voided: l.voided,
    nsTracking: nsTracking.get(l.if_number) || [],
    invoiceNumber: unreadable ? null : invoiceNumber,
    invoiceShippingCost: seen?.cost ?? null,
  })
  return { ...l, invoiceNumber, verdict, unreadable }
})

const counts = summarizeLabelRecords(results.map((r) => r.verdict))
const pad = (s, n) => String(s ?? '').padEnd(n)

console.log(`\n${labels.length} label(s) bought in ShipStation · ${ifNumbers.length} fulfilment(s)\n`)

// ⚠️ SPLIT BY LANE, because the same verdict means two different things and lumping
// them buries the live one. A boutique fulfilment still here needs its tracking NOW —
// the invoice and the customer's answer depend on it. A Bloomingdale's carton that has
// already shipped, been invoiced and been announced on a delivered 856 needs the same
// keystroke as BOOKKEEPING: the partner was told via the SSCC on the ASN, not via our
// UPS number, so nothing outside is broken. 19 backfill rows would otherwise hide 1
// live one.
const problems = results.filter((r) => !r.verdict.ok)
const live = problems.filter((r) => r.scope !== 'edi')
const backfill = problems.filter((r) => r.scope === 'edi')
const line = (r) => {
  const mark = r.verdict.kind === RECORD_GAP.AWAITING_INVOICE ? '·' : '✗'
  console.log(`  ${mark} ${pad(r.if_number, 9)} ${pad(r.verdict.kind, 18)} ${r.verdict.reason}`)
}
if (live.length) {
  console.log('  NEEDS A KEYSTROKE NOW — parcel lane, still ours to finish')
  live.forEach(line)
  console.log('')
}
if (backfill.length) {
  console.log(`  BOOKKEEPING — ${backfill.length} EDI carton(s) already shipped + announced (SSCC on the 856 is what the partner got)`)
  backfill.slice(0, 5).forEach(line)
  if (backfill.length > 5) console.log(`    … and ${backfill.length - 5} more`)
  console.log('')
}

console.log(`  recorded ................ ${counts.ok}`)
console.log(`  tracking not entered .... ${counts.trackingMissing}`)
console.log(`  tracking doesn't match .. ${counts.trackingMismatch}`)
console.log(`  freight figure missing .. ${counts.costMissing}`)
console.log(`  awaiting an invoice ..... ${counts.awaitingInvoice}   (a wait, not a task)`)
console.log(`  voided .................. ${counts.voided}`)

// What we paid, so the total is visible even where nothing is owed.
const paid = results.filter((r) => !r.voided).reduce((s, r) => s + Number(r.shipment_cost || 0), 0)
const free = results.filter((r) => !r.voided && !(Number(r.shipment_cost) > 0)).length
console.log(`\n  ${money(paid)} charged to us across ${labels.length} labels · ${free} billed to a third party`)

// ⚠️ THE SHIPPER ACCOUNT, WHICH IS NOT THE SAME QUESTION AS WHO PAYS. The tracking
// prefix names the account that CREATED the label: 1ZC6J610… is wholesale Big Box,
// 1Z18GE01… is the ecom account and the API's default. Third-party billing means the
// charge lands on Macy's either way — but if that billing is ever absent or refused,
// the fallback is whichever account issued the label. Same hazard upsRates.js exists
// to name, one step earlier.
const byAcct = {}
for (const r of results) {
  const a = /1Z([A-Z0-9]{6})/i.exec(r.tracking_number || '')?.[1]?.toUpperCase() || '(unknown)'
  byAcct[a] = (byAcct[a] || 0) + 1
}
console.log(`  shipper account by tracking prefix: ${Object.entries(byAcct).map(([a, n]) => `${a}×${n}`).join(' · ')}`)

console.log(counts.actionable
  ? `\n✗ ${counts.actionable} label(s) need a keystroke in NetSuite.\n`
  : '\n✓ Every bought label is recorded in NetSuite.\n')

await pool.end()
process.exit(counts.actionable ? 1 : 0)
