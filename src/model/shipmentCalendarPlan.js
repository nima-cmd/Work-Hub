// src/model/shipmentCalendarPlan.js — what the calendar sync WOULD do, as pure rules.
//
// shipmentCalendar.js turns one PO's evidence into an event body. This decides, for a
// whole batch: which calendar each event belongs on, whether Google already has it,
// and whether anything actually changed. No network, so the dry run and the real run
// compute the SAME plan and only differ in whether it is executed.
//
// ⚠️ THE DRY RUN IS THE POINT. This writes to a calendar the warehouse reads, so the
// plan is a first-class object you can print and check before anything leaves.

import { deriveSource } from './source.js'
import { shipmentEvent } from './shipmentCalendar.js'
import { heldEvent } from './heldShipment.js'
import { transferEvent } from './transferCalendar.js'

export const LANE = { EDI: 'edi', BOUTIQUE: 'boutique', HELD: 'held', TRANSFER: 'transfer' }

// Two calendars rather than one with colours, because Nima asked for TOGGLEABLE
// LAYERS — and in Google the unit you can switch off is a calendar, not a colour.
export const CALENDAR_NAME = {
  [LANE.EDI]: 'Naghedi Shipping — EDI',
  [LANE.BOUTIQUE]: 'Naghedi Shipping — Boutique',
  // ⚠️ A THIRD LANE THAT IS NOT A SHIPMENT. The other two record freight that WENT;
  // this one records goods still on our floor, and it sits on TODAY rather than on any
  // predicted date. Named so a reader glancing at three toggled layers cannot mistake
  // it for a shipping record.
  [LANE.HELD]: 'Naghedi Shipping — In the warehouse',
  // ⚠️ ITS OWN LANE, not folded into Boutique. A transfer to the Office or to
  // Consignment is freight that left, but it has no customer and no invoice — putting
  // it on the Boutique calendar would make a shared surface misstate what it is.
  [LANE.TRANSFER]: 'Naghedi Shipping — Transfers',
}

export const ACTION = { CREATE: 'create', UPDATE: 'update', UNCHANGED: 'unchanged', SKIP: 'skip', REMOVE: 'remove' }

export const SKIP = {
  NO_EVENT: 'no-event',              // no date to put it on — shipmentEvent() returned null
  // ⚠️ A GUARD, NOT A POPULATION — expect 0 of these in the real backfill, and that is
  // not a broken counter. With self-consistent input it cannot fire: no evidence of any
  // tier also means no accepted ASN/invoice and no ship date, so eventDate() returns
  // null and NO_EVENT catches it first. It stays because `evidence` and `shipDates`
  // arrive as SEPARATE arguments, so a future caller can pass a date alongside empty
  // evidence — and publishing "shipped" off a date with nothing behind it is the exact
  // claim this whole module refuses to make.
  NOT_PUBLISHABLE: 'not-publishable',
  UNKNOWN_LANE: 'unknown-lane',       // neither a partner nor a customer to classify by
}

export const SKIP_LABEL = {
  [SKIP.NO_EVENT]: 'no ship date on any evidence',
  [SKIP.NOT_PUBLISHABLE]: 'no shipment evidence of any kind',
  [SKIP.UNKNOWN_LANE]: 'no partner or customer — lane unknown',
}

/**
 * Which calendar this PO belongs on.
 *
 * ⚠️ DECIDED BY WHETHER THE PO HAS EDI DOCUMENTS, NOT BY THE PARTNER'S NAME. The name
 * route was the first cut and it was wrong twice over. deriveSource() matches
 * ShopBop / Nordstrom / Bloomingdale's, so `Neiman Marcus Group (NMG)` (7 POs) and
 * `Saks Fifth Avenue & Saks OFF 5th` (1) — partners we exchange real 856s and 810s
 * with — would have been filed on the BOUTIQUE calendar. Having an 856/810 is an
 * observed fact about the shipment; the customer string is a display field that merely
 * correlates with it. Keying on the display field when an objective one exists is
 * shape #3 in src/model/fieldAssumptions.js.
 *
 * The name classifier stays as the fallback for a PO with no EDI documents at all,
 * which is the boutique population by construction.
 *
 * ⚠️ RETURNS null WHEN NOTHING CLASSIFIES IT. deriveSource() answers 'boutique' for
 * anything unmatched, which cannot tell "not Nordstrom" from "I was given nothing".
 * Letting a nameless PO fall through would file freight on a SHARED calendar under a
 * lane nobody asserted — `default is not an answer` (routing_shipment.merge_center).
 */
