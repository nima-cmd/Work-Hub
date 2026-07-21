// src/ingest/googleCalendar.js — pulls events from the Google Calendar REST API
// (same raw-fetch style as gmail.js; reuses its OAuth refresh-token flow). Read
// only (calendar.readonly). A Zoom or Google Meet link on an event makes it a
// "holocall" (Nima, 2026-07-21). Fails soft: if the refresh token predates the
// calendar scope, Google returns 403 and we surface {configured:false} rather
// than throwing, so the app works before the re-auth and lights up after it.

import { getAccessToken } from './gmail.js'

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

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
    // token doesn't carry calendar scope yet — re-auth needed, not an error
    return { configured: false, needsReauth: true, events: [] }
  }
  if (!res.ok) throw new Error(`Google Calendar ${res.status}: ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return { configured: true, events: (data.items || []).map(normalize) }
}
