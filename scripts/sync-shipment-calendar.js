#!/usr/bin/env node
// npm run sync:calendar  [--write] [--max=N] [--po=7242978,...] [--lane=edi|boutique] [-v]
//
// Publishes each shipped PO to one of two Google calendars — "Naghedi Shipping — EDI"
// and "Naghedi Shipping — Boutique" — as an all-day event on the day the freight
// actually went, carrying the 856/810 document numbers and links to the signed
// paperwork in Drive (Nima, 2026-08-25).
//
// ⚠️ DRY BY DEFAULT — it prints the plan and writes NOTHING until you pass --write.
// This publishes to a calendar the warehouse reads, so the backfill gets inspected
// before it leaves. A dry run does not even CREATE the two calendars.

import { pool } from '../src/db.js'
import { loadCalendarCandidates, loadHeldCandidates } from '../server/queries.js'
import { syncShipmentCalendar, configured } from '../src/ingest/shipmentCalendarSync.js'
import { ACTION, SKIP_LABEL, CALENDAR_NAME, LANE } from '../src/model/shipmentCalendarPlan.js'
import { REASON_LABEL } from '../src/model/heldShipment.js'

const argv = process.argv.slice(2)
const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1] || null
const write = argv.includes('--write')
const verbose = argv.includes('-v') || argv.includes('--verbose')
const max = Number(arg('max')) || null
const poNumbers = (arg('po') || '').split(',').map((s) => s.trim()).filter(Boolean)
const laneArg = arg('lane')
const noHeld = argv.includes('--no-held')
const lanes = laneArg ? [laneArg] : [LANE.EDI, LANE.BOUTIQUE]

if (laneArg && !Object.values(LANE).includes(laneArg)) {
  console.error(`\n  --lane must be one of: ${Object.values(LANE).join(', ')}\n`)
  process.exit(2)
}
if (!configured()) {
  console.error('\n  Google is not configured — GOOGLE_CLIENT_ID / _SECRET / _REFRESH_TOKEN missing.')
  console.error('  Run scripts/connect-gmail.js to mint a token with the calendar scope.\n')
  process.exit(2)
}

const bar = '  ' + '─'.repeat(76)
console.log(`\n  Shipment calendar${write ? '' : '  (DRY RUN — nothing will be written)'}`)
console.log(bar)

const candidates = await loadCalendarCandidates({ max, poNumbers })
const loadErrors = candidates.filter((c) => c.loadError)
const driveErrors = candidates.filter((c) => c.driveError)
console.log(`  ${candidates.length} candidate PO(s) loaded`
  + (loadErrors.length ? ` · ⚠️ ${loadErrors.length} failed to load` : '')
  + (driveErrors.length ? ` · ⚠️ ${driveErrors.length} with Drive unreachable` : ''))

// ⚠️ TODAY IS COMPUTED HERE AND PASSED DOWN. The model never asks the clock — that is
// what makes the held calendar testable at all, and what stops "today" changing halfway
// through a run that spans midnight.
const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const held = noHeld ? null : await loadHeldCandidates()
const r = await syncShipmentCalendar({
  candidates: candidates.filter((c) => !c.loadError), held, todayIso, dryRun: !write, lanes,
})
const s = r.plan.summary

console.log('')
// ⚠️ The held calendar is listed too when it is in play — a calendar whose id and URL
// are never printed is one nobody can share, which is the entire point of publishing.
for (const lane of [...lanes, ...(r.held ? [LANE.HELD] : [])]) {
  const c = r.calendars[lane]
  if (!c) continue
  // ⚠️ "--write would create it" printed during an actual --write run, which read as a
  // dry-run notice while the run was in fact failing to create anything.
  const state = c?.missing ? (write ? '⚠️ MISSING — it was NOT created; see the errors below' : 'does not exist yet — --write would create it')
    : c?.created ? `created  ${c.id}` : `${c.id}`
  console.log(`  ${CALENDAR_NAME[lane].padEnd(30)} ${state}`)
  if (c?.url && !c?.missing) console.log(`  ${' '.repeat(30)} ${c.url}`)
}

console.log('')
console.log(`  create ${s.create}   ·   update ${s.update}   ·   unchanged ${s.unchanged}   ·   skip ${s.skip}`)
console.log(`  EDI ${s.byLane[LANE.EDI]}  ·  Boutique ${s.byLane[LANE.BOUTIQUE]}`)
// ⚠️ Said out loud, because an unproven entry is titled "ship date recorded", not
// "shipped" — the reader of this summary is the person deciding whether to publish.
console.log(`  proven ${s.proven}  ·  ⚠️ our own record only ${s.unproven}`)
if (s.paperworkUnchecked) {
  // ⚠️ These events say "Signed paperwork: not checked", NOT "none filed" — Drive is
  // searched under the partner the file was filed beneath, and these POs resolve no
  // such partner. Said here because a caveat living only inside the event bodies is
  // one nobody reads before deciding to publish.
  console.log(`  ⚠️ ${s.paperworkUnchecked} event(s) could not check Drive for paperwork (no partner on file)`)
}

