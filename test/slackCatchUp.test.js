// Slack as the third morning load. The cases below are the real shapes measured on
// 2026-08-06 across the seven channels Nima chose, plus DMs.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSlackCatchUp, isEngaged, LANE, DEFAULT_CUTOFF_DAYS,
} from '../src/model/slackCatchUp.js'

const ME = 'UMNRVMH5E'        // Nima
const RICARDO = 'U0629ARUUCQ' // his partner on the floor
const NOW = new Date('2026-08-06T21:00:00Z').getTime()
const t = (iso) => new Date(iso).getTime()

const base = { channelType: 'channel', mentions: [], isBot: false }

test('a DM nobody answered is DIRECT and keeps its age', () => {
  // The real one: 15 items to France, asked 30 Jul, ship date passed, no reply.
  const out = buildSlackCatchUp([
    { ...base, id: '1', ts: t('2026-07-30T20:00:31Z'), channelId: 'G1', channelName: 'Geneva, Yasmin, Lisa',
      channelType: 'mpim', userId: 'ULISA', userName: 'Lisa Piliguian', mentions: [ME],
      text: '15 items that need to be shipped to France on Monday' },
  ], { now: NOW, me: ME, partner: RICARDO })

  assert.equal(out.conversations.length, 1)
  const c = out.conversations[0]
  assert.equal(c.lane, LANE.DIRECT)
  assert.equal(c.oldestDays, 7)
  assert.equal(c.count, 1)
  assert.equal(out.empty, false)
})

