// src/model/catchUp.js — the "catch up first" band that sits ABOVE the day plan.
//
// Nima, 2026-08-04: "im paralyzied by the amount of work both in terms of order
// i need to make to process emails i need to go through slack messages… i end up
// jumping from task to task." Two of the three things he named as morning load —
// the inbox and the daily rhythms — were nowhere on the plan:
//
//   · Unread email was invisible entirely. An email only ever reached the plan
//     if he had ALREADY read it and promoted it to a quest task by hand, which
//     is the opposite of catching up.
//   · Recurring instances (Weaver sync, CSV refresh, the Airtable reminder) WERE
//     legs, interleaved by EDF among 79 order legs, so a 15-minute daily rhythm
//     competed with a cutoff-bound routing job for the same slot.
//
// Two rules this file exists to hold:
//
//   1. NEVER BLOCKING. Nothing here has a cutoff, an at-risk state or a colour.
//      It is the pre-flight you clear in a few minutes, not a gate on the order
//      work — First hour renders below it either way.
//   2. COLLAPSE, DON'T SUM. 19 unread messages is the number that causes the
//      panic; the same inbox is 7 senders. Grouping is by SENDER — an objective
//      fact of the message — never by an invented "importance" score. A guessed
//      priority is exactly the untrustworthy surface that made him stop using
//      the plan in the first place (see morning-paralysis memory + PR #50).
//
// Pure. No React, no DB.

const DAY = 86400000

// Sender identity for grouping: the address, which is stable, with the display
// name kept only for the label. Bloomingdale's Marketplace sends every order
// notification from one address under one name — that is 8 of 19 unread on
// 2026-08-05, and collapsing them is most of the win.
const senderKey = (e) => (e.fromAddress || e.fromName || 'unknown').toLowerCase()

const domainOf = (address) => {
  const at = String(address || '').split('@')[1]
  return at ? at.toLowerCase() : null
}

const ageDays = (iso, now) => (iso ? Math.floor((now - new Date(iso).getTime()) / DAY) : 0)

// Group the unread inbox by sender, busiest first, then oldest first.
//
// `threads` is counted per group because a reply is owed per CONVERSATION, not
// per message: on 2026-08-05 the 19 unread were 14 threads (one PO discussion
// carried four messages back and forth). Both numbers are reported; neither is
// presented as the other.
export function groupInbox(emails = [], now = Date.now()) {
  const unread = emails.filter((e) => e.isUnread)
  const groups = new Map()
  for (const e of unread) {
    const key = senderKey(e)
    let g = groups.get(key)
    if (!g) {
      g = { key, from: e.fromName || e.fromAddress || 'unknown', address: e.fromAddress || null,
            count: 0, threadIds: new Set(), oldestDays: 0, latestId: e.id }
      groups.set(key, g)
    }
    g.count += 1
    if (e.threadId) g.threadIds.add(e.threadId)
    g.oldestDays = Math.max(g.oldestDays, ageDays(e.receivedAt, now))
  }
  return [...groups.values()]
    // The domain rides along because display names lie by being generic: the 7
    // busiest unread on 2026-08-05 all read "Customer Service Representative",
    // which says nothing until you see `bloomingdales.com`.
    .map((g) => ({ key: g.key, from: g.from, address: g.address, domain: domainOf(g.address), count: g.count,
                   threads: g.threadIds.size || g.count, oldestDays: g.oldestDays, latestId: g.latestId }))
    .sort((a, b) => (b.count - a.count) || (b.oldestDays - a.oldestDays) || a.from.localeCompare(b.from))
}

// A recurring instance is a task the scheduler materialised from a template
// (quest_tasks.recurring_key). Open ones are today's rhythms.
export const isRhythm = (t) => !!t && t.status === 'open' && !!t.recurringKey

export function buildCatchUp(emails = [], tasks = [], opts = {}) {
  const now = opts.now ?? Date.now()
  const senders = groupInbox(emails, now)
  const unread = senders.reduce((n, s) => n + s.count, 0)
  const threads = senders.reduce((n, s) => n + s.threads, 0)
  // Steps, when the template defines them. Nima, 2026-08-05, on what looked
  // like three separate daily nags: "those are all one task honestly btw" — the
  // Airtable job is a NetSuite → Airtable → NetSuite → Airtable round trip. A
  // three-step job shown as one tick is how step 2 gets skipped; showing the
  // steps is what lets a half-finished one RESUME, which is the actual
  // "most tasks end up only partially done" complaint.
  const rhythms = tasks.filter(isRhythm).map((t) => ({
    id: t.id,
    subject: t.subject || 'recurring task',
    steps: (t.checklist || []).map((c) => ({ key: c.key, label: c.label, url: c.url || null, done: !!c.done })),
    // Only a 'verified' task's steps actually GATE completion (runVerification
    // in server/queries.js refuses while any is unticked), so the band must not
    // imply a gate that isn't there.
    gated: t.completionMode === 'verified',
    // The basis the urgency deriver already computed, so the band can never
    // describe a task differently from the Tasks view (same lesson as
    // labelGap.js: one call, one sentence).
    basis: t.urgencyBasis || 'recurring',
    recurringKey: t.recurringKey,
  }))
  return {
    inbox: {
      unread,
      threads,
      senders,
      oldestDays: senders.reduce((n, s) => Math.max(n, s.oldestDays), 0),
    },
    rhythms,
    // Absence is the all-clear: an empty band renders nothing at all rather
    // than a "nothing to catch up on ✓" panel taking morning space.
    empty: unread === 0 && rhythms.length === 0,
  }
}
