// src/model/crewRank.js — rank, which is CONFERRED, kept apart from bond, which is EARNED.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ The crew have two separate scores, and this file exists to keep them        │
// │ separate:                                                                   │
// │                                                                             │
// │   BOND  — how much you and that character have worked together. It goes up  │
// │           on its own as quests get completed. Nobody awards it.             │
// │   RANK  — what authority they hold: Recruit, Private, Corporal … Commander. │
// │           ONLY you can grant it. It never rises by itself.                  │
// │                                                                             │
// │ Nima, 2026-09-18: "i want affection and rank to be two separate things.     │
// │ affection could make the case to promote but i think the promotion should   │
// │ be left to me."                                                             │
// │                                                                             │
// │ So bond writes a RECOMMENDATION — "this person has earned a promotion, and  │
// │ here is the evidence" — and that is the whole of its power. The promotion   │
// │ itself is a thing you do.                                                   │
// │                                                                             │
// │ Each building needs a minimum rank to be manned. The Command Center needs   │
// │ the top one; the Archive and Almanac need almost none.                      │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ RANK IS STORED, BOND IS COMPUTED, AND THAT IS THE WHOLE DESIGN ────────────
//
// `affection` is derived from completed quest_tasks every time it is asked for — it is
// an OBSERVATION. A rank is an ENTERED value: somebody decided it, on a date, and it
// stays until somebody decides otherwise. This repo's standing rule ([[prefer-entered-
// over-derived]]) is that the two must be schema-distinguishable and that an entered
// value carries its reason. So a rank row records who granted it and when, and there is
// deliberately NO function here that turns bond into a rank behind anyone's back.
//
// ── ⚠️ EVERYONE STARTS AT THE BOTTOM, INCLUDING YODA ─────────────────────────────
//
// Yoda has 3,531 affection and 236 completed missions. Seeding his rank from that would
// have merged the two systems in the first five minutes of building them apart. He
// starts a Recruit like everyone else, and `recommend` makes a loud case for promoting
// him. The bootstrap is a screen where all 43 are listed with their evidence and a
// suggested rank, and a person confirms — a promotion that was actually made, rather
// than a derivation wearing somebody's name.

/**
 * The ladder, lowest first. `key` is stable and is what gets stored; `name` is display.
 *
 * ⚠️ NAMES ARE CONFIG, NOT CODE. Nima owns the lore — changing a name here is a
 * one-line edit and nothing else in the app hard-codes one. `level` is what comparisons
 * use, so renaming can never change who may man what.
 */
export const RANKS = [
  { level: 1, key: 'recruit', name: 'Recruit' },
  { level: 2, key: 'private', name: 'Private' },
  { level: 3, key: 'corporal', name: 'Corporal' },
  { level: 4, key: 'sergeant', name: 'Sergeant' },
  { level: 5, key: 'lieutenant', name: 'Lieutenant' },
  { level: 6, key: 'captain', name: 'Captain' },
  { level: 7, key: 'major', name: 'Major' },
  { level: 8, key: 'general', name: 'General' },
  { level: 9, key: 'commander', name: 'Commander' },
]

/** The rank everybody holds until somebody grants them another. */
export const STARTING_RANK = 'recruit'

const BY_KEY = new Map(RANKS.map((r) => [r.key, r]))

/**
 * Look a rank up by key.
 *
 * ⚠️ AN UNKNOWN KEY IS null, NOT THE LOWEST RANK. A typo or a rank deleted from the
 * ladder must surface as "we do not know what this is" — silently demoting somebody to
 * Recruit because their stored key stopped matching would look exactly like a decision
 * somebody made.
 */
export function rankFor(key) {
  return BY_KEY.get(String(key || '').trim().toLowerCase()) || null
}

/** The rank a character holds — the stored one, or the starting rank when none. */
export function heldRank(record) {
  if (!record?.rank) return { ...rankFor(STARTING_RANK), granted: false }
  const r = rankFor(record.rank)
  // ⚠️ An unrecognised stored rank is reported, never quietly reset. See rankFor.
  if (!r) return { level: 0, key: String(record.rank), name: `Unknown rank "${record.rank}"`, unknown: true, granted: true }
  return { ...r, granted: true, by: record.grantedBy || null, at: record.grantedAt || null }
}

