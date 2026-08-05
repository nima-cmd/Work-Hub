// scripts/check-counters.js — does every counter still MEAN what it says?
// Run: npm run check:counters      (needs .env.local — reads Neon, writes nothing)
//
// WHY THIS EXISTS
//
// Every bug this app has shipped in its counters has been one of four shapes,
// and each was found by accident, one per session, by rendering the number and
// squinting at it:
//
//   (i)   STRUCTURALLY UNREACHABLE — a branch that cannot ever be true, so the
//         number is a constant pretending to be a measurement.
//         · INVOICED_PENDING_PAYMENT / APPROVED_FOR_SHIPPING: 0 of 238 orders,
//           ever, because promotion keyed off a stage only the retired CSV
//           mappers set (PR #48).
//         · credits.waiting: gated on `packed_status IS NOT NULL`, which is null
//           on 0 of 70 unshipped fulfilments — so the header read "0 CR WAITING"
//           while $7,593.60 sat parked in the bay (found by this audit).
//   (ii)  COUNTS SOMETHING ELSE than its label claims — "4 need an invoice" while
//         all four had one (PR #48); "62 ASNs never sent" that were all re-sends
//         of shipments already accepted (PR #36).
//   (iii) KEYED ON A HAND-SET OR DISPLAY FIELD where an objective one exists —
//         the day plan's bench gated on channelKey(), a display classifier, which
//         hid SO12344 entirely (PR #50); "needs a label" keyed so that China/FOB
//         shipments demanded a label nobody will ever make (PR #50).
//   (iv)  A COMMENT PROMISING A MECHANISM no code implements — HELD_FOR_PAYMENT's
//         "a silent filter would bury it" safety net (PR #48), netsuiteSync's
//         "that is how an order gets promoted" (PR #48), and main.jsx's "dev has
//         no sw.js" (PR #51).
//
// Shapes (i) and (ii) are mechanically checkable, and that is all this script
// tries to do. Two kinds of assertion, both cheap:
//
//   PARTITION — a family of counters must exactly account for its own item list.
//     A kind that never fires, or an item counted under two kinds, breaks the sum.
//     This is what makes "the never-lump rule" enforceable rather than aspirational.
//   FLOOR     — if something plainly exists, the counter that reports it must not
//     be zero. Deliberately weaker than re-deriving the number: re-implementing a
//     scope in the checker just creates a second copy to drift. A floor catches
//     the dead gate without pretending to know the exact answer.
//
// It does NOT try to check shapes (iii) and (iv) — those need judgement and a
// human reading the field's provenance. What it does mean is that no counter can
// go structurally dead again without something saying so out loud.
import * as Q from '../server/queries.js'
import { pool } from '../src/db.js'
import { LIVE_SYNCS } from '../src/model/syncHealth.js'
import { FILING_LEDGER_START } from '../src/model/filing.js'

const results = []
const ok = (name, detail = '') => results.push({ pass: true, name, detail })
const bad = (name, detail) => results.push({ pass: false, name, detail })

const partition = (name, parts, total, note = '') => {
  const sum = parts.reduce((n, p) => n + Number(p || 0), 0)
  if (sum === Number(total)) ok(name, `${sum} = ${total}${note ? ' · ' + note : ''}`)
  else bad(name, `parts sum to ${sum} but the list holds ${total}${note ? ' · ' + note : ''}`)
}

// A counter may only be zero when there is genuinely nothing to report.
const floor = (name, value, existsCount, detail) => {
  if (Number(value) > 0 || Number(existsCount) === 0) ok(name, detail)
  else bad(name, `reads ${value} while ${detail}`)
}

// ── label gaps: the court strip's busiest family ─────────────────────────────
const lg = await Q.getLabelGaps({})
partition('labelGaps kinds account for every packed-not-shipped IF',
  [lg.counts.labelledNotShipped, lg.counts.needsLabel, lg.counts.freight,
    lg.counts.fobPickup, lg.counts.heldForPayment],
  lg.items.length,
  'a new lane that never fires, or an IF counted twice, breaks this')

