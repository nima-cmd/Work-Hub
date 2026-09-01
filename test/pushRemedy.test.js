// test/pushRemedy.test.js — when a ShipStation push refuses, what can be done about it?
import test from 'node:test'
import assert from 'node:assert/strict'
import { pushRemedy, REMEDY, KILLED_MESSAGE } from '../src/model/pushRemedy.js'

// The real responses, captured from /api/shipstation/push on 2026-08-31.
const TRACKING_ = ['1ZC6J6100326198585', '1ZC6J6100330224976', '1ZC6J6100335725792']
// ⚠️ `tracking` on the refusal is what the SERVER sends — it computed the hold from those
// numbers, so they are the only ones that can be right.
const ALREADY = { pushed: 0, seen: 1, forced: true, skipped: [{ ifNumber: 'IF7616', hold: 'ALREADY_LABELLED', reason: "already has 3 labels — ShipStation's job is done", tracking: TRACKING_ }] }
const WAREHOUSE = { pushed: 0, seen: 1, skipped: [{ ifNumber: 'IF7616', soNumber: 'SO12303', reason: 'Warehouse orders are labelled by NetSuite when it fulfils them; pushing would create a second live label on the same box' }] }
const TRACKING = ['1ZC6J6100326198585', '1ZC6J6100330224976', '1ZC6J6100335725792']

test('⚠️ ALREADY_LABELLED OFFERS THE DEAD-LABEL ROUTE, never a force', () => {
  // A second live label is a double charge and a wrong number on the ASN, so force must
  // never lift this. The way through is to declare the existing labels unusable — a
  // statement about the world, not an override of a rule.
  const r = pushRemedy(ALREADY, { forced: true })
  assert.equal(r.ok, false)
  assert.equal(r.remedy, REMEDY.KILL_LABELS)
  assert.deepEqual(r.killable, TRACKING)
  assert.notEqual(r.remedy, REMEDY.FORCE)
})

test('⚠️ with no tracking numbers there is NOTHING to offer, and it says so', () => {
  // A control that cannot work is the dead-button shape fixed for FOB China in #192.
  const r = pushRemedy({ ...ALREADY, skipped: [{ ...ALREADY.skipped[0], tracking: [] }] }, {})
  assert.equal(r.remedy, REMEDY.NONE)
  assert.deepEqual(r.killable, [])
  assert.match(r.reason, /already has 3 labels/)
})

test('the Warehouse block is forceable — it is a conflict, not a fact', () => {
  // NetSuite labels the box; forcing past it is the documented break-glass used for
  // IF7610 when NetSuite's label was made for the wrong carton count.
  const r = pushRemedy(WAREHOUSE, {})
  assert.equal(r.remedy, REMEDY.FORCE)
  assert.equal(r.hold, null, 'a location block carries no hold key')
})

test('a second refusal after forcing offers nothing more', () => {
  assert.equal(pushRemedy(WAREHOUSE, { forced: true }).remedy, REMEDY.NONE)
})

test('⚠️ CHINA AND AN ABSENT LOCATION ARE NOT FORCEABLE — they are facts', () => {
  // "we never make the label" and "no location" would both push something broken.
  // Matching the previous behaviour deliberately: the old regex refused both.
  const china = { pushed: 0, seen: 1, skipped: [{ reason: 'FOB China — the goods await collection there and we never dispatch them, so we never make the label' }] }
  const nowhere = { pushed: 0, seen: 1, skipped: [{ reason: 'no location on the order — an absent field must not unblock a live write' }] }
  assert.equal(pushRemedy(china, {}).remedy, REMEDY.NONE)
  assert.equal(pushRemedy(nowhere, {}).remedy, REMEDY.NONE)
})

test('⚠️ THE HOLD KEY DECIDES, NOT THE SENTENCE', () => {
  // The previous implementation was a regex over prose:
  //   /NetSuite/i.test(reason) && !/already has/i.test(reason)
  // so rewording a server message would silently change which button the operator got.
  // An eligibility hold whose text happens to mention NetSuite must still not be forced.
  const worded = { pushed: 0, seen: 1, skipped: [{ hold: 'NOT_PICKED', reason: 'NetSuite says this is not picked yet' }] }
  assert.equal(pushRemedy(worded, {}).remedy, REMEDY.NONE)
  // And ALREADY_LABELLED is recognised by its key even if the wording changes entirely.
  const reworded = { pushed: 0, seen: 1, skipped: [{ hold: 'ALREADY_LABELLED', reason: 'this box is done' }] }
  assert.equal(pushRemedy({ ...reworded, skipped: [{ ...reworded.skipped[0], tracking: ['1Z'] }] }, {}).remedy, REMEDY.KILL_LABELS)
})

test('a successful push reports the order number to paste into ShipStation', () => {
  const r = pushRemedy({ pushed: 1, results: [{ orderNumber: 'SO12303' }] })
  assert.equal(r.ok, true)
  assert.equal(r.orderNumber, 'SO12303')
  assert.equal(r.remedy, REMEDY.NONE)
  // ⚠️ The records[] shape is also accepted — both appear in live responses.
  assert.equal(pushRemedy({ pushed: 1, records: [{ orderNumber: 'X' }] }).orderNumber, 'X')
  // A push with no number still reads as ok rather than inventing one.
  assert.equal(pushRemedy({ pushed: 1 }).orderNumber, null)
})

test('out of scope reads as out of scope, not as a silent nothing', () => {
  const r = pushRemedy({ pushed: 0, seen: 0, skipped: [] })
  assert.match(r.reason, /not in the push scope/)
  assert.equal(r.remedy, REMEDY.NONE)
})

test('a refusal with no reason at all still says something', () => {
  assert.match(pushRemedy({ pushed: 0, seen: 1, skipped: [] }).reason, /held, with no reason given/)
})

test('the killed message counts correctly', () => {
  assert.match(KILLED_MESSAGE(1), /^1 label marked unusable/)
  assert.match(KILLED_MESSAGE(3), /^3 labels marked unusable/)
  assert.match(KILLED_MESSAGE(3), /push again/)
})