if (s.skip) {
  console.log('\n  Skipped:')
  for (const [reason, n] of Object.entries(s.skips)) console.log(`    ${String(n).padStart(4)}  ${SKIP_LABEL[reason] || reason}`)
}

if (r.held) {
  const h = r.held.summary
  console.log('')
  console.log(`  ${CALENDAR_NAME[LANE.HELD]}   (everything on our floor, dated ${todayIso})`)
  console.log(`  create ${h.create}   ·   update ${h.update}   ·   unchanged ${h.unchanged}   ·   remove ${h.remove}`)
  const reasons = Object.entries(h.byReason).map(([k, n]) => `${n} ${REASON_LABEL[k] || k}`).join('  ·  ')
  if (reasons) console.log(`  ${reasons}`)
  if (h.oldest != null) console.log(`  oldest has been sitting ${h.oldest} day(s)`)
  const moved = r.held.entries.filter((e) => e.action === ACTION.REMOVE && e.reason === 'shipped')
  if (moved.length) console.log(`  → ${moved.length} shipped and will MOVE off this calendar`)
  const stale = r.held.entries.filter((e) => e.action === ACTION.REMOVE && e.reason === 'no-longer-held')
  if (stale.length) console.log(`  → ${stale.length} no longer held, removed`)
  if (verbose) for (const e of r.held.entries) {
    if (e.action === ACTION.REMOVE) { console.log(`    remove    ${String(e.key).padEnd(14)} ${e.reason}`); continue }
    if (e.action === ACTION.SKIP) continue
    console.log(`    ${e.action.padEnd(9)} ${String(e.so ?? e.key).padEnd(14)} ${String(e.daysHeld ?? '?').padStart(3)}d  ${e.summary}`)
  }
}

if (r.plan.misfiled.length) {
  console.log(`\n  ⚠️  ${r.plan.misfiled.length} PO(s) have a stale twin in the OTHER calendar (lane changed).`)
  console.log('     Not deleted automatically — removing an entry from a shared calendar is your call:')
  for (const m of r.plan.misfiled.slice(0, 10)) console.log(`       ${m.po}  stale in ${m.staleIn}, belongs in ${m.belongsIn}`)
}

if (verbose) {
  console.log('\n  Plan:')
  for (const e of r.plan.entries) {
    if (e.action === ACTION.SKIP) { console.log(`    skip      ${String(e.po).padEnd(12)} ${SKIP_LABEL[e.reason] || e.reason}`); continue }
    console.log(`    ${e.action.padEnd(9)} ${String(e.po).padEnd(12)} ${e.date}  ${e.lane.padEnd(8)} ${e.proven ? '' : '⚠ '}${e.summary}`)
  }
}

if (loadErrors.length) {
  console.log('\n  ⚠️  Failed to load (NOT published, and not counted as "nothing to say"):')
  for (const c of loadErrors.slice(0, 10)) console.log(`       ${c.po}  ${c.loadError}`)
}
if (driveErrors.length) {
  console.log(`\n  ⚠️  Drive did not answer for ${driveErrors.length} PO(s) — their events would claim`)
  console.log('     "No signed paperwork filed" when paperwork may well exist. Re-run before trusting those.')
  for (const c of driveErrors.slice(0, 5)) console.log(`       ${c.po}  ${c.driveError}`)
}

if (write) {
  // ⚠️ BROKEN DOWN BY CALENDAR. A single "wrote 19" hid that 23 planned held entries
  // wrote nothing at all — the total matched the shipped lanes exactly and looked right.
  const per = {}
  for (const x of r.results.filter((x) => x.ok)) per[x.lane] = (per[x.lane] || 0) + 1
  console.log(`\n  wrote ${r.wrote} event(s)` + (r.failed ? `, ⚠️ ${r.failed} failed` : ''))
  for (const lane of Object.keys(CALENDAR_NAME)) {
    const planned = lane === LANE.HELD
      ? (r.held?.entries.filter((e) => e.action !== ACTION.UNCHANGED && e.action !== ACTION.SKIP).length ?? 0)
      : r.plan.entries.filter((e) => e.lane === lane && (e.action === ACTION.CREATE || e.action === ACTION.UPDATE)).length
    if (!planned && !per[lane]) continue
    const got = per[lane] || 0
    console.log(`    ${CALENDAR_NAME[lane].padEnd(36)} ${String(got).padStart(4)} written of ${planned} planned`
      + (got < planned ? '   ⚠️ SHORT' : ''))
  }
  for (const f of r.results.filter((x) => !x.ok).slice(0, 10)) console.log(`       ${f.po}  ${f.error}`)
} else {
  console.log('\n  Nothing was written. Re-run with --write to publish this plan.')
}
console.log('')

await pool.end()