// ── the Launch Bay + the header counter that must agree with it ──────────────
const bay = await Q.getLaunchBay()
const KNOWN_STATES = new Set(['approved', 'payment', 'invoice', 'scanned_in', 'other'])
const strange = bay.filter((s) => !KNOWN_STATES.has(s.state)).map((s) => s.ifNumber)
strange.length
  ? bad('every bay ship has a known state', `unrecognised: ${strange.join(', ')}`)
  : ok('every bay ship has a known state', `${bay.length} ships`)

// `floating` is what the "can ship" chip counts, and it is defined as
// state === 'approved'. If those two ever diverge the chip is measuring nothing.
const floatingMismatch = bay.filter((s) => s.floating !== (s.state === 'approved'))
floatingMismatch.length
  ? bad('bay `floating` still means state=approved', `${floatingMismatch.length} rows disagree`)
  : ok('bay `floating` still means state=approved', `${bay.filter((s) => s.floating).length} floating`)

// The header's "waiting" figure. Floor, not equality: the bay owns the scope
// (notably excluding China/FOB, which never sits on our dock), so the checker
// only insists that parked money cannot read as zero.
const { rows: owing } = await pool.query(`
  SELECT COUNT(*) n, COALESCE(SUM(i.amount_remaining), 0) owed
  FROM fulfillments f
  JOIN invoices i ON i.inv_number = f.invoice_number
  LEFT JOIN orders o ON o.so_number = f.so_number
  WHERE f.actual_ship_date IS NULL
    AND COALESCE(o.location, '') NOT ILIKE '%china%'
    AND i.amount_remaining > 0`)
const credits = await Q.getCredits()
floor('header `waiting` is not structurally dead', credits.waiting, owing[0].n,
  `${owing[0].n} unshipped non-China IF(s) owe $${Number(owing[0].owed).toLocaleString()}`)

// The departures board and the bay must be the SAME list. They were two copies
// of "what's on the dock" and only one got the 2026-07-17 rework, so the board
// spent a year listing shipments that had already left (6–29 days prior) and
// hiding all 70 still here. Now it delegates — this asserts it still does.
const dep = await Q.getShipDepartures({})
dep.length === bay.length && dep.every((d, i) => d.ifNumber === bay[i].ifNumber)
  ? ok('ship departures is the launch bay, not a second copy', `${dep.length} ships`)
  : bad('ship departures is the launch bay, not a second copy',
    `departures has ${dep.length} rows, bay has ${bay.length} — they have diverged again`)

// Nothing on a departures board may already have departed. This is the assertion
// the old query would have failed on all 8 of its rows.
const gone = dep.filter((d) => d.actualShipDate)
gone.length
  ? bad('nothing on the departures board has already shipped',
    `${gone.length} departed row(s): ${gone.slice(0, 5).map((d) => d.ifNumber).join(', ')}`)
  : ok('nothing on the departures board has already shipped', `${dep.length} still here`)

// ── filing, cartons, overdue money, EDI delivery, inbound ───────────────────
const unf = await Q.getUnfiledPaper({})
partition('unfiled paper: due + backlog account for both lists',
  [unf.counts.due, unf.counts.backlog], unf.due.length + unf.backlog.length,
  'the due/backlog split must never lose or double a shipment')

const ac = await Q.getAsnCartonCheck()
partition('every packed carton is either matched to an SSCC or undeclared',
  [ac.counts.matched, ac.counts.undeclared], ac.counts.packed)

const od = await Q.getOverdueInvoices({})
partition('overdue invoices: summary count matches the list',
  [od.summary.count], od.items.length)
partition('overdue invoices: every row lands in exactly one inquiry bucket',
  [od.summary.neverBilled, od.summary.unknown810, od.summary.unknownSource, od.summary.chasePayment],
  od.summary.count)

const eg = await Q.getEdiDeliveryGaps({})
// A stuck document is either a genuine non-announcement or a superseded re-send.
// That split IS the PR #36 finding; if it stops partitioning, the strip has gone
// back to claiming chargeback exposure it cannot support.
partition('stuck ASNs split cleanly into unannounced vs re-sent',
  [eg.counts.asnUnannounced, eg.counts.asnResent], eg.counts.asnStuck)
partition('stuck invoices split cleanly into unannounced vs re-sent',
  [eg.counts.invoiceUnannounced, eg.counts.invoiceResent], eg.counts.invoiceStuck)