test('⚠️ a busy channel must NOT clear an ask just because he posted later', () => {
  // The trap that would have shipped: in #retail-order-support he posts all day, so a
  // channel-level "posted since" test clears every question in it.
  const msgs = [
    { ...base, id: 'ask', ts: t('2026-08-04T13:51:37Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: 'UJACKIE', userName: 'Jackie Racine', mentions: [ME],
      text: 'the Cocoa Beads bag does not have a price in Shopify' },
    // His own messages the next day — a different conversation entirely.
    { ...base, id: 'mine1', ts: t('2026-08-05T18:07:48Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: ME, userName: 'Nima Erfani', text: 'the boutiques are the ones getting packed' },
    { ...base, id: 'mine2', ts: t('2026-08-05T18:58:21Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: ME, userName: 'Nima Erfani', text: 'is it wrong or right?' },
  ]
  const out = buildSlackCatchUp(msgs, { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.conversations.length, 1, 'the ask must survive his unrelated later posts')
  assert.equal(out.conversations[0].lane, LANE.DIRECT)
  assert.equal(out.conversations[0].count, 1)
})

test('a reply in the ask\'s OWN thread does clear it', () => {
  const msgs = [
    { ...base, id: 'ask', ts: t('2026-08-04T18:16:15Z'), channelId: 'C_WS', channelName: 'wholesale-shoes',
      userId: 'UGEN', userName: 'Geneva Campbell', mentions: [ME], text: 'Nordstrom Rack EDI question' },
    { ...base, id: 'mine', ts: t('2026-08-04T18:18:05Z'), channelId: 'C_WS', channelName: 'wholesale-shoes',
      userId: ME, threadTs: t('2026-08-04T18:16:15Z'), text: 'well that would be a question for mack' },
  ]
  assert.equal(buildSlackCatchUp(msgs, { now: NOW, me: ME, partner: RICARDO }).empty, true)
})

test('his reaction clears it — Slack\'s own "seen, got it"', () => {
  const msgs = [
    { ...base, id: 'ask', ts: t('2026-08-04T18:00:00Z'), channelId: 'C_W', channelName: 'wholesale',
      userId: 'UARI', userName: 'Arianna Escobar', mentions: [ME], text: 'can you upgrade their shipping',
      reactedByMe: true },
  ]
  assert.equal(buildSlackCatchUp(msgs, { now: NOW, me: ME, partner: RICARDO }).empty, true)
})

test('a DM IS cleared by any later message from him — single-topic by construction', () => {
  const msgs = [
    { ...base, id: 'ask', ts: t('2026-08-04T19:19:26Z'), channelId: 'D_JACKIE', channelName: 'Jackie Racine',
      channelType: 'im', userId: 'UJACKIE', userName: 'Jackie Racine', text: 'weaver sync by end of day?' },
    { ...base, id: 'mine', ts: t('2026-08-04T19:29:00Z'), channelId: 'D_JACKIE', channelType: 'im', userId: ME,
      text: 'yep on it' },
  ]
  assert.equal(buildSlackCatchUp(msgs, { now: NOW, me: ME, partner: RICARDO }).empty, true)
})

test('⚠️ a task naming NOBODY still counts — Nima\'s correction', () => {
  // "any task doesn't have to be addressed to me by name" — this is the CHANNEL lane,
  // and it is why the model must not filter to mentions.
  const out = buildSlackCatchUp([
    { ...base, id: 'x', ts: t('2026-08-06T14:39:12Z'), channelId: 'C_W', channelName: 'wholesale',
      userId: 'UARI', userName: 'Arianna Escobar', text: 'SO12313 doesnt need to start shipping until end of August' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.conversations.length, 1)
  assert.equal(out.conversations[0].lane, LANE.CHANNEL)
})

test('a task aimed at his partner is COVER, not DIRECT and not dropped', () => {
  const out = buildSlackCatchUp([
    { ...base, id: 'r', ts: t('2026-08-06T18:20:16Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: 'UGEN', userName: 'Geneva Campbell', mentions: [RICARDO], text: 'please advise how to proceed' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.conversations[0].lane, LANE.COVER)
  assert.equal(out.lanes.cover.conversations, 1)
  assert.equal(out.lanes.direct.conversations, 0)
})

test('the strongest addressing in a conversation wins', () => {
  // A question to Nima must never be buried under the chatter around it.
  const out = buildSlackCatchUp([
    { ...base, id: 'a', ts: t('2026-08-06T12:00:00Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: 'UY', userName: 'Yasmin', text: 'Morning!' },
    { ...base, id: 'b', ts: t('2026-08-06T13:00:00Z'), channelId: 'C_ROS', channelName: 'retail-order-support',
      userId: 'UGEN', userName: 'Geneva Campbell', mentions: [ME], text: 'can we adjust the item receipt' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.conversations.length, 1)
  assert.equal(out.conversations[0].lane, LANE.DIRECT)
  assert.equal(out.conversations[0].count, 2)
})

test('⚠️ bot posts are notifications, not work — #restock is a Shopify feed', () => {
  const out = buildSlackCatchUp([
    { ...base, id: 'bot', ts: t('2026-08-06T16:01:17Z'), channelId: 'C_RS', channelName: 'restock',
      userId: 'USHOPIFY', userName: 'Shopify', isBot: true, text: 'Removed from Back In Stock' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.empty, true)
})

test('collapse, don\'t sum — messages and conversations are both reported', () => {
  const msgs = Array.from({ length: 6 }, (_, i) => ({
    ...base, id: 'm' + i, ts: t('2026-08-05T12:00:00Z') + i * 60000,
    channelId: 'C_W', channelName: 'wholesale', userId: 'UARI', userName: 'Arianna Escobar', text: 'x' + i,
  }))
  const out = buildSlackCatchUp(msgs, { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.messages, 6)
  assert.equal(out.conversations.length, 1)
  assert.equal(out.conversations[0].count, 6)
  assert.equal(out.conversations[0].threads, 6)
  assert.deepEqual(out.conversations[0].people, ['Arianna Escobar'])
})

test('anything past the cutoff drops out, and the cutoff is configurable', () => {
  const old = [{ ...base, id: 'o', ts: t('2026-07-01T12:00:00Z'), channelId: 'C_W', channelName: 'wholesale',
    userId: 'UARI', userName: 'Arianna Escobar', text: 'ancient' }]
  assert.equal(buildSlackCatchUp(old, { now: NOW, me: ME }).empty, true)
  assert.equal(buildSlackCatchUp(old, { now: NOW, me: ME, cutoffDays: 60 }).conversations.length, 1)
  assert.equal(DEFAULT_CUTOFF_DAYS, 14)
})

test('lanes sort DIRECT first, then oldest', () => {
  const out = buildSlackCatchUp([
    { ...base, id: 'c1', ts: t('2026-08-01T12:00:00Z'), channelId: 'A', channelName: 'wholesale',
      userId: 'U1', userName: 'A', text: 'unaddressed but old' },
    { ...base, id: 'd1', ts: t('2026-08-05T12:00:00Z'), channelId: 'B', channelName: 'edi',
      userId: 'U2', userName: 'B', mentions: [ME], text: 'newer but aimed at him' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.deepEqual(out.conversations.map((c) => [c.lane, c.channel]),
    [[LANE.DIRECT, 'edi'], [LANE.CHANNEL, 'wholesale']])
})

test('isEngaged never clears on an unrelated channel post', () => {
  const ask = { ts: 100, channelId: 'C', channelType: 'channel' }
  assert.equal(isEngaged(ask, [{ ts: 200, channelId: 'C', channelType: 'channel' }]), false)
  assert.equal(isEngaged(ask, [{ ts: 200, channelId: 'C', threadTs: 100 }]), true)
  assert.equal(isEngaged({ ...ask, reactedByMe: true }, []), true)
  // A reply BEFORE the ask is not a reply to it.
  assert.equal(isEngaged(ask, [{ ts: 50, channelId: 'C', threadTs: 100 }]), false)
})

test('his own messages are never items, but are needed to clear others', () => {
  const out = buildSlackCatchUp([
    { ...base, id: 'mine', ts: t('2026-08-06T20:33:56Z'), channelId: 'C_W', channelName: 'wholesale',
      userId: ME, userName: 'Nima Erfani', text: 'SO12295 would need a transfer' },
  ], { now: NOW, me: ME, partner: RICARDO })
  assert.equal(out.empty, true)
})
