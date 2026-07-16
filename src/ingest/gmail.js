// src/ingest/gmail.js — pulls inbox messages straight from the Gmail REST API
// (no SDK — same raw-fetch style as src/ingest/orderful.js) and can write
// back to the real inbox (mark read, apply labels). Auth is OAuth2 refresh-
// token exchange, set up once via scripts/connect-gmail.js (gmail.modify scope).

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

// Fetched fresh per top-level call below (not cached across calls) — matches
// this repo's minimal-state style, and Gmail access tokens are short-lived
// anyway. Cheap: one extra request per sync/read/label action, not per message.
export async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN missing from .env.local — run scripts/connect-gmail.js',
    )
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Gmail token refresh ${res.status}: ${await res.text().catch(() => '')}`)
  const { access_token } = await res.json()
  return access_token
}

async function apiFetch(token, url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`Gmail API ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// 'Jane Doe <jane@example.com>' -> { name: 'Jane Doe', address: 'jane@example.com' }
// Falls back to treating the whole header as the address if there's no <...>.
function parseFromHeader(value) {
  if (!value) return { name: null, address: null }
  const m = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  return m ? { name: m[1].trim() || null, address: m[2].trim() } : { name: null, address: value.trim() }
}

function decodeBase64Url(data) {
  if (!data) return ''
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

const MAX_BODY_CHARS = 50_000

// Gmail splits a message body into a MIME part tree (multipart/alternative,
// multipart/mixed with attachments, etc). We only want the readable text —
// prefer text/plain (recursing into nested parts), falling back to a crude
// tag-stripped text/html if that's all there is. This is what actually fixes
// "we only see the last email" for a forward: the forwarded content lives in
// THIS body, not in a separate message — `snippet` alone never showed it.
function extractPlainText(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data)
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data)
    }
    for (const part of payload.parts) {
      const nested = extractPlainText(part)
      if (nested) return nested
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return ''
}

function normalizeMessage(msg) {
  const headers = msg.payload?.headers || []
  const header = (name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value
  const { name: fromName, address: fromAddress } = parseFromHeader(header('From'))
  return {
    id: msg.id,
    threadId: msg.threadId,
    fromAddress,
    fromName,
    subject: header('Subject') || '(no subject)',
    snippet: msg.snippet || '',
    body: extractPlainText(msg.payload).slice(0, MAX_BODY_CHARS),
    receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : null,
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    labelIds: msg.labelIds || [],
  }
}

// Only unread inbox mail is "transmission"-worthy (Nima, 2026-07-15) — once
// something's been read (in the app or in Gmail itself), it should stop
// showing up here, not linger as an email archive. `is:unread` is the bound;
// sinceDays is optional on top of that for a stale, long-neglected inbox.
export async function fetchInboxMessages({ sinceDays } = {}) {
  const token = await getAccessToken()

  const ids = []
  let pageToken
  do {
    const url = new URL(`${GMAIL_API}/messages`)
    url.searchParams.set('q', sinceDays ? `in:inbox is:unread newer_than:${sinceDays}d` : 'in:inbox is:unread')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const page = await apiFetch(token, url)
    for (const m of page.messages || []) ids.push(m.id)
    pageToken = page.nextPageToken
  } while (pageToken)

  // format=full (not metadata) so we get the actual body — needed to see
  // forwarded content, which lives inside the message itself, not the
  // (list-endpoint-only) snippet. Heavier per-message, but still fetched in
  // small concurrent batches rather than sequentially.
  const CONCURRENCY = 10
  const messages = []
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY).map((id) => {
      const url = new URL(`${GMAIL_API}/messages/${id}`)
      url.searchParams.set('format', 'full')
      return apiFetch(token, url)
    })
    messages.push(...(await Promise.all(batch)).map(normalizeMessage))
  }
  return messages
}

// On-demand only (called when a transmission is expanded, not during sync) —
// returns every message in the thread so a Re: chain shows its earlier
// messages too, not just the most recent unread one. Not persisted; Gmail is
// the source of truth for thread history since we only ever store the
// currently-unread message(s) ourselves.
export async function fetchThread(threadId) {
  const token = await getAccessToken()
  const url = new URL(`${GMAIL_API}/threads/${threadId}`)
  url.searchParams.set('format', 'full')
  const { messages } = await apiFetch(token, url)
  return (messages || []).map(normalizeMessage)
}

// Used to detect "we replied" — a message in the thread FROM this address,
// dated after the task was created, means the reply-needed task is done.
export async function getProfile() {
  const token = await getAccessToken()
  const { emailAddress } = await apiFetch(token, `${GMAIL_API}/profile`)
  return emailAddress
}

export async function markMessageRead(id) {
  const token = await getAccessToken()
  await apiFetch(token, `${GMAIL_API}/messages/${id}/modify`, {
    method: 'POST',
    body: { removeLabelIds: ['UNREAD'] },
  })
}

// Finds a label by name, creating it if it doesn't exist yet, then applies it
// to the message. Returns the label so callers can surface its name/id.
export async function applyLabel(id, labelName) {
  const token = await getAccessToken()
  const { labels } = await apiFetch(token, `${GMAIL_API}/labels`)
  let label = (labels || []).find((l) => l.name === labelName)
  if (!label) {
    label = await apiFetch(token, `${GMAIL_API}/labels`, {
      method: 'POST',
      body: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    })
  }
  await apiFetch(token, `${GMAIL_API}/messages/${id}/modify`, {
    method: 'POST',
    body: { addLabelIds: [label.id] },
  })
  return label
}