export function laneFor({ partner, customer, location, hasEdiDocs } = {}) {
  if (hasEdiDocs) return LANE.EDI
  const name = partner || customer
  if (!name && !location) return null
  return deriveSource(name, location) === 'edi' ? LANE.EDI : LANE.BOUTIQUE
}

/**
 * The day after an ISO day, for an all-day event's exclusive end.
 *
 * ⚠️ GOOGLE'S all-day `end.date` IS EXCLUSIVE. Setting end === start yields an event
 * of zero length, which Google either rejects or renders on no day at all — the
 * classic off-by-one, and invisible until someone opens the calendar.
 *
 * ⚠️ Computed in UTC ON PURPOSE. These are dateless days by this point; constructing
 * them in a local zone is how a DATE moves backwards across DST, the trap
 * shipmentCalendar.js documents from the other direction.
 */
export function nextDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1))
  return d.toISOString().slice(0, 10)
}

/** The Google Calendar event resource for one shipmentEvent(). */
export function toGoogleEvent(ev) {
  return {
    id: ev.key,
    summary: ev.summary,
    description: ev.description,
    start: { date: ev.date },
    end: { date: nextDay(ev.date) },
    // ⚠️ Freight does not make Nima look busy. A shipment entry that marks him BUSY
    // would corrupt every free/busy lookup and every "find a time" against his day.
    transparency: 'transparent',
  }
}

/**
 * Has anything a reader would see changed?
 *
 * ⚠️ COMPARES ONLY THE FIELDS WE SET. A Google event carries dozens of server-owned
 * fields (etag, updated, iCalUID, reminders…); comparing whole objects would report
 * every event as changed on every run and rewrite the entire calendar hourly.
 */
export function eventDiffers(existing, desired) {
  if (!existing) return true
  const day = (e, k) => e?.[k]?.date || e?.[k]?.dateTime?.slice(0, 10) || null
  return (existing.summary || '') !== (desired.summary || '')
    || (existing.description || '') !== (desired.description || '')
    || day(existing, 'start') !== desired.start.date
    || day(existing, 'end') !== desired.end.date
}

/**
 * Build the whole plan.
 *
 * @param candidates  [{ po, partner, customer, location, evidence, shipDates }]
 * @param existing    { [lane]: Map(eventId -> google event) } — what each calendar holds
 * @returns { entries, summary, misfiled }
 */
