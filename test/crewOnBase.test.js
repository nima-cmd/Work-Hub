// test/crewOnBase.test.js — faces on the Base: who mans a building, who walks the roads.
//
// Nima, 2026-09-18: "have the dots walking around be the images of the other crew
// members random generated not including the ones assigned to a building for that day."

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postingsForBase, crewOnRoads } from '../src/model/crewOnBase.js'
import { canMan } from '../src/model/crewRank.js'

const ROSTER = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }))
const MOVERS = Array.from({ length: 6 }, (_, i) => ({ id: `ev${i}`, road: 'r' }))

test('⚠️ the posted crew never appear on the roads', () => {
  const posted = new Set(['c0', 'c1', 'c2'])
  const out = crewOnRoads({ movers: MOVERS, roster: ROSTER, postedIds: posted })
  for (const m of out) assert.ok(!posted.has(m.characterId), `${m.characterId} is on duty`)
})

test('⚠️ the same mover always gets the same face — seeded, never random', () => {
  // baseMap already asserts "the same feed always produces the same base". Math.random()
  // would reshuffle every face on every render and the map would flicker.
  const a = crewOnRoads({ movers: MOVERS, roster: ROSTER })
  const b = crewOnRoads({ movers: MOVERS, roster: ROSTER })
  assert.deepEqual(a.map((m) => m.characterId), b.map((m) => m.characterId))
})

test('different movers get different faces while spares remain', () => {
  const out = crewOnRoads({ movers: MOVERS, roster: ROSTER })
  const ids = out.map((m) => m.characterId)
  assert.equal(new Set(ids).size, ids.length, 'no repeats with 10 crew and 6 movers')
})

test('⚠️ a roster smaller than the movers REPEATS a face rather than leaving a blank dot', () => {
  const out = crewOnRoads({ movers: MOVERS, roster: [{ id: 'only' }] })
  assert.equal(out.length, 6)
  for (const m of out) assert.equal(m.characterId, 'only')
})

test('⚠️ nobody available is an honest empty, not a crash', () => {
  const out = crewOnRoads({ movers: MOVERS, roster: ROSTER, postedIds: new Set(ROSTER.map((c) => c.id)) })
  assert.equal(out.length, 6)
  for (const m of out) assert.equal(m.characterId, null)
})

test('no movers means no faces, not a crash', () => {
  assert.deepEqual(crewOnRoads({ movers: [], roster: ROSTER }), [])
})

// ── Postings ────────────────────────────────────────────────────────────────

const BUILDINGS = [{ key: 'ops', minRank: 'major' }, { key: 'barracks', minRank: null }]

test('a posting resolves to a character and their rank', () => {
  const out = postingsForBase({
    postings: [{ building: 'ops', characterId: 'yoda' }],
    ranks: new Map([['yoda', { rank: 'general' }]]),
    buildings: BUILDINGS, canMan,
  })
  assert.equal(out.ops.characterId, 'yoda')
  assert.equal(out.ops.rank, 'general')
  assert.equal(out.ops.underRanked, false)
})

test('⚠️ somebody posted BELOW their building\'s rank is FLAGGED, not hidden', () => {
  // A rank can be cleared, or a requirement raised, after a posting was made. Dropping
  // them would make the building read "unmanned" while somebody is standing in it.
  const out = postingsForBase({
    postings: [{ building: 'ops', characterId: 'anya' }],
    ranks: new Map([['anya', { rank: 'private' }]]),
    buildings: BUILDINGS, canMan,
  })
  assert.equal(out.ops.characterId, 'anya', 'still shown')
  assert.equal(out.ops.underRanked, true)
  assert.match(out.ops.why, /Major is required/)
})

test('an unranked person posted to an unranked building is fine', () => {
  const out = postingsForBase({
    postings: [{ building: 'barracks', characterId: 'fern' }],
    ranks: new Map(), buildings: BUILDINGS, canMan,
  })
  assert.equal(out.barracks.underRanked, false)
})

test('a malformed posting is skipped rather than drawn as a blank', () => {
  const out = postingsForBase({
    postings: [{ building: 'ops' }, { characterId: 'x' }, null],
    ranks: new Map(), buildings: BUILDINGS, canMan,
  })
  assert.deepEqual(Object.keys(out), [])
})
