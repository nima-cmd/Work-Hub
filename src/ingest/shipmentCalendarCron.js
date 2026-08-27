// src/ingest/shipmentCalendarCron.js — keep the three calendars true, hourly.
//
// ⚠️ THIS IS NOT AN OPTIMISATION, IT IS WHAT MAKES THE WAREHOUSE CALENDAR HONEST.
// Its entries are dated TODAY and roll forward (there is no trustworthy predicted ship
// date — orders.ship_date is start_date + 28 on 100% of rows). Nobody running the sync
// for a day means 30-odd entries sitting on yesterday, each claiming to be current. A
// shared calendar that quietly goes stale is worse than no calendar.
//
// ⚠️ AND A FULL SWEEP MUST NEVER RUN HERE. Measured 2026-08-27: the whole shipped
// backfill is 293 shipments at ~0.9s each = 263 SECONDS, against a one-vCPU box that is
// already running NetSuite, Orderful, Gmail and the warehouse feeds in the same request.
// CLAUDE.md's warning about what this cron costs was written after it nearly killed the
// database; this stays inside its budget by looking only at what changed.
//
//   held      always      32 rows, 467ms — the part that decays daily
//   shipped   incremental  7 shipments in an hour ≈ 6s
//
// The CLI (npm run sync:calendar) still does the full sweep, which is where a backfill
// belongs.

import { syncShipmentCalendar, configured } from './shipmentCalendarSync.js'

export const WATERMARK = 'shipment_calendar_through'

// ⚠️ First run has no watermark, and it must NOT fall back to "everything" — that is
// the 263-second sweep, inside the cron, on the box's first hour. A bounded window
// instead, and the result says it was the first run so a thin result is not mistaken
// for a quiet one.
const FIRST_RUN_HOURS = 24

// ⚠️ The window OVERLAPS by design. A transition committed a moment after the previous
// run read the clock, but before its transaction became visible, falls in the gap
// between two exact windows and is never seen again — the classic watermark bug, and
// silent. Re-examining a few minutes twice is free: the plan reports `unchanged`.
const OVERLAP_MS = 10 * 60 * 1000

export async function syncCalendarIncremental({
  loadCalendarCandidates, loadHeldCandidates, loadTransferCandidates, getSyncMeta, setSyncMeta,
  now = new Date(), sync = syncShipmentCalendar, isConfigured = configured,
} = {}) {
  if (!isConfigured()) return { configured: false, skipped: 'google-not-configured' }

  // ⚠️ Stamped BEFORE the work, never after. A run that takes 40s and then records its
  // FINISH time silently swallows every transition that landed while it was running.
  const startedAt = new Date(now)

  const raw = await getSyncMeta(WATERMARK)
  const firstRun = !raw
  const previous = firstRun ? new Date(startedAt.getTime() - FIRST_RUN_HOURS * 3600 * 1000) : new Date(raw)
  const since = new Date(previous.getTime() - OVERLAP_MS)

  // ⚠️ Transfers are read in FULL every run, like the warehouse calendar and unlike the
  // shipped lanes. There are 14 of them — one cheap query — and their entries move
  // between "not shipped", "in transit" and "received" without any 856/810 or
  // order_event to notice, so an incremental window would never see the change.
  const [changed, held, transfers] = await Promise.all([
    loadCalendarCandidates({ since }),
    loadHeldCandidates(),
    loadTransferCandidates ? loadTransferCandidates() : Promise.resolve(null),
  ])

  const todayIso = startedAt.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
  const result = await sync({
    candidates: changed.filter((c) => !c.loadError),
    held, transfers, todayIso, dryRun: false,
  })

  // ⚠️ ADVANCED ONLY ON A CLEAN RUN. Moving the watermark past a window whose writes
  // partly failed means those shipments are never revisited — the calendar keeps a
  // wrong entry forever and nothing ever looks at it again. A repeated window is
  // cheap; a skipped one is invisible.
  const clean = result.failed === 0
  if (clean) await setSyncMeta(WATERMARK, startedAt.toISOString())

  return {
    configured: true,
    firstRun,
    since: since.toISOString(),
    watermarkAdvanced: clean,
    changedShipments: changed.length,
    loadErrors: changed.filter((c) => c.loadError).length,
    heldCount: held.length,
    transferCount: transfers?.length ?? 0,
    wrote: result.wrote,
    failed: result.failed,
    shipped: result.plan?.summary || null,
    heldPlan: result.held?.summary || null,
    transferPlan: result.transfers?.summary || null,
  }
}


// ── Detached, the way startAsnCartonCheck is ────────────────────────────────
//
// ⚠️ THE CRON REQUEST MUST NOT WAIT FOR THIS. Measured on the first real run: the
// calendar leg took the whole recurring-check from ~50s to 319s, because a 24-hour
// backlog was 55 shipments and each costs ~4s of Drive and NetSuite round trips. A
// steady hourly run is ~7 shipments, but a backlog — the cron down for a day, a
// weekend of scanning — puts it right back there, and a five-minute synchronous
// request on one vCPU is competing with serving the app to the person who is waiting.
//
// So the response reports that it STARTED, not what it found. The watermark is the
// durable record: it only advances on a clean run, so nothing is lost by not watching.
//
// ⚠️ The in-flight flag is what stops a slow run from being re-entered by the next
// hour's cron and doing the same work twice, concurrently, against the same calendars.
let inFlight = false

export function calendarSyncInFlight() { return inFlight }

export function startCalendarIncremental(deps = {}) {
  if (inFlight) return { skipped: 'already running' }
  inFlight = true
  syncCalendarIncremental(deps)
    .then((r) => console.log('shipment calendar:', JSON.stringify(r)))
    .catch((e) => console.error('shipment calendar sync failed:', e.message))
    .finally(() => { inFlight = false })
  return { started: true }
}