export function planShipmentCalendar({ candidates = [], existing = {} } = {}) {
  const entries = []
  const misfiled = []

  for (const c of candidates) {
    const lane = laneFor(c)
    if (!lane) {
      entries.push({ po: c.po, action: ACTION.SKIP, reason: SKIP.UNKNOWN_LANE })
      continue
    }
    const ev = shipmentEvent({ po: c.po, so: c.so, partner: c.partner, evidence: c.evidence, shipDates: c.shipDates })
    if (!ev) {
      entries.push({ po: c.po, so: c.so, lane, action: ACTION.SKIP, reason: SKIP.NO_EVENT })
      continue
    }
    if (!ev.publishable) {
      entries.push({ po: c.po, so: c.so, lane, action: ACTION.SKIP, reason: SKIP.NOT_PUBLISHABLE })
      continue
    }

    const desired = toGoogleEvent(ev)
    const here = existing[lane]?.get?.(ev.key) || null

    // ⚠️ A PO WHOSE LANE CHANGED LEAVES A TWIN BEHIND. Reclassify a partner and the
    // old calendar still holds an event nobody will revisit — a stale entry on a
    // SHARED calendar, which is worse than a missing one. Reported, never auto-deleted:
    // deleting someone's calendar entry on an inference is not this script's call.
    const otherLane = lane === LANE.EDI ? LANE.BOUTIQUE : LANE.EDI
    if (existing[otherLane]?.get?.(ev.key)) misfiled.push({ po: c.po, key: ev.key, staleIn: otherLane, belongsIn: lane })

    entries.push({
      po: c.po, so: c.so, lane, key: ev.key, date: ev.date,
      summary: ev.summary, proven: ev.proven, event: desired,
      // ⚠️ Surfaced so the SUMMARY can say how many events carry the "paperwork not
      // checked" hedge. A caveat that only exists inside 184 event bodies is a caveat
      // nobody reads before deciding to publish.
      paperworkChecked: c.evidence?.scansChecked !== false,
      action: !here ? ACTION.CREATE : eventDiffers(here, desired) ? ACTION.UPDATE : ACTION.UNCHANGED,
    })
  }

  return { entries, summary: summarize(entries), misfiled }
}

export function summarize(entries = []) {
  const out = {
    total: entries.length,
    create: 0, update: 0, unchanged: 0, skip: 0,
    proven: 0, unproven: 0, paperworkUnchecked: 0,
    byLane: { [LANE.EDI]: 0, [LANE.BOUTIQUE]: 0 },
    skips: {},
  }
  for (const e of entries) {
    out[e.action] = (out[e.action] || 0) + 1
    if (e.action === ACTION.SKIP) { out.skips[e.reason] = (out.skips[e.reason] || 0) + 1; continue }
    out.byLane[e.lane] = (out.byLane[e.lane] || 0) + 1
    // ⚠️ Counted over the events we would PUBLISH, not over every candidate — a count
    // whose population is not its label is this repo's second-commonest counter bug.
    if (e.proven) out.proven++; else out.unproven++
    if (e.paperworkChecked === false) out.paperworkUnchecked++
  }
  return out
}


/**
 * The held calendar: what is on our floor today, and what should stop being.
 *
 * @param candidates  loadHeldCandidates() output
 * @param existing    Map(eventId -> google event) for the held calendar
 * @param shippedKeys the keys the shipped lanes are publishing THIS RUN
 * @param todayIso    the day every held entry sits on
 */
export function planHeldCalendar({ candidates = [], existing = new Map(), shippedKeys = new Set(), todayIso } = {}) {
  const entries = []
  const live = new Set()

  for (const c of candidates) {
    const ev = heldEvent({ ...c, todayIso })
    if (!ev) { entries.push({ so: c.so, action: ACTION.SKIP, reason: 'no-key' }); continue }

    // ⚠️ IT SHIPPED — the held copy must GO, or the same shipment shows twice on two
    // calendars saying opposite things. This is the "move" half, and it is the only
    // place this repo deletes a calendar event. Safe because the key is one WE minted
    // and the shipped lane is publishing that same key in this very run.
    if (shippedKeys.has(ev.key)) {
      if (existing.get?.(ev.key)) entries.push({ so: c.so, key: ev.key, action: ACTION.REMOVE, reason: 'shipped' })
      continue
    }

    live.add(ev.key)
    const desired = {
      id: ev.key, summary: ev.summary, description: ev.description,
      start: { date: ev.date }, end: { date: nextDay(ev.date) }, transparency: 'transparent',
    }
    const here = existing.get?.(ev.key) || null
    entries.push({
      so: c.so, po: c.po, key: ev.key, date: ev.date, summary: ev.summary,
      reason: ev.reason, daysHeld: ev.daysHeld, event: desired,
      action: !here ? ACTION.CREATE : eventDiffers(here, desired) ? ACTION.UPDATE : ACTION.UNCHANGED,
    })
  }

  // ⚠️ A HELD EVENT WITH NO CANDIDATE IS STALE, and staleness here is a lie about where
  // goods are. It happens whenever a shipment leaves the population without appearing in
  // a shipped lane — the ship date synced but no ASN, say. Removed rather than left to
  // sit on today's date forever, quietly asserting that a departed box is on the floor.
  // ⚠️ THE REASON IS DECIDED HERE, because the branch above CANNOT REACH IT.
  // loadHeldCandidates filters `WHERE actual_ship_date IS NULL`, so a shipped shipment
  // is never a held candidate — the loop above only ever sees things still on the
  // floor, and its `shipped` removal was an UNREACHABLE BRANCH (shape #1 in
  // fieldAssumptions.js). It reported every departure as "no longer held", and the
  // CLI's "N shipped and will MOVE off this calendar" line could never print. The test
  // that covered it passed by hand-building a candidate that was both held AND
  // shipped — an input the loader cannot produce.
  for (const [key] of existing) {
    if (live.has(key)) continue
    if (entries.some((e) => e.key === key)) continue
    entries.push({ key, action: ACTION.REMOVE, reason: shippedKeys.has(key) ? 'shipped' : 'no-longer-held' })
  }

  return { entries, summary: summarizeHeld(entries) }
}

