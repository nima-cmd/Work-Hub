// test/crewRank.test.js — rank is conferred, bond is earned, and they never merge.
//
// Nima, 2026-09-18: "i want affection and rank to be two separate things. affection
// could make the case to promote but i think the promotion should be left to me."
//
// The load-bearing tests are the ones that prove the SEPARATION: Yoda has 3,531
// affection and 236 completed missions and still starts a Recruit, and nothing in this
// module can promote him.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RANKS, STARTING_RANK, rankFor, heldRank, canMan, recommend, promotionBoard,
} from '../src/model/crewRank.js'

test('the ladder runs Recruit to Commander, lowest first', () => {
  assert.equal(RANKS[0].key, 'recruit')
  assert.equal(RANKS[RANKS.length - 1].key, 'commander')
  // Levels are dense and ascending, so comparisons cannot skip a rung.
  RANKS.forEach((r, i) => assert.equal(r.level, i + 1))
})

test('⚠️ everyone starts at the bottom, INCLUDING the most-bonded character', () => {
  // Yoda: 3,531 affection, 236 completed missions. Seeding rank from that would merge
  // the two systems in the first five minutes of building them apart.
  const yoda = heldRank(null)
  assert.equal(yoda.key, STARTING_RANK)
  assert.equal(yoda.granted, false, 'nobody granted this — it is the default')
})

test('a granted rank records WHO and WHEN', () => {
  const r = heldRank({ rank: 'major', grantedBy: 'Nima', grantedAt: '2026-09-18' })
  assert.equal(r.name, 'Major')
  assert.equal(r.granted, true)
  assert.equal(r.by, 'Nima')
  assert.equal(r.at, '2026-09-18')
})

test('⚠️ an unrecognised stored rank is REPORTED, never silently demoted', () => {
  // A typo or a rank dropped from the ladder must not look like a decision somebody
  // made to bust them down to Recruit.
  const r = heldRank({ rank: 'admiral' })
  assert.equal(r.unknown, true)
  assert.notEqual(r.key, STARTING_RANK)
  assert.equal(rankFor('admiral'), null)
})

// ── Who may man what ────────────────────────────────────────────────────────

test('rank gates a post, and says what would fix it', () => {
  const no = canMan({ rank: 'private' }, 'commander')
  assert.equal(no.ok, false)
  assert.equal(no.short, 7)
  assert.match(no.why, /Commander is required here and they are Private/)

  const yes = canMan({ rank: 'commander' }, 'commander')
  assert.equal(yes.ok, true)
})

test('a rank above the minimum still qualifies', () => {
  assert.equal(canMan({ rank: 'general' }, 'corporal').ok, true)
})

test('⚠️ a building with no minimum is open to all, deliberately', () => {
  // Most posts should be. A missing minRank must not lock a door nobody meant to lock.
  const r = canMan(null, null)
  assert.equal(r.ok, true)
  assert.match(r.why, /no rank requirement/)
})

test('⚠️ an unknown stored rank cannot be posted anywhere gated', () => {
  const r = canMan({ rank: 'admiral' }, 'private')
  assert.equal(r.ok, false)
  assert.match(r.why, /not on the ladder/)
})

// ── The recommendation, which is only ever a recommendation ─────────────────

test('⚠️ bond makes the CASE and carries the evidence', () => {
  const r = recommend({
    bond: { tier: 6, name: 'Bonded', points: 3531 },
    record: null,
    missions: 236,
  })
  assert.equal(r.promote, true)
  assert.equal(r.held.key, 'recruit')
  // The evidence is in the sentence — a screen must never ask "promote?" with no basis.
  assert.match(r.why, /Bonded/)
  assert.match(r.why, /3531/)
  assert.match(r.why, /236 completed missions/)
  assert.match(r.why, /still Recruit/)
})

test('⚠️ NOTHING here applies a promotion — it only returns a target', () => {
  const r = recommend({ bond: { tier: 6, name: 'Bonded', points: 3531 }, record: null, missions: 236 })
  // The recommendation names a target rank and changes nothing about the record.
  assert.ok(r.target)
  const stillHeld = heldRank(null)
  assert.equal(stillHeld.key, 'recruit')
})

test('⚠️ bond can never justify the top two ranks', () => {
  // Six bond tiers across nine ranks, stopping short on purpose: General and Commander
  // are Nima's to give, not something quest completion can earn on its own.
  const top = recommend({ bond: { tier: 6, name: 'Bonded', points: 9999 }, record: null, missions: 500 })
  assert.equal(top.target.key, 'major')
  assert.ok(top.target.level < RANKS.find((r) => r.key === 'general').level)
})

test('somebody already at or above their earned ceiling gets no case made', () => {
  const r = recommend({
    bond: { tier: 2, name: 'Acquaintance', points: 60 },
    record: { rank: 'sergeant' },
    missions: 4,
  })
  assert.equal(r.promote, false)
  assert.match(r.why, /already matches or exceeds/)
})

test('no bond yet means no case, not a promotion to Recruit', () => {
  const r = recommend({ bond: null, record: null, missions: 0 })
  assert.equal(r.promote, false)
  assert.match(r.why, /nothing to make a case with/)
})

// ── The bootstrap screen ────────────────────────────────────────────────────

test('⚠️ the board returns EVERYONE, strongest case first', () => {
  const board = promotionBoard([
    { id: 'stranger', bond: { tier: 1, name: 'Stranger', points: 10 }, record: null, missions: 1 },
    { id: 'yoda', bond: { tier: 6, name: 'Bonded', points: 3531 }, record: null, missions: 236 },
    { id: 'anya', bond: { tier: 6, name: 'Bonded', points: 1949 }, record: { rank: 'corporal' }, missions: 132 },
  ])
  // All three are present — hiding the settled ones would break the 43-character pass.
  assert.equal(board.length, 3)
  // Yoda leads: furthest below what he has earned.
  assert.equal(board[0].id, 'yoda')
  assert.equal(board[1].id, 'anya')
  // A Stranger at Recruit has no case and sorts last.
  assert.equal(board[2].id, 'stranger')
  assert.equal(board[2].recommendation.promote, false)
})
