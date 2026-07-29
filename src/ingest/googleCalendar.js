// src/ingest/googleCalendar.js — reads events from the Google Calendar REST API
// AND writes the app-owned "Naghedi Shipping" calendar (same raw-fetch style as
// gmail.js; reuses its OAuth refresh-token flow). Reading only needs
// calendar.readonly; the shipping-calendar writes need the full `calendar` scope
// (added to connect-gmail.js 2026-07-29 — re-run it to mint a token that carries
// it). A Zoom or Google Meet link on an event makes it a "holocall" (Nima,
// 2026-07-21). Fails soft: a 403/401 surfaces {configured:false} rather than
// throwing, distinguishing a missing scope (needsReauth) from a disabled Calendar
// API in the Cloud project (apiDisabled) so the app can prompt the right fix, and
// works before/after either is fixed.

import { getAccessToken } from './gmail.js'

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const CALLIST_API = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
const CALS_API = 'https://www.googleapis.com/calendar/v3/calendars'
const SHIPPING_CAL_NAME = 'Naghedi Shipping'

// A Calendar 403/401 has two causes (same split as fetchCalendarEvents below and
// googleDrive.js): a MISSING SCOPE (needsReauth → re-run connect-gmail.js) or a
// DISABLED Calendar API in the Cloud project (apiDisabled → enable it in the
// console). Parse the body so the caller can surface the right fix.
function classifyAuthError(status, body) {
  if (status !== 403 && status !== 401) return null
  if (/accessNotConfigured|has not been used in project|is disabled/i.test(body || '')) {
    return { apiDisabled: true }
  }
  return { needsReauth: true }
}

// Pull a Zoom/Meet join URL out of an event's structured + free-text fields.
function conferenceUrl(ev) {
  // Google Meet lives in hangoutLink or conferenceData; Zoom is usually a
  // zoom.us URL in location or the description.
  if (ev.hangoutLink) return { url: ev.hangoutLink, kind: 'meet' }
  const entry = ev.conferenceData?.entryPoints?.find((e) => e.uri)
  if (entry?.uri) return { url: entry.uri, kind: /zoom/i.test(entry.uri) ? 'zoom' : 'meet' }
  const hay = `${ev.location || ''} ${ev.description || ''}`
  const zoom = hay.match(/https?:\/\/[\w.-]*zoom\.us\/[^\s"')<]+/i)
  if (zoom) return { url: zoom[0], kind: 'zoom' }
  const meet = hay.match(/https?:\/\/meet\.google\.com\/[^\s"')<]+/i)
  if (meet) return { url: meet[0], kind: 'meet' }
  return null
}

function normalize(ev) {
  const start = ev.start?.dateTime || ev.start?.date || null
  const end = ev.end?.dateTime || ev.end?.date || null
  const allDay = !ev.start?.dateTime
  const conf = conferenceUrl(ev)
  return {
    id: ev.id,
    title: ev.summary || '(no title)',
    start,
    end,
    allDay,
    location: ev.location || null,
    organizer: ev.organizer?.displayName || ev.organizer?.email || null,
    attendeeCount: (ev.attendees || []).length,
    htmlLink: ev.htmlLink || null,        // open in Google Calendar
    conferenceUrl: conf?.url || null,
    holocall: !!conf,                     // a Zoom/Meet link → render as a holocall
    conferenceKind: conf?.kind || null,   // 'zoom' | 'meet'
    status: ev.status,
  }
}

// Upcoming events in a window (default: now → +30 days). Returns
// { configured, events, needsReauth }. needsReauth=true means the token lacks
// the calendar scope — the app should prompt a re-run of connect-gmail.js.
export async function fetchCalendarEvents({ timeMin, timeMax } = {}) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return { configured: false, events: [] }
  let token
  try {
    token = await getAccessToken()
  } catch {
    return { configured: false, events: [] }
  }
  const params = new URLSearchParams({
    singleEvents: 'true',          // expand recurring into individual instances
    orderBy: 'startTime',
    maxResults: '50',
    timeMin: timeMin || new Date().toISOString(),
  })
  if (timeMax) params.set('timeMax', timeMax)
  const res = await fetch(`${CAL_API}?${params}`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status === 403 || res.status === 401) {
    // Two very different 403s hide here, and conflating them sends you down the
    // wrong fix (Nima, 2026-07-29): a MISSING SCOPE means re-auth, but a
    // DISABLED API ("accessNotConfigured" / "has not been used in project")
    // means enabling the Calendar API in the Google Cloud console — re-auth
    // won't touch it. Parse the reason so the app can say the right thing.
    const body = await res.text().catch(() => '')
    if (/accessNotConfigured|has not been used in project|is disabled/i.test(body)) {
      return { configured: false, apiDisabled: true, events: [] }
    }
    return { configured: false, needsReauth: true, events: [] }
  }
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return { configured: true, events: (data.items || []).map(normalize) }
}

// ── Naghedi Shipping calendar (writes; full `calendar` scope) ─────────────────

// process-lifetime cache so we don't re-list the calendar on every shipped click.
let _shippingCalId

// A Calendar event id must be base32hex — lowercase a–v and 0–9 only (w/x/y/z are
// NOT valid). Deriving it deterministically from the BOL number gives us free
// idempotency + de-dup: the same truck marked shipped twice (or a second DC of
// the same master shipping) targets the SAME event id → one event, refreshed.
export function shippingEventId(bolNumber) {
  const clean = String(bolNumber || '').toLowerCase().replace(/[^a-v0-9]/g, '')
  return ('shiphub' + (clean || 'unknown')).slice(0, 1024)
}

// All-day event end.date is EXCLUSIVE, so a one-day event ends the next day.
function nextDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// Find-or-create the app-owned "Naghedi Shipping" calendar; returns { id } or a
// soft-fail marker ({ configured:false } / { needsReauth } / { apiDisabled }).
// Nima shares it with the warehouse team himself from Calendar settings.
export async function ensureShippingCalendar() {
  if (_shippingCalId) return { id: _shippingCalId }
  if (!process.env.GOOGLE_REFRESH_TOKEN) return { configured: false }
  let token
  try {
    token = await getAccessToken()
  } catch {
    return { configured: false }
  }
  const headers = { Authorization: `Bearer ${token}` }

  // Already created on a prior run? Find it by name in the calendar list.
  const listRes = await fetch(`${CALLIST_API}?fields=items(id,summary)&maxResults=250`, { headers })
  if (!listRes.ok) {
    const soft = classifyAuthError(listRes.status, await listRes.text().catch(() => ''))
    if (soft) return soft
    throw new Error(`Calendar list ${listRes.status}`)
  }
  const existing = (await listRes.json()).items?.find((c) => c.summary === SHIPPING_CAL_NAME)
  if (existing) {
    _shippingCalId = existing.id
    return { id: existing.id }
  }

  // Create it — the app owns it, so Nima can share it once and forget it.
  const createRes = await fetch(`${CALS_API}?fields=id`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: SHIPPING_CAL_NAME,
      description: 'Auto-maintained by Work-Hub: one all-day event per truck when a BOL is marked shipped.',
      timeZone: 'America/New_York',
    }),
  })
  if (!createRes.ok) {
    const soft = classifyAuthError(createRes.status, await createRes.text().catch(() => ''))
    if (soft) return soft
    throw new Error(`Calendar create ${createRes.status}: ${await createRes.text().catch(() => '')}`)
  }
  _shippingCalId = (await createRes.json()).id
  return { id: _shippingCalId }
}