const inb = await Q.getInboundContainers({})
const inbTotal = inb.containers.length
inb.counts.late + inb.counts.awaiting <= inbTotal
  ? ok('inbound late + awaiting fit inside the container list',
    `${inb.counts.late} + ${inb.counts.awaiting} <= ${inbTotal}`)
  : bad('inbound late + awaiting fit inside the container list',
    `${inb.counts.late} + ${inb.counts.awaiting} > ${inbTotal}`)

// ── promises that were only comments (shape iv) ──────────────────────────────
// Each of these was an assertion in prose that nothing verified. A comment
// claiming a scope rule is not the scope rule — that is how a page ended up
// listing shipments that had already left, and how the header's `waiting` figure
// spent its life at zero. Cheap to assert, so now they are asserted.

// queries.js: "Placeholder orders are EXCLUDED here, at the single read path
// every work view uses."
const orders = await Q.getOrders()
const { rows: phRows } = await pool.query(`SELECT COUNT(*) n FROM orders WHERE is_placeholder IS TRUE`)
const leaked = orders.filter((o) => o.isPlaceholder).length
leaked
  ? bad('placeholder orders never reach getOrders', `${leaked} leaked`)
  : ok('placeholder orders never reach getOrders', `${phRows[0].n} placeholder(s) held back`)

// queries.js: "China-Warehouse orders are EXCLUDED — they ship FOB direct."
const chinaInBay = bay.filter((s) => /china/i.test(s.location || '')).map((s) => s.ifNumber)
chinaInBay.length
  ? bad('China/FOB never appears on the dock', `present: ${chinaInBay.join(', ')}`)
  : ok('China/FOB never appears on the dock', 'collected abroad, has its own lane')

// filing.js: shipments that departed before the epoch "are never counted as due".
// Both directions, because the split is only honest if neither side leaks.
const epoch = new Date(FILING_LEDGER_START)
const preEpochDue = unf.due.filter((r) => new Date(r.shippedAt) < epoch).length
const postEpochBacklog = unf.backlog.filter((r) => new Date(r.shippedAt) >= epoch).length
preEpochDue || postEpochBacklog
  ? bad('the filing epoch split leaks in neither direction',
    `${preEpochDue} pre-epoch in due, ${postEpochBacklog} post-epoch in backlog`)
  : ok('the filing epoch split leaks in neither direction', `epoch ${FILING_LEDGER_START}`)

// queries.js: held-for-payment rows are "never added to any actionable number".
// The headline age is the one that would quietly absorb them.
const maxHeldAge = Math.max(0, ...lg.heldForPayment.map((h) => h.ageDays ?? 0))
const maxActionable = Math.max(0, ...[...lg.needsLabel, ...lg.labelledNotShipped].map((h) => h.ageDays ?? 0))
lg.oldestAgeDays === maxActionable
  ? ok('the headline age ignores parked and non-parcel lanes',
    `oldest ${lg.oldestAgeDays} = oldest actionable ${maxActionable} (oldest held is ${maxHeldAge})`)
  : bad('the headline age ignores parked and non-parcel lanes',
    `oldest ${lg.oldestAgeDays} but oldest actionable is ${maxActionable}`)

// ── sync health: a sync that silently stops being reported reads as healthy ──
const sh = await Q.getSyncHealth()
const reported = new Set(sh.syncs.map((s) => s.key))
const missing = LIVE_SYNCS.map((s) => s.key).filter((k) => !reported.has(k))
missing.length
  ? bad('every LIVE sync is reported on Health', `absent: ${missing.join(', ')}`)
  : ok('every LIVE sync is reported on Health', `${LIVE_SYNCS.length} live syncs`)

// ── report ──
const failed = results.filter((r) => !r.pass)
console.log('\n  COUNTER TRUTH CHECK\n  ' + '─'.repeat(72))
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}`)
  if (r.detail) console.log(`      ${r.detail}`)
}
console.log('  ' + '─'.repeat(72))
console.log(`  ${results.length - failed.length}/${results.length} checks pass` +
  (failed.length ? ` · ${failed.length} FAILED` : ' · every counter still means what it says'))
console.log()

await pool.end()
process.exit(failed.length ? 1 : 0)
