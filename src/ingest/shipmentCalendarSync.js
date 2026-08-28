// src/ingest/shipmentCalendarSync.js — push shipment events to the two Google
// calendars. The CLI and (later) the cron share this, the way asnCartonSync is shared.
//
// ⚠️ CANDIDATES ARE AN INPUT, NOT SOMETHING THIS FETCHES. Nothing in src/ imports from
// server/ anywhere in this repo, and assembling the evidence here would mean a SECOND
// implementation of "did this PO ship" — the calendar could then disagree with the
// proof panel the app shows for the same PO, which is the one thing a shared calendar
// must never do. server/queries.js owns that query; the caller passes the result in.
// It also means the whole sync is testable with a plain array and no database.
//
// ⚠️ DRY BY DEFAULT. Every entry point defaults dryRun:true and the caller must ask for
// a write. This publishes to a calendar the warehouse reads.

import { getAccessToken, ensureCalendar, fetchOwnedEvents, upsertEvent, deleteEvent, calendarUrl } from './googleCalendarWrite.js'
import { planShipmentCalendar, planHeldCalendar, planTransferCalendar, summarize, CALENDAR_NAME, LANE, ACTION } from '../model/shipmentCalendarPlan.js'

export const configured = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN)

/**
 * @param candidates [{ po, partner, customer, location, evidence, shipDates }]
 * @param dryRun     true (default) → resolve calendars + compute the plan, write nothing
 * @param lanes      restrict to one lane, e.g. ['edi']
 * @param deps       injected for tests
 */