export function summarizeHeld(entries = []) {
  const out = { total: entries.length, create: 0, update: 0, unchanged: 0, remove: 0, skip: 0, byReason: {}, oldest: null }
  for (const e of entries) {
    out[e.action] = (out[e.action] || 0) + 1
    if (e.action === ACTION.REMOVE || e.action === ACTION.SKIP) continue
    out.byReason[e.reason] = (out.byReason[e.reason] || 0) + 1
    if (e.daysHeld != null && (out.oldest === null || e.daysHeld > out.oldest)) out.oldest = e.daysHeld
  }
  return out
}


/**
 * The transfers calendar. One lane covering a transfer's whole life — unshipped ones
 * sit on today and roll forward, shipped ones settle on the day they went.
 */
export function planTransferCalendar({ transfers = [], existing = new Map(), todayIso } = {}) {
  const entries = []
  const live = new Set()

  for (const t of transfers) {
    const ev = transferEvent({ ...t, todayIso })
    if (!ev) { entries.push({ toNumber: t.toNumber, action: ACTION.SKIP, reason: 'no-date' }); continue }
    live.add(ev.key)
    const desired = {
      id: ev.key, summary: ev.summary, description: ev.description,
      start: { date: ev.date }, end: { date: nextDay(ev.date) }, transparency: 'transparent',
    }
    const here = existing.get?.(ev.key) || null
    entries.push({
      toNumber: t.toNumber, key: ev.key, date: ev.date, state: ev.state,
      summary: ev.summary, daysWaiting: ev.daysWaiting, event: desired,
      action: !here ? ACTION.CREATE : eventDiffers(here, desired) ? ACTION.UPDATE : ACTION.UNCHANGED,
    })
  }

  // ⚠️ A transfer that stops being tracked — a destination removed from the list, or
  // the document deleted — must not leave an entry asserting freight that no longer
  // exists on a calendar other people read.
  for (const [key] of existing) {
    if (live.has(key)) continue
    if (entries.some((e) => e.key === key)) continue
    entries.push({ key, action: ACTION.REMOVE, reason: 'no-longer-tracked' })
  }

  return { entries, summary: summarizeTransfers(entries) }
}

export function summarizeTransfers(entries = []) {
  const out = { total: entries.length, create: 0, update: 0, unchanged: 0, remove: 0, skip: 0, byState: {}, longestWait: null }
  for (const e of entries) {
    out[e.action] = (out[e.action] || 0) + 1
    if (e.action === ACTION.REMOVE || e.action === ACTION.SKIP) continue
    out.byState[e.state] = (out.byState[e.state] || 0) + 1
    if (e.daysWaiting != null && (out.longestWait === null || e.daysWaiting > out.longestWait)) out.longestWait = e.daysWaiting
  }
  return out
}
