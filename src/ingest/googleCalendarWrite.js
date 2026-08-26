// src/ingest/googleCalendarWrite.js — the WRITE half of Google Calendar.
//
// googleCalendar.js reads Nima's primary calendar for the in-app agenda. This one owns
// the two shipment calendars the warehouse subscribes to. Kept separate because the
// blast radius is different: that one cannot change anything, this one can rewrite a
// calendar other people read.
//
// Same raw-fetch style and the same OAuth refresh flow as gmail.js. Needs the full
// `calendar` scope — already on main (scripts/connect-gmail.js:40); PR #15, which
// existed only to add it, was closed as obsolete.

import { getAccessToken } from './gmail.js'

const API = 'https://www.googleapis.com/calendar/v3'

// The warehouse's zone. Only used when CREATING a calendar — the events themselves are
// all-day and carry no zone, deliberately (see shipmentCalendar.isoShipDay).
const CAL_TZ = 'America/Los_Angeles'

async function call(token, path, { method = 'GET', body, params } = {}) {
  const qs = params ? `?${new URLSearchParams(params)}` : ''
  const res = await fetch(`${API}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = new Error(`Google Calendar ${method} ${path} → ${res.status}: ${text}`)
    err.status = res.status
    err.body = text
    throw err
  }
  return res.status === 204 ? null : res.json()
}

/**
 * Find the calendar named `name`, creating it only if it is genuinely absent.
 *
 * ⚠️ FIND FIRST, AND REFUSE WHEN THE NAME IS AMBIGUOUS. Google lets two calendars share
 * a summary, so "create if the lookup fails" is how a sync quietly grows a second
 * "Naghedi Shipping — EDI" every time the lookup is wrong, splitting the history across
 * two calendars nobody notices are different. If two match we throw rather than pick:
 * choosing arbitrarily between them is exactly the guess this repo keeps paying for.
 *
 * @param create  false → look up only, never create (what --dry passes)
 */
export async function ensureCalendar(token, name, { create = true } = {}) {
  const found = []
  let pageToken
  do {
    const page = await call(token, '/users/me/calendarList', {
      params: { maxResults: '250', showHidden: 'true', ...(pageToken ? { pageToken } : {}) },
    })
    for (const c of page.items || []) if ((c.summary || '') === name) found.push(c)
    pageToken = page.nextPageToken
  } while (pageToken)

  if (found.length > 1) {
    throw new Error(
      `${found.length} calendars are named "${name}" (${found.map((c) => c.id).join(', ')}). ` +
      'Refusing to guess which one is the real shipment calendar — delete or rename the extras.')
  }
  if (found.length === 1) return { id: found[0].id, created: false, name }
  if (!create) return { id: null, created: false, name, missing: true }

  const made = await call(token, '/calendars', { method: 'POST', body: { summary: name, timeZone: CAL_TZ } })
  return { id: made.id, created: true, name }
}

/**
 * Every event this sync owns, as Map(id -> event).
 *
 * ⚠️ PAGINATES, and that is not optional. The default page is 250 and the backfill is
 * ~250 events, so a single unpaginated call returns a PARTIAL picture — every event past
 * the first page reads as absent, the plan says "create", and Google answers 409 because
 * the id is already taken. A truncated read becomes a wrong plan, not an obvious error.
 *
 * ⚠️ showDeleted:false — a cancelled event still HOLDS ITS ID (see upsertEvent).
 * Listing it would make a deleted entry look live.
 */
export async function fetchOwnedEvents(token, calendarId) {
  const out = new Map()
  if (!calendarId) return out
  let pageToken
  do {
    const page = await call(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      params: { maxResults: '2500', showDeleted: 'false', singleEvents: 'true', ...(pageToken ? { pageToken } : {}) },
    })
    for (const e of page.items || []) if (e.id) out.set(e.id, e)
    pageToken = page.nextPageToken
  } while (pageToken)
  return out
}

/**
 * Create or update one event under OUR id, so a re-sync updates instead of duplicating.
 *
 * ⚠️ A 409 ON INSERT IS NOT AN ERROR, IT IS THE UPDATE PATH. Google RETAINS the id of a
 * deleted event, so a PO whose entry someone removed can never be re-created with POST —
 * it answers 409 forever. PUT revives it in place. Without this, deleting one event by
 * hand would permanently break that PO's sync, and the failure would read as a bug in
 * our id generation rather than as a tombstone in Google.
 */
export async function upsertEvent(token, calendarId, event, { update = false } = {}) {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`
  if (update) return { mode: 'update', event: await call(token, `${base}/${encodeURIComponent(event.id)}`, { method: 'PUT', body: event }) }
  try {
    return { mode: 'create', event: await call(token, base, { method: 'POST', body: event }) }
  } catch (e) {
    if (e.status !== 409) throw e
    return { mode: 'revive', event: await call(token, `${base}/${encodeURIComponent(event.id)}`, { method: 'PUT', body: event }) }
  }
}

/**
 * Delete one event we minted.
 *
 * ⚠️ THE ONLY DELETE IN THIS CODEBASE'S CALENDAR PATH, and it is deliberate rather than
 * convenient. It exists for exactly one motion: a shipment leaving the warehouse
 * calendar as it arrives on a shipped one. Without it the same shipment sits on two
 * calendars asserting opposite things, which is worse than either alone.
 *
 * ⚠️ A 404 or 410 IS SUCCESS. The event is already gone — someone deleted it by hand,
 * or a previous run got there first. Treating "already absent" as an error would make
 * every subsequent sync fail on a job that has nothing left to do.
 */
export async function deleteEvent(token, calendarId, eventId) {
  try {
    await call(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
    return { deleted: true }
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { deleted: false, alreadyGone: true }
    throw e
  }
}

/** A share link for a calendar, for the CLI to print. */
export const calendarUrl = (id) => `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(id || '')}`

export { getAccessToken }
