// src/model/slackCatchUp.js — Slack, the third morning load, as a catch-up lane.
//
// Nima named three things that pile up before the day starts: the inbox, the daily
// rhythms, and Slack. The first two landed in src/model/catchUp.js; this is the third.
//
// ── ⚠️ THE TENSION THIS FILE HAS TO HOLD ────────────────────────────────────────
//
// Nima, 2026-08-06, on what counts: *"any task doesn't have to be addressed to me by
// name. Sometimes they dont use name and sometimes it something i just need to be aware
// of if my partner can't get to it."*
//
// So the unit is a TASK, not a mention. But catchUp.js's second rule is **collapse,
// don't sum — group by an objective fact of the message, never by an invented
// importance score**, because a guessed priority is precisely what made him stop
// trusting the day plan (see the morning-paralysis memory and PR #50).
//
// Reading "is this a task?" out of free text IS an invented importance score. So this
// file does NOT classify. It sorts by facts that are true of the message regardless of
// what it says — who it names, which conversation it is in, and whether Nima has
// visibly engaged with it — and lets him scan. Three lanes:
//
//   DIRECT   names him, or is a DM/group DM someone else spoke in
//   COVER    names his partner and not him — "if my partner can't get to it"
//   CHANNEL  everything else in the channels he chose; unaddressed, still his to skim
//
// Nobody scored anything. A lane is a fact about the addressing, not a judgement about
// the content, and the CHANNEL lane deliberately keeps things that name no one — which
// is exactly the case he asked for.
//
// ── ⚠️ "HAS HE POSTED SINCE" IS NOT "HAS HE REPLIED" ────────────────────────────
//
// The first design cleared a message when Nima posted in the same channel afterwards.
// Measured on 15 days of live Slack, that is right in a quiet channel and badly wrong
// in a busy one:
//
//   #wholesale-shoes  Geneva asked 11:16:15, he answered 11:18 — cleared correctly.
//   #retail-order-support  he posts all day, so Jackie's 08-04 cocoa-beads question
//                     would be "answered" by his 08-05 messages about bag measurements,
//                     a different conversation entirely.
//
// A channel where someone talks constantly would silently clear every ask in it. So a
// top-level channel message is cleared ONLY by evidence tied to that message: a reply
// in its own thread, or his reaction to it — which is the gesture Slack actually gives
// you for "seen, got it". DMs and group DMs are single-topic, so conversation-level
// engagement is honest there, and that is what surfaced the one genuinely dropped
// thread in the sample (15 items to France, asked 30 Jul, no reply, ship date passed).
//
// The failure direction is deliberate: an item Nima has handled elsewhere stays visible
// until the cutoff, rather than work disappearing because a channel is chatty.
//
// Pure. No React, no DB, no network.

const DAY = 86400000

/** Objective addressing lanes — never a content judgement. */
export const LANE = {
  DIRECT: 'direct',
  COVER: 'cover',
  CHANNEL: 'channel',
}

// Slack has no readable unread state for us (no `conversations.info` last_read on this
// connector), so the inbox band's `is:unread` bound has no analogue. A time window is
// the honest substitute — and it is also the backstop that stops the CHANNEL lane
// growing without limit, since an unaddressed channel message may never be replied to
// or reacted to by anyone. Nima, 2026-08-06: "that sounds good for now and we can
// adjust later."
export const DEFAULT_CUTOFF_DAYS = 14

const ageDays = (ts, now) => (ts ? Math.floor((now - ts) / DAY) : 0)

function laneFor(msg, { me, partner }) {
  const mentions = msg.mentions || []
  if (mentions.includes(me)) return LANE.DIRECT
  // A DM or group DM is addressed by construction — nobody writes one by accident.
  if (msg.channelType === 'im' || msg.channelType === 'mpim') return LANE.DIRECT
  if (partner && mentions.includes(partner)) return LANE.COVER
  return LANE.CHANNEL
}

/**
 * Has Nima visibly engaged with this specific message?
 *
 * `myReplies` are his own messages. The three routes, tightest first:
 *   ① he reacted to it                     — Slack's own "seen, got it"
 *   ② he posted in ITS thread after it     — tied to this message, not the channel
 *   ③ DM/group DM only: he posted in the conversation after it
 *
 * ⚠️ There is deliberately no route ④ "he posted in the channel after it". See header.
 */
