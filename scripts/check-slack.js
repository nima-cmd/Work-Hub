#!/usr/bin/env node
// npm run check:slack
//
// Is the Slack catch-up lane live, and if not, what EXACTLY is missing? Same shape as
// check:warehouse-feed: name the one next step rather than return an empty result that
// reads like "nothing to do".
//
// Exits 0 only when Slack is actually readable.

import { slackConfigured, fetchSlackMessages, WORK_CHANNELS, ME, PARTNER } from '../src/ingest/slack.js'
import { buildSlackCatchUp, LANE, DEFAULT_CUTOFF_DAYS } from '../src/model/slackCatchUp.js'

const line = '  ' + '─'.repeat(72)
console.log('\n  Slack catch-up lane')
console.log(line)

if (!slackConfigured()) {
  console.log(`
  ✗ NOT LIVE — SLACK_USER_TOKEN is not set.

  ⚠️ It must be a USER token (starts with xoxp-), NOT a bot token (xoxb-).
     A bot cannot read DMs, and Nima asked for "all direct messages as well".

  Create a Slack app → OAuth & Permissions → **User Token Scopes**:
      channels:history   groups:history   im:history   mpim:history
      channels:read      groups:read      im:read      mpim:read
      users:read         reactions:read   search:read

  Install to the workspace, copy the User OAuth Token, then add to .env.local:
      SLACK_USER_TOKEN=xoxp-...

  Channels this will read (Nima's choice, 2026-08-06):
      ${WORK_CHANNELS.map((c) => '#' + c).join(' · ')}
      + every DM and group DM
`)
  process.exit(1)
}

let out
try {
  const { conversations, messages } = await fetchSlackMessages({ cutoffDays: DEFAULT_CUTOFF_DAYS })
  out = buildSlackCatchUp(messages, { me: ME, partner: PARTNER, cutoffDays: DEFAULT_CUTOFF_DAYS })
  console.log(`  ✓ readable — ${conversations} conversation(s), ${messages.length} message(s) in ${DEFAULT_CUTOFF_DAYS}d`)
} catch (e) {
  console.log(`\n  ✗ Slack read FAILED: ${e.message}\n`)
  process.exit(1)
}

const LABEL = {
  [LANE.DIRECT]: 'aimed at you',
  [LANE.COVER]: 'aimed at your partner',
  [LANE.CHANNEL]: 'in your channels, no name on it',
}

console.log(`\n  ${out.messages} message(s) still open across ${out.conversations.length} conversation(s)` +
  `${out.oldestDays ? ` · oldest ${out.oldestDays}d` : ''}`)
for (const lane of [LANE.DIRECT, LANE.COVER, LANE.CHANNEL]) {
  const rows = out.conversations.filter((c) => c.lane === lane)
  if (!rows.length) continue
  console.log(`\n  ${LABEL[lane]} — ${rows.length} conversation(s), ${rows.reduce((n, c) => n + c.count, 0)} message(s)`)
  for (const c of rows.slice(0, 12)) {
    const who = c.people.slice(0, 3).join(', ') + (c.people.length > 3 ? ` +${c.people.length - 3}` : '')
    console.log(`      ${c.channelType === 'channel' ? '#' : '@'}${c.channel} · ${c.count} msg / ${c.threads} thread(s) · ${c.oldestDays}d · ${who}`)
    if (c.latest?.text) console.log(`          latest: ${c.latest.text.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  if (rows.length > 12) console.log(`      … and ${rows.length - 12} more`)
}

console.log(`\n${line}`)
console.log(out.empty ? '  ✓ nothing waiting on you in Slack\n' : `  ${out.conversations.length} conversation(s) to skim\n`)