export async function syncShipmentCalendar({
  candidates = [],
  held = null,          // loadHeldCandidates() output; null = do not touch that calendar
  transfers = null,     // loadTransferCandidatesWithScans() output; null = skip that calendar
  todayIso = null,      // the day held entries sit on — an INPUT, never Date.now() here
  dryRun = true,
  lanes = [LANE.EDI, LANE.BOUTIQUE],
  deps = {},
} = {}) {
  const g = { getAccessToken, ensureCalendar, fetchOwnedEvents, upsertEvent, deleteEvent, ...deps }

  if (!configured()) {
    return { configured: false, dryRun, calendars: {}, plan: { entries: [], summary: null, misfiled: [] }, results: [] }
  }
  const token = await g.getAccessToken()

  const inLanes = new Set(lanes)
  // ⚠️ THE HELD LANE IS AUTHORISED BY `held`, NOT BY `lanes`, and conflating the two
  // meant the warehouse calendar could never be created. `lanes` defaults to the two
  // SHIPPED lanes, creation was gated on `inLanes.has(lane)`, so HELD always resolved
  // with create:false — even under --write. The plan then printed "create 23" and the
  // publish loop dropped every one of them because the calendar had no id. A run that
  // reports a plan and silently executes none of it is worse than one that fails.
  const writeLanes = new Set([...lanes,
    ...(held ? [LANE.HELD] : []), ...(transfers ? [LANE.TRANSFER] : [])])

  // ⚠️ RESOLVED FOR BOTH LANES EVEN WHEN ONLY ONE IS BEING WRITTEN, because the
  // stale-twin check below is a question about the OTHER calendar. Reading only the
  // requested lane left `existing[otherLane]` permanently empty, so misfiled could
  // never fire on a --lane run — a comment describing a mechanism no code implemented,
  // which is bug shape #4 in this repo. Caught by the test, not by a wrong calendar.
  //
  // ⚠️ A DRY RUN CREATES NOTHING, INCLUDING THE CALENDARS. Creating them "so the plan
  // is realistic" would make --dry leave two permanent artefacts in his account — a
  // dry run with a side effect is not a dry run. Nor does a --lane=edi run create the
  // Boutique calendar it only reads.
  const ALL_LANES = [LANE.EDI, LANE.BOUTIQUE,
    ...(held ? [LANE.HELD] : []), ...(transfers ? [LANE.TRANSFER] : [])]
  const calendars = {}
  for (const lane of ALL_LANES) {
    calendars[lane] = await g.ensureCalendar(token, CALENDAR_NAME[lane], { create: writeLanes.has(lane) && !dryRun })
  }

  // What each calendar already holds. A calendar that does not exist yet holds nothing.
  const existing = {}
  for (const lane of ALL_LANES) existing[lane] = await g.fetchOwnedEvents(token, calendars[lane]?.id)
  const plan = planShipmentCalendar({ candidates, existing })
  // Entries outside the requested lanes are dropped AFTER planning, so a --lane run
  // still detects a twin sitting in the lane it is not writing to.
  plan.entries = plan.entries.filter((e) => !e.lane || inLanes.has(e.lane))
  plan.summary = summarize(plan.entries)

  const results = []
  if (!dryRun) {
    for (const e of plan.entries) {
      if (e.action !== ACTION.CREATE && e.action !== ACTION.UPDATE) continue
      const calId = calendars[e.lane]?.id
      if (!calId) continue
      try {
        const r = await g.upsertEvent(token, calId, e.event, { update: e.action === ACTION.UPDATE })
        results.push({ po: e.po, lane: e.lane, key: e.key, ok: true, mode: r.mode })
      } catch (err) {
        // ⚠️ One bad event must not abandon the other 249. Recorded per-PO and the
        // caller reports the failures — a partial calendar you KNOW is partial is
        // recoverable; one that stopped silently at item 12 is not.
        results.push({ po: e.po, lane: e.lane, key: e.key, ok: false, error: err.message })
      }
    }
  }

  // ── the warehouse calendar ────────────────────────────────────────────────
  // ⚠️ PLANNED AFTER the shipped lanes, because it needs the keys they are publishing
  // this run: a shipment appearing on a shipped calendar is precisely what makes its
  // held entry stale. Planning them independently would leave both live for an hour.
  let heldPlan = null
  if (held) {
    const shippedKeys = new Set(
      plan.entries.filter((e) => e.action === ACTION.CREATE || e.action === ACTION.UPDATE || e.action === ACTION.UNCHANGED)
        .map((e) => e.key).filter(Boolean))
    heldPlan = planHeldCalendar({
      candidates: held, existing: existing[LANE.HELD] || new Map(), shippedKeys, todayIso,
    })
    if (!dryRun) {
      const calId = calendars[LANE.HELD]?.id
      // ⚠️ SAID OUT LOUD, NEVER `break`. Losing the whole plan because the calendar has
      // no id is precisely the failure above, and a bare break made it invisible.
      if (!calId) {
        results.push({ lane: LANE.HELD, ok: false, error:
          `${CALENDAR_NAME[LANE.HELD]} could not be resolved or created — ${heldPlan.entries.length} held entr(ies) were NOT written.` })
      }
      for (const e of calId ? heldPlan.entries : []) {
        try {
          if (e.action === ACTION.REMOVE) {
            await g.deleteEvent(token, calId, e.key)
            results.push({ so: e.so, lane: LANE.HELD, key: e.key, ok: true, mode: 'remove' })
          } else if (e.action === ACTION.CREATE || e.action === ACTION.UPDATE) {
            const r = await g.upsertEvent(token, calId, e.event, { update: e.action === ACTION.UPDATE })
            results.push({ so: e.so, lane: LANE.HELD, key: e.key, ok: true, mode: r.mode })
          }
        } catch (err) {
          results.push({ so: e.so, lane: LANE.HELD, key: e.key, ok: false, error: err.message })
        }
      }
    }
  }

  // ── the transfers calendar ────────────────────────────────────────────────
  let transferPlan = null
  if (transfers) {
    transferPlan = planTransferCalendar({
      transfers, existing: existing[LANE.TRANSFER] || new Map(), todayIso,
    })
    if (!dryRun) {
      const calId = calendars[LANE.TRANSFER]?.id
      if (!calId) {
        results.push({ lane: LANE.TRANSFER, ok: false, error:
          `${CALENDAR_NAME[LANE.TRANSFER]} could not be resolved or created — ${transferPlan.entries.length} entr(ies) were NOT written.` })
      }
      for (const e of calId ? transferPlan.entries : []) {
        try {
          if (e.action === ACTION.REMOVE) {
            await g.deleteEvent(token, calId, e.key)
            results.push({ so: e.toNumber, lane: LANE.TRANSFER, key: e.key, ok: true, mode: 'remove' })
          } else if (e.action === ACTION.CREATE || e.action === ACTION.UPDATE) {
            const r = await g.upsertEvent(token, calId, e.event, { update: e.action === ACTION.UPDATE })
            results.push({ so: e.toNumber, lane: LANE.TRANSFER, key: e.key, ok: true, mode: r.mode })
          }
        } catch (err) {
          results.push({ so: e.toNumber, lane: LANE.TRANSFER, key: e.key, ok: false, error: err.message })
        }
      }
    }
  }

  return {
    configured: true,
    dryRun,
    held: heldPlan,
    transfers: transferPlan,
    calendars: Object.fromEntries(Object.entries(calendars).map(([l, c]) => [l, { ...c, url: c?.id ? calendarUrl(c.id) : null }])),
    plan,
    results,
    wrote: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  }
}
