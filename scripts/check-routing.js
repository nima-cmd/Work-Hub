#!/usr/bin/env node
// npm run check:routing
//
// Is every routing card's authorization accounted for — and is the lane that reads
// them actually running?
//
// ⚠️ THIS CHECK EXISTS BECAUSE A MISSED EMAIL WAS SILENT. Until 2026-08-13 nothing in
// this app read the Macy's routing notification at all, and because Nima had always
// keyed them by hand the lane LOOKED automated. A card sat on "Needs routing" and no
// surface could say whether the authorization had not arrived, had arrived and been
// missed, or had never been looked for.
//
// Exits 1 when there is something a human must do:
//   · a card is waiting on an authorization that is ALREADY IN THE MAILBOX
//   · a notification matched on one key but not the other (a mistyped reference)
//   · a notification's own subject/body checksum failed
//   · the lane has never run, or has gone quiet for more than a day
//
// Exits 0 on a quiet lane — and says "we looked and there was nothing", which is a
// different sentence from "nothing looked".

import { pool } from '../src/db.js'
import { reconcileMacysRouting, lastCheckedAt } from '../src/ingest/macysRouting.js'
import { summarizeRoutingMisses, MISS } from '../src/model/macysRouting.js'
import { authProvenance, AUTH_STATE } from '../src/model/routingAuthSource.js'

const STALE_HOURS = 24

const [{ checksumFailed, shipments, reports }, checkedAt] = await Promise.all([
  reconcileMacysRouting({}),
  lastCheckedAt(),
])

console.log('\n  Macy\'s routing notifications vs the routing board')
console.log(`  ${'─'.repeat(72)}`)

let bad = 0

// ── 1. is the reader running at all? ─────────────────────────────────────────
const ageH = checkedAt ? (Date.now() - new Date(checkedAt).getTime()) / 3_600_000 : null
if (!checkedAt) {
  bad++
  console.log('  ✗ the routing-notification reader has NEVER run — run `npm run sync:routing`')
} else if (ageH > STALE_HOURS) {
  bad++
  console.log(`  ✗ last read ${Math.round(ageH)}h ago (over ${STALE_HOURS}h) — the caller on ` +
    'POST /api/internal/recurring-check is not firing')
} else {
  console.log(`  ✓ read ${ageH < 1 ? 'less than an hour' : `${Math.round(ageH)}h`} ago`)
}

// ── 2. cards still waiting, and whether their authorization is already here ──
const live = shipments.filter((s) => !s.shippedAt)
const unauthorized = live.filter((s) => !s.authNumber)
const inMailbox = new Map()
for (const { notification: n, plan } of reports) {
  for (const a of plan.applies) inMailbox.set(a.shipmentId, n)
}

console.log(`\n  ${live.length} live Macy's-family card(s) · ${unauthorized.length} without an authorization`)
for (const s of unauthorized) {
  const n = inMailbox.get(s.id)
  const p = authProvenance({ shipment: s, notification: n || null })
  if (n) {
    bad++
    console.log(`  ✗ ${s.bolNumber || `#${s.id}`} ${s.dc}: authorization ${n.authNumber} is IN THE ` +
      'MAILBOX but not on the card — the sync should have applied it')
  } else if (p.state === AUTH_STATE.NO_REFS) {
    console.log(`  · ${s.bolNumber || `#${s.id}`} ${s.dc}: ${p.detail}`)
  } else {
    console.log(`  · ${s.bolNumber || `#${s.id}`} ${s.dc}: ${p.detail}`)
  }
}

// ── 3. references that matched on one key only ───────────────────────────────
const oneKey = reports.flatMap((r) => r.plan.misses)
  .filter((m) => m.kind === MISS.PROJECT_ONLY || m.kind === MISS.SHIPMENT_ONLY)
if (oneKey.length) {
  bad += oneKey.length
  console.log(`\n  ✗ ${oneKey.length} reference(s) matched on ONE key only — one side is mistyped:`)
  for (const m of oneKey) console.log(`      ${m.detail}`)
}

const unpaired = reports.flatMap((r) => r.plan.misses).filter((m) => m.kind === MISS.UNPAIRED)
if (unpaired.length) {
  bad += unpaired.length
  console.log(`\n  ✗ ${unpaired.length} block(s) whose project/shipment counts disagreed — ` +
    'nothing was paired, key them by hand:')
  for (const m of unpaired) console.log(`      ${m.detail}`)
}

if (checksumFailed.length) {
  bad += checksumFailed.length
  console.log(`\n  ✗ ${checksumFailed.length} notification(s) whose body does not account for every ` +
    `project in their subject: ${checksumFailed.join(', ')}`)
}

// ── 4. things worth seeing but not worth failing on ──────────────────────────
const notes = reports.flatMap((r) => r.plan.misses)
  .filter((m) => m.kind === MISS.AUTH_CONFLICT || m.kind === MISS.DC_DISAGREES || m.kind === MISS.SHIP_DATE_DEPARTED)
if (notes.length) {
  console.log(`\n  ${notes.length} note(s) — a human decided these, so they do not fail the check:`)
  for (const m of notes.slice(0, 15)) console.log(`      ${m.detail}`)
  if (notes.length > 15) console.log(`      … and ${notes.length - 15} more`)
}

const s = summarizeRoutingMisses(reports.map((r) => r.plan))
console.log(`\n  ${'─'.repeat(72)}`)
console.log(`  ${s.notifications} notification(s) · ${s.outOfScope} historical · ` +
  `${s.applied} card(s) currently matched`)
console.log(bad
  ? `  ✗ ${bad} thing(s) need a human\n`
  : '  ✓ every card\'s authorization is accounted for, and the reader is live\n')

await pool.end()
process.exit(bad ? 1 : 0)
