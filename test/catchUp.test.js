import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCatchUp, groupInbox, isRhythm } from '../src/model/catchUp.js'
import { buildRouteItems } from '../src/model/routeItems.js'

const NOW = new Date('2026-08-05T14:00:00Z').getTime()
const ago = (d) => new Date(NOW - d * 86400000).toISOString()

// The live inbox on 2026-08-05: 19 unread, 14 threads, 7 senders — 8 of the 19
// from one automated Bloomingdale's Marketplace address. The collapse IS the
// feature, so it's what the tests pin.
const bloomie = (i) => ({
  id: 'b' + i, threadId: 't-b' + i, isUnread: true, receivedAt: ago(i % 3),
  fromAddress: 'customer.service@bloomingdales.com', fromName: 'Customer Service Representative',
  subject: 'Bloomingdale’s order ' + i,
})

test('unread email collapses to senders, busiest first', () => {
  const emails = [
    ...[1, 2, 3, 4].map(bloomie),
    { id: 'g1', threadId: 'tg', isUnread: true, receivedAt: ago(2), fromAddress: 'g@x.com', fromName: 'Geneva Campbell', subject: 'LA x NY Weekly Status' },
    { id: 'g2', threadId: 'tg', isUnread: true, receivedAt: ago(2), fromAddress: 'g@x.com', fromName: 'Geneva Campbell', subject: 'Re: LA x NY Weekly Status' },
  ]
  const senders = groupInbox(emails, NOW)
  assert.equal(senders.length, 2)
  assert.equal(senders[0].count, 4)              // Bloomingdale's leads on volume
  assert.equal(senders[1].from, 'Geneva Campbell')
  // Two messages, ONE conversation — a reply is owed per thread, and the two
  // numbers are reported separately rather than one standing in for the other.
  assert.equal(senders[1].count, 2)
  assert.equal(senders[1].threads, 1)
})

test('a read message is not catch-up work', () => {
  const emails = [{ id: 'r', threadId: 'tr', isUnread: false, receivedAt: ago(0), fromAddress: 'x@y.com' }]
  const c = buildCatchUp(emails, [], { now: NOW })
  assert.equal(c.inbox.unread, 0)
  assert.equal(c.empty, true)
})

test('oldest age is per sender and never averaged', () => {
  const emails = [
    { id: 'a', threadId: '1', isUnread: true, receivedAt: ago(0), fromAddress: 'a@x.com', fromName: 'A' },
    { id: 'b', threadId: '2', isUnread: true, receivedAt: ago(5), fromAddress: 'a@x.com', fromName: 'A' },
  ]
  const [g] = groupInbox(emails, NOW)
  assert.equal(g.oldestDays, 5)
  assert.equal(buildCatchUp(emails, [], { now: NOW }).inbox.oldestDays, 5)
})

test("today's rhythms are the open recurring instances, with their own basis", () => {
  const tasks = [
    { id: 1, status: 'open', recurringKey: 'weaver-netsuite-update', subject: 'Update Weaver → NetSuite', urgencyBasis: 'recurring, due today' },
    { id: 2, status: 'done', recurringKey: 'csv-freshness-monitor', subject: 'Upload the latest CSVs' },
    { id: 3, status: 'open', recurringKey: null, subject: 'Reply to Geneva' },
  ]
  const c = buildCatchUp([], tasks, { now: NOW })
  assert.equal(c.rhythms.length, 1)
  assert.equal(c.rhythms[0].id, 1)
  assert.equal(c.rhythms[0].basis, 'recurring, due today')
  assert.equal(isRhythm(tasks[2]), false)
})

// THE PARTITION. The band and the day plan must never both carry the same work:
// before this, a 15-minute daily rhythm sorted by EDF in among cutoff-bound
// routing legs and could take a slot ahead of them.
test('a rhythm is on the band and NOT on the route; an ordinary task stays a leg', () => {
  const tasks = [
    { id: 1, status: 'open', recurringKey: 'weaver-netsuite-update', subject: 'Update Weaver → NetSuite' },
    { id: 2, status: 'open', recurringKey: null, subject: 'Re: 6x6x4 Box Quote' },
  ]
  const items = buildRouteItems([], tasks, null, { now: NOW })
  const taskLegs = items.filter((i) => i.taskId)
  assert.deepEqual(taskLegs.map((i) => i.taskId), [2])

  const c = buildCatchUp([], tasks, { now: NOW })
  assert.deepEqual(c.rhythms.map((r) => r.id), [1])
  // Every open task is accounted for exactly once across the two surfaces.
  assert.equal(taskLegs.length + c.rhythms.length, tasks.length)
})

test('nothing to catch up on renders nothing', () => {
  assert.equal(buildCatchUp([], [], { now: NOW }).empty, true)
  assert.equal(buildCatchUp([], [{ id: 9, status: 'open', recurringKey: 'x', subject: 'y' }], { now: NOW }).empty, false)
})

test('a generic display name still says who it is, via the domain', () => {
  const [g] = groupInbox([{
    id: 'x', threadId: 'tx', isUnread: true, receivedAt: ago(0),
    fromAddress: 'customer.service@Bloomingdales.com', fromName: 'Customer Service Representative',
  }], NOW)
  assert.equal(g.domain, 'bloomingdales.com')
})
