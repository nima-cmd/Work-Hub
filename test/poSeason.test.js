// test/poSeason.test.js — inferring a PO's season from its items.
//
// ⚠️ EVERY FIXTURE HERE IS A REAL PO FROM THE THREE LIVE CONTAINERS, measured 2026-09-16.
// The load-bearing tests are the ones where the answer is NO ANSWER: an exact tie, a PO
// with no seasons at all, and a PO that is mostly evergreen. A function that always
// returns a season would file freight against a launch on a coin flip.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSeason, suggestPoSeason, seasonFor, SEASONS, EVERGREEN, NOT_SEASONS, REASONS,
} from '../src/model/poSeason.js'

test('the five seasons a year, and Core is not one of them', () => {
  assert.deepEqual(SEASONS, ['Spring', 'Summer', 'Fall', 'Holiday', 'Resort'])
  assert.equal(parseSeason('Spring 2026').kind, 'season')
  assert.equal(parseSeason('Holiday 2026').season, 'Holiday')
  assert.equal(parseSeason('Resort 2026').year, 2026)
  // ⚠️ Core parses to its OWN kind, never to a season.
  assert.equal(parseSeason(EVERGREEN).kind, 'evergreen')
  assert.notEqual(parseSeason(EVERGREEN).kind, 'season')
})

test("⚠️ a stored ERROR string is not a season — it is in the catalogue right now", () => {
  // One item's custitem_season_year literally contains a broken formula's output.
  assert.equal(parseSeason("ERROR: Field 'custitem_season' Not Found"), null)
  assert.equal(parseSeason('Internal'), null)
  assert.equal(parseSeason(''), null)
  assert.equal(parseSeason(null), null)
  assert.ok(NOT_SEASONS.has('Internal'))
})

test('⚠️ a program is not folded into a season', () => {
  // "Shopbop Exclusive 2023" behaves like a season for planning and is NOT one of the
  // five drops — calling it Spring would attach it to a launch it has nothing to do with.
  const p = parseSeason("Bloomingdale's Exclusive 2024")
  assert.equal(p.kind, 'program')
  assert.equal(p.program, "Bloomingdale's Exclusive")
  assert.equal(p.year, 2024)
  assert.equal(parseSeason('Waste Not 2025').kind, 'program')
  // ⚠️ "Curated Shop 2025 2025" is real — the year is duplicated in the stored value.
  const dup = parseSeason('Curated Shop 2025 2025')
  assert.equal(dup.program, 'Curated Shop', 'the repeated year is trimmed, not kept')
  assert.equal(dup.year, 2025)
})

test('PO1785 — 1,330 units of one season, unambiguous', () => {
  const s = suggestPoSeason([{ season: 'Holiday 2026', units: 1330 }])
  assert.equal(s.suggestion.label, 'Holiday 2026')
  assert.equal(s.confident, true)
  assert.equal(s.reason, REASONS.launch.key)
  assert.match(s.why, /1330 of 1330 units are Holiday 2026 \(100%\)/)
})

test('PO1722 — a clear majority is confident', () => {
  const s = suggestPoSeason([
    { season: 'Fall 2026', units: 765 },
    { season: 'Holiday 2026', units: 75 },
  ])
  assert.equal(s.suggestion.label, 'Fall 2026')
  assert.equal(s.confident, true, '765 of 840 is a majority')
  assert.match(s.why, /next is Holiday 2026 at 75/)
})

test('⚠️ PO1747 — AN EXACT TIE IS REFUSED, NOT SORTED', () => {
  // Resort 2026 = 350, Holiday 2026 = 350. Whichever sorted first would have decided
  // 350 units of real freight, from a coin flip nobody would have seen.
  const s = suggestPoSeason([
    { season: 'Resort 2026', units: 350 },
    { season: 'Holiday 2026', units: 350 },
  ])
  assert.equal(s.suggestion, null)
  assert.equal(s.confident, false)
  assert.match(s.why, /tied at 350 units each/)
  assert.match(s.why, /needs a person/)
  // The mix is still returned so the person deciding can see both.
  assert.equal(s.mix.length, 2)
})

