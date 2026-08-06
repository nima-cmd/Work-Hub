// src/ingest/slack.js — read the channels Nima chose, plus every DM.
//
// ⚠️ THIS NEEDS A USER TOKEN (`xoxp-`), NOT A BOT TOKEN. A bot cannot see his DMs, and
// `search`/history over private channels is granted to the installing USER. The scopes
// are listed in `npm run check:slack`. Until `SLACK_USER_TOKEN` is set this module fails
// closed with that message rather than half-working — the same shape as the warehouse
// feed's go-live check, which names the missing step instead of returning an empty list
// that reads like "nothing to do".
//
// The rules for what counts live in src/model/slackCatchUp.js (pure, tested). This file
// only fetches and normalises.

const SLACK_API = 'https://slack.com/api'

// Nima's own choice, 2026-08-06, verbatim. He explicitly did NOT include #netsuite,
// #inventory-transfer or #shopify-alerts, which I had guessed in — his list, not mine.
export const WORK_CHANNELS = [
  'edi',
  'retail-order-support',
  'restock',
  'wholesale',
  'wholesale-shoes',
  'acs',
  'farsight-naghediaccounting',
]

// Nima and his partner on the floor. COVER items are the ones aimed at Ricardo —
// "something i just need to be aware of if my partner can't get to it".
export const ME = 'UMNRVMH5E'
export const PARTNER = 'U0629ARUUCQ'

export function slackConfigured() {
  return !!process.env.SLACK_USER_TOKEN
}

function token() {
  const t = process.env.SLACK_USER_TOKEN
  if (!t) {
    throw new Error(
      'SLACK_USER_TOKEN is not set. Slack needs a USER token (xoxp-), not a bot token — ' +
      'a bot cannot read DMs. Run `npm run check:slack` for the exact scopes.',
    )
  }
  if (t.startsWith('xoxb-')) {
    // Fail loudly on the wrong KIND of token. A bot token authenticates fine and then
    // silently returns nothing for DMs, which would read as "no Slack work today".
    throw new Error('SLACK_USER_TOKEN looks like a BOT token (xoxb-). DMs and search need a user token (xoxp-).')
  }
  return t
}

async function api(method, params = {}) {
  const url = new URL(`${SLACK_API}/${method}`)
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } })
  const body = await res.json().catch(() => ({}))
  // ⚠️ Slack returns HTTP 200 with { ok: false, error } — checking res.ok alone treats
  // `missing_scope` as success and yields an empty, confident-looking result.
  if (!body.ok) throw new Error(`Slack ${method}: ${body.error || `HTTP ${res.status}`}`)
  return body
}

async function paged(method, params, key, { max = 1000 } = {}) {
  const out = []
  let cursor
  do {
    const body = await api(method, { ...params, cursor, limit: 200 })
    out.push(...(body[key] || []))
    cursor = body.response_metadata?.next_cursor || null
  } while (cursor && out.length < max)
  return out
}

/** Every conversation we care about: the chosen channels, plus all DMs and group DMs. */
export async function listConversations() {
  const all = await paged('conversations.list', {
    types: 'public_channel,private_channel,im,mpim',
    exclude_archived: true,
  }, 'channels')

  const wanted = new Set(WORK_CHANNELS.map((n) => n.toLowerCase()))
  return all.filter((c) => {
    if (c.is_im || c.is_mpim) return true // "i also need all direct messages as well"
    return c.is_member && wanted.has(String(c.name || '').toLowerCase())
  })
}

// A message is a bot post when Slack says so. `subtype: 'bot_message'` covers app posts
// (the Shopify feed in #restock); `bot_id` without a user covers the rest.
const isBot = (m) => m.subtype === 'bot_message' || (!!m.bot_id && !m.user)

function normalize(m, channel) {
  const reactions = m.reactions || []
  return {
    id: `${channel.id}:${m.ts}`,
    ts: Math.round(Number(m.ts) * 1000),
    channelId: channel.id,
    channelName: channel.name || channel.user || channel.id,
    channelType: channel.is_im ? 'im' : channel.is_mpim ? 'mpim' : 'channel',
    userId: m.user || m.bot_id || null,
    userName: m.user_profile?.real_name || m.username || null,
    text: (m.text || '').slice(0, 2000),
    threadTs: m.thread_ts ? Math.round(Number(m.thread_ts) * 1000) : null,
    isBot: isBot(m),
    // Both engagement signals ride along on the history payload, so no extra round trip:
    reactedByMe: reactions.some((r) => (r.users || []).includes(ME)),
    // `reply_users` is who has posted in this message's thread — if Nima is in it, he
    // answered in the thread, which is the tight per-message evidence the model wants.
    repliedInThreadByMe: (m.reply_users || []).includes(ME),
  }
}

/**
 * Pull recent messages from every chosen conversation.
 *
 * Returns Nima's own messages too — they are what clear everything else, so the model
 * must receive them (see buildSlackCatchUp).
 */
export async function fetchSlackMessages({ cutoffDays = 14, now = Date.now() } = {}) {
  const conversations = await listConversations()
  const oldest = ((now - cutoffDays * 86400000) / 1000).toFixed(6)

  const messages = []
  // Sequential on purpose: Slack's per-method rate limits are tight (Tier 3 ≈ 50/min)
  // and this runs once a morning, not per request.
  for (const c of conversations) {
    let history = []
    try {
      history = await paged('conversations.history', { channel: c.id, oldest }, 'messages', { max: 400 })
    } catch (e) {
      // One unreadable conversation must not blank the whole band — but it must be
      // visible, not swallowed.
      console.error(`slack: skipped ${c.name || c.id}: ${e.message}`)
      continue
    }
    for (const m of history) {
      const n = normalize(m, c)
      // A thread reply by Nima is recorded on the PARENT via reply_users, so synthesise
      // the reply the model looks for rather than fetching every thread.
      if (n.repliedInThreadByMe) {
        messages.push({ ...n, id: n.id + ':myreply', userId: ME, ts: n.ts + 1, threadTs: n.threadTs || n.ts, text: '' })
      }
      messages.push(n)
    }
  }
  return { conversations: conversations.length, messages }
}