// Upsert one all-day event (insert, or PATCH the existing one on a 409). date is
// 'YYYY-MM-DD'. Soft-fails like everything else here.
export async function upsertShippingEvent({ eventId, date, title, description }) {
  const cal = await ensureShippingCalendar()
  if (!cal.id) return cal
  const token = await getAccessToken()
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const base = `${CALS_API}/${encodeURIComponent(cal.id)}/events`
  const body = JSON.stringify({
    id: eventId,
    summary: title,
    description,
    start: { date },
    end: { date: nextDay(date) },
    transparency: 'transparent', // don't mark the day "busy" on the shared calendar
  })
  let res = await fetch(`${base}?fields=id,htmlLink`, { method: 'POST', headers, body })
  if (res.status === 409) {
    // event id already exists → refresh it in place
    res = await fetch(`${base}/${encodeURIComponent(eventId)}?fields=id,htmlLink`, { method: 'PATCH', headers, body })
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    const soft = classifyAuthError(res.status, errBody)
    if (soft) return soft
    throw new Error(`Calendar event ${res.status}: ${errBody}`)
  }
  const ev = await res.json()
  return { ok: true, id: ev.id, htmlLink: ev.htmlLink }
}

// Delete an event by id (used when a truck is un-shipped and nothing remains on
// it). A 404/410 means it's already gone — treat as success.
export async function deleteShippingEvent(eventId) {
  const cal = await ensureShippingCalendar()
  if (!cal.id) return cal
  const token = await getAccessToken()
  const res = await fetch(
    `${CALS_API}/${encodeURIComponent(cal.id)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.ok || res.status === 404 || res.status === 410) return { ok: true }
  const soft = classifyAuthError(res.status, await res.text().catch(() => ''))
  if (soft) return soft
  throw new Error(`Calendar delete ${res.status}`)
}