test('⚠️ PO1761 — 720 units and not one item carries a season', () => {
  const s = suggestPoSeason([{ season: null, units: 720 }])
  assert.equal(s.suggestion, null)
  assert.equal(s.confident, false)
  assert.equal(s.unknownUnits, 720)
  assert.equal(s.total, 720, 'the units still count — "nothing to go on" is not "no stock"')
  assert.match(s.why, /not one item carries a season/)
})

test('⚠️ PO1758 — mostly Core reads as a RESTOCK, not as its seasonal tail', () => {
  // 1,290 Core units and a scatter of old seasons. Suggesting "Spring 2026" off the
  // 115-unit tail would file a restock against a launch.
  const s = suggestPoSeason([
    { season: 'Core', units: 1290 },
    { season: 'Spring 2026', units: 115 },
    { season: 'Fall 2025', units: 110 },
    { season: 'Summer 2026', units: 50 },
  ])
  assert.equal(s.suggestion.kind, 'evergreen')
  assert.equal(s.reason, REASONS.restock.key)
  assert.equal(s.confident, true)
  assert.match(s.why, /1290 of 1565 units are Core/)
  assert.match(s.why, /restock rather than a drop/)
})

test('⚠️ a bare plurality is NOT confidence — PO1754 spreads three ways', () => {
  // Spring 2027 = 370 of 595. That IS a majority. But drop it below half and the flag
  // has to fall, because "biggest of four scattered seasons" is exactly the case a
  // person is being asked to settle.
  const majority = suggestPoSeason([
    { season: 'Spring 2027', units: 370 }, { season: 'Core', units: 150 }, { season: 'Spring 2025', units: 75 },
  ])
  assert.equal(majority.suggestion.label, 'Spring 2027')
  assert.equal(majority.confident, true, '370 of 595 is over half')

  const plurality = suggestPoSeason([
    { season: 'Spring 2027', units: 200 }, { season: 'Core', units: 190 }, { season: 'Spring 2025', units: 180 },
  ])
  assert.equal(plurality.suggestion.label, 'Spring 2027', 'still the best guess')
  assert.equal(plurality.confident, false, 'but 200 of 570 is not a majority')
})

test('units with no season are counted in the total, never dropped', () => {
  const s = suggestPoSeason([
    { season: 'Holiday 2026', units: 100 },
    { season: null, units: 400 },
  ])
  assert.equal(s.total, 500)
  assert.equal(s.unknownUnits, 400)
  // ⚠️ AND THEY BREAK CONFIDENCE. 100 of 500 is not a majority, so a PO whose seasons
  // are mostly missing cannot be auto-accepted off its minority.
  assert.equal(s.confident, false)
  assert.match(s.why, /400 units carry no season/)
})

test('⚠️ confirmed beats suggested — and a disagreement is named, not blocked', () => {
  const po = {
    season: 'Resort 2026', seasonBy: 'Nima', drop: 1, reason: 'launch',
    lines: [{ season: 'Holiday 2026', units: 1330 }],
  }
  const s = seasonFor(po)
  assert.equal(s.state, 'confirmed')
  assert.equal(s.label, 'Resort 2026', "the person's answer wins")
  assert.equal(s.drop, 1)
  assert.equal(s.by, 'Nima')
  // ⚠️ Not blocked — they may know something the catalogue does not. The disagreement
  // IS the signal, so it is surfaced.
  assert.match(s.differs, /items on this PO are mostly Holiday 2026/)
  assert.equal(s.suggestion, 'Holiday 2026')
})

test('an unconfirmed PO reports as suggested, or honestly as unknown', () => {
  const suggested = seasonFor({ lines: [{ season: 'Holiday 2026', units: 1330 }] })
  assert.equal(suggested.state, 'suggested')
  assert.equal(suggested.label, 'Holiday 2026')
  assert.equal(suggested.drop, null, 'a drop is never inferred — only a season is')

  const unknown = seasonFor({ lines: [{ season: null, units: 720 }] })
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.label, null)

  const tied = seasonFor({ lines: [{ season: 'Resort 2026', units: 350 }, { season: 'Holiday 2026', units: 350 }] })
  assert.equal(tied.state, 'unknown', 'a tie is unknown, not a suggestion')
})

test('the three reasons are restock, launch and re-order', () => {
  assert.deepEqual(Object.keys(REASONS), ['restock', 'launch', 'reorder'])
  assert.match(REASONS.reorder.detail, /link the OC or SO/)
})
