// test/characters.test.js — the roster and the art folder must agree.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { CHARACTERS, getCharacterById, resolveCharacterForSender } from '../src/model/characters.js'

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
  // `universe` prints on the trading card and the hologram. Five of the portraits
  // added 2026-09-11 could not be identified from the art, and a guessed franchise
  // would read as a fact. null renders empty, which is honest.
  const unknown = CHARACTERS.filter((c) => c.universe === null).map((c) => c.id)
  assert.deepEqual(unknown.sort(),
    ['alicia-glenfall', 'clen', 'coco', 'nemu-miyao', 'nico-wakatsuki'])
  // Everything else must be a real non-empty string — not '', not undefined.
  for (const c of CHARACTERS) {
    if (c.universe === null) continue
    assert.ok(typeof c.universe === 'string' && c.universe.trim(), `${c.id} universe is empty`)
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