export function isEngaged(msg, myReplies = []) {
  if (msg.reactedByMe) return true
  const thread = msg.threadTs || msg.ts
  if (myReplies.some((r) => r.threadTs === thread && r.ts > msg.ts)) return true
  if (msg.channelType === 'im' || msg.channelType === 'mpim') {
    if (myReplies.some((r) => r.channelId === msg.channelId && r.ts > msg.ts)) return true
  }
  return false
}

/**
 * Collapse Slack messages into the conversations that still want something.
 *
 * `messages` are everything pulled from the chosen channels + DMs, INCLUDING Nima's
 * own — his are what clear the rest, so a caller must not filter them out first.
 */
export function buildSlackCatchUp(messages = [], opts = {}) {
  const now = opts.now ?? Date.now()
  const me = opts.me
  const partner = opts.partner || null
  const cutoffDays = opts.cutoffDays ?? DEFAULT_CUTOFF_DAYS
  const since = now - cutoffDays * DAY

  const mine = messages.filter((m) => m.userId === me)
  const open = []

  for (const m of messages) {
    if (m.userId === me) continue
    // ⚠️ #restock is a Shopify app feed — 100% bot, and a bot post is a notification,
    // not somebody waiting on an answer. Excluded from work; the channel is still his
    // to read in Slack. Same reasoning as the email band ignoring its own noise.
    if (m.isBot) continue
    if (!m.ts || m.ts < since) continue
    if (isEngaged(m, mine)) continue
    open.push({ ...m, lane: laneFor(m, { me, partner }) })
  }

  // Collapse to conversations. The count that causes the panic is the message count;
  // the count that is actually true is the conversation count. Both are reported and
  // neither is presented as the other — catchUp.js's rule, applied here.
  const convos = new Map()
  for (const m of open) {
    let c = convos.get(m.channelId)
    if (!c) {
      c = {
        channelId: m.channelId,
        channel: m.channelName || m.channelId,
        channelType: m.channelType,
        lane: m.lane,
        count: 0,
        people: new Set(),
        threadKeys: new Set(),
        oldestDays: 0,
        latestTs: 0,
        latest: null,
      }
      convos.set(m.channelId, c)
    }
    c.count += 1
    if (m.userName) c.people.add(m.userName)
    c.threadKeys.add(m.threadTs || m.ts)
    c.oldestDays = Math.max(c.oldestDays, ageDays(m.ts, now))
    if (m.ts > c.latestTs) {
      c.latestTs = m.ts
      c.latest = { ts: m.ts, from: m.userName || m.userId, text: m.text || '', permalink: m.permalink || null }
    }
    // A conversation carrying anything DIRECT is DIRECT — the strongest addressing in
    // it wins, so a question to Nima is never buried under channel chatter.
    if (m.lane === LANE.DIRECT) c.lane = LANE.DIRECT
    else if (m.lane === LANE.COVER && c.lane === LANE.CHANNEL) c.lane = LANE.COVER
  }

  const LANE_ORDER = { [LANE.DIRECT]: 0, [LANE.COVER]: 1, [LANE.CHANNEL]: 2 }
  const conversations = [...convos.values()]
    .map((c) => ({
      channelId: c.channelId, channel: c.channel, channelType: c.channelType, lane: c.lane,
      count: c.count, threads: c.threadKeys.size, people: [...c.people].sort(),
      oldestDays: c.oldestDays, latest: c.latest,
    }))
    // Lane first (an objective addressing fact), then oldest, then busiest. Never a
    // score: two conversations in the same lane are ordered by how long they have been
    // waiting, which is a property of the clock and not of my opinion.
    .sort((a, b) =>
      (LANE_ORDER[a.lane] - LANE_ORDER[b.lane]) ||
      (b.oldestDays - a.oldestDays) ||
      (b.count - a.count) ||
      a.channel.localeCompare(b.channel))

  const inLane = (l) => conversations.filter((c) => c.lane === l)
  const sum = (list) => list.reduce((n, c) => n + c.count, 0)

  return {
    cutoffDays,
    messages: open.length,
    conversations,
    lanes: {
      direct: { conversations: inLane(LANE.DIRECT).length, messages: sum(inLane(LANE.DIRECT)) },
      cover: { conversations: inLane(LANE.COVER).length, messages: sum(inLane(LANE.COVER)) },
      channel: { conversations: inLane(LANE.CHANNEL).length, messages: sum(inLane(LANE.CHANNEL)) },
    },
    oldestDays: conversations.reduce((n, c) => Math.max(n, c.oldestDays), 0),
    // Absence is the all-clear — an empty lane renders nothing, never a tick-box panel
    // taking morning space.
    empty: conversations.length === 0,
  }
}
