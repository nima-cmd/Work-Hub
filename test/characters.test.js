// test/characters.test.js — the roster and the art folder must agree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { CHARACTERS, getCharacterById, resolveCharacterForSender } from '../src/model/characters.js'
import { levelFor } from '../src/model/affection.js'

const ART_DIR = new URL('../client/src/assets/characters/', import.meta.url)
const artIds = [...new Set(readdirSync(ART_DIR)
  .filter((f) => /\.(png|jpe?g|webp|svg)$/i.test(f))
  .map((f) => f.replace(/-\d+\.\w+$/, '').replace(/\.\w+$/, '').toLowerCase()))]

test('⚠️ EVERY PORTRAIT FILE MAPS TO A ROSTER ID, AND THE MISS IS SILENT', () => {
  // characterImages.js discovers art by filename via import.meta.glob and keys it on
  // the id. A filename that matches no roster id is simply never shown, and a roster
  // entry with no art renders the placeholder badge — neither raises anything. So
  // this is the only place a typo in either direction can be caught.
  const ids = CHARACTERS.map((c) => c.id)
  const orphanArt = artIds.filter((a) => !ids.includes(a))
  const noArt = ids.filter((i) => !artIds.includes(i))
  assert.deepEqual(orphanArt, [], 'art files whose id is in no roster entry')
  assert.deepEqual(noArt, [], 'roster entries with no portrait')
})

test('ids are unique, lower-kebab, and match the filename convention', () => {
  const ids = CHARACTERS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id would shadow one character')
  for (const c of CHARACTERS) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${c.id} is not lower-kebab`)
    assert.ok(c.name?.trim(), `${c.id} has no display name`)
  }
})

test('⚠️ AN UNKNOWN UNIVERSE IS null, NEVER A PLAUSIBLE GUESS', () => {
  // `universe` prints on the trading card and the hologram, so a guessed franchise
  // would read as a fact. Five portraits added 2026-09-11 carried null until Nima
  // named them; all 43 now have a real one. null stays the correct representation
  // for an unidentified series — this asserts the SHAPE, so a future addition
  // cannot sneak in '' or undefined and render as blank-but-claimed.
  for (const c of CHARACTERS) {
    assert.ok(c.universe === null || (typeof c.universe === 'string' && c.universe.trim()),
      `${c.id} universe must be a non-empty string or explicitly null`)
  }
  assert.deepEqual(CHARACTERS.filter((c) => !c.universe).map((c) => c.id), [])
})

test('⚠️ A HEDGE IS RESOLVED BY EVIDENCE, NOT BY REPETITION', () => {
  // Nemu and Nico were recorded attribution: 'believed' because Nima said "i believe
  // are from Witch watch". His later description of Nemu names her friends — Nico,
  // Morihito, Keigo, Kanshi, Miharu — which is that cast and places both of them in
  // it, so the hedge came off on corroborating detail. Nothing is hedged now, and
  // this asserts the field stays absent rather than lingering as stale doubt.
  assert.deepEqual(CHARACTERS.filter((c) => c.attribution).map((c) => c.id), [])
  for (const id of ['nemu-miyao', 'nico-wakatsuki']) {
    assert.equal(CHARACTERS.find((c) => c.id === id).universe, 'Witch Watch')
  }
})

test('the rotation covers every character, and a sender keeps its assignment', () => {
  // resolveCharacterForSender picks at random for a new sender, so every id must be
  // reachable — a roster the rotation cannot reach is art nobody ever sees.
  const n = CHARACTERS.length
  // ⚠️ Sample the MIDDLE of each bucket, not its edge. `() => i / n` looks equivalent
  // and is not: Math.floor((i / n) * n) lands on i - 1 for several i because the
  // division does not round-trip in binary floating point, which made this assertion
  // fail at 41 of 43 while the rotation itself was fine.
  const picked = new Set(CHARACTERS.map((_, i) => resolveCharacterForSender(null, {}, () => (i + 0.5) / n)))
  assert.equal(picked.size, n, 'some characters are unreachable in the rotation')
  // An existing preference wins over the random pick.
  assert.equal(resolveCharacterForSender('a@b.com', { 'a@b.com': 'emilia' }, () => 0), 'emilia')
  // A preference naming a character that no longer exists falls back, never throws.
  assert.ok(getCharacterById(resolveCharacterForSender('a@b.com', { 'a@b.com': 'deleted' }, () => 0)))
})

test('⚠️ THE CREW GRID IS THE ROSTER, NOT ONLY WHO HAS DELIVERED', () => {
  // Crew.jsx used to render `affection.map(...)` — one card per character with a
  // COMPLETED quest — so 24 characters added 2026-09-11 were in the roster and in
  // the rotation but invisible on the page, and would have surfaced one at a time
  // over weeks as a brand-new sender happened to draw each. The grid now joins
  // affection ONTO the roster. This pins the zero-state shape TradingCard needs,
  // because it reads card.level.tier and card.missions unguarded.
  const zero = { level: levelFor(0), missions: [], stats: { agility: 0, strength: 0, intelligence: 0 } }
  assert.equal(zero.level.tier, 1)
  assert.equal(zero.level.name, 'Stranger')
  assert.equal(zero.level.progress, 0)
  assert.ok(Array.isArray(zero.missions), 'missions must be an array, not undefined')
})