/**
 * May this character be posted to this building?
 *
 * @param record   the stored rank row (or null)
 * @param minRank  the building's minimum rank key
 *
 * ⚠️ IT ANSWERS WITH A REASON EITHER WAY. "No" on its own makes a screen that refuses
 * without explaining, and the whole point of the ladder is that a person can see what
 * would fix it.
 */
export function canMan(record, minRank) {
  const held = heldRank(record)
  const need = rankFor(minRank)
  // ⚠️ A BUILDING WITH NO MINIMUM IS OPEN TO ALL, and that is deliberate rather than an
  // oversight: most buildings should be, and a missing `minRank` must not lock a post
  // nobody meant to restrict.
  if (!need) return { ok: true, held, need: null, why: 'this post has no rank requirement' }
  if (held.unknown) {
    return { ok: false, held, need, why: `their stored rank "${held.key}" is not on the ladder — fix it before posting them` }
  }
  if (held.level >= need.level) {
    return { ok: true, held, need, why: `${held.name} meets the ${need.name} required here` }
  }
  return {
    ok: false, held, need,
    why: `${need.name} is required here and they are ${held.name}`,
    short: need.level - held.level,
  }
}

/**
 * Does the evidence make a case for promoting this character?
 *
 * @param bond    { tier, name, points }  — from affection.js levelFor()
 * @param record  the stored rank row (or null)
 * @param missions completed mission count, for the evidence line
 *
 * ⚠️ IT RECOMMENDS. IT NEVER PROMOTES. There is no code path anywhere that applies this
 * — a promotion is an explicit action a person takes, and that is the requirement, not
 * an implementation detail.
 *
 * ⚠️ AND THE MAPPING IS BOND TIER → *SUGGESTED* RANK, WHICH IS NOT THE SAME LADDER.
 * Bond has six tiers and rank has nine, so this cannot be a straight conversion and must
 * not pretend to be. It answers a narrower question: is this person conspicuously
 * under-ranked for what they have actually done? A Bonded character sitting at Recruit
 * is worth flagging; the exact rank they deserve is a judgement.
 */
export function recommend({ bond = null, record = null, missions = 0 } = {}) {
  const held = heldRank(record)
  if (!bond || !bond.tier) {
    return { promote: false, held, why: 'no bond recorded yet — nothing to make a case with' }
  }
  // The rank a given bond tier would justify, at most. Six tiers spread across nine
  // ranks, deliberately short of the top: the last two are Nima's to give, never earned
  // by working through quests alone.
  const CEILING = { 1: 1, 2: 2, 3: 3, 4: 5, 5: 6, 6: 7 }
  const ceiling = CEILING[bond.tier] || 1
  const target = RANKS.find((r) => r.level === ceiling) || RANKS[0]

  if (held.unknown) {
    return { promote: false, held, why: `their stored rank "${held.key}" is not on the ladder` }
  }
  if (held.level >= target.level) {
    return {
      promote: false, held, target,
      why: `${held.name} already matches or exceeds what ${bond.name} and ${missions} completed missions would justify`,
    }
  }
  return {
    promote: true,
    held,
    target,
    // ⚠️ THE EVIDENCE IS THE POINT. A screen asking for approval must show what it is
    // asking about — "promote?" with no basis trains somebody to click yes.
    why: `${bond.name}${bond.points != null ? ` (${bond.points})` : ''} and ${missions} completed mission${missions === 1 ? '' : 's'}`
      + `, still ${held.name}`,
    steps: target.level - held.level,
  }
}

/**
 * Rank the whole roster for the promotion screen, strongest case first.
 *
 * ⚠️ IT RETURNS EVERYONE, not just the promotable. A roster that showed only the people
 * with a case would hide who is already posted correctly, and the bootstrap pass needs
 * to show all 43 at once.
 */
export function promotionBoard(crew = []) {
  return crew
    .map((c) => ({ ...c, recommendation: recommend(c) }))
    .sort((a, b) => {
      const ap = a.recommendation.promote ? 1 : 0
      const bp = b.recommendation.promote ? 1 : 0
      if (ap !== bp) return bp - ap
      return (b.recommendation.steps || 0) - (a.recommendation.steps || 0)
        || (b.bond?.points || 0) - (a.bond?.points || 0)
    })
}
