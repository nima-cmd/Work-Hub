// src/model/crewOnBase.js — who is posted where, and who is walking the roads.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ Two jobs, both about faces on the Base map:                                 │
// │                                                                             │
// │  1. POSTINGS — who is manning each building today, and whether they hold     │
// │     the rank that post requires.                                            │
// │  2. THE MOVERS — the dots travelling the roads become crew portraits, drawn  │
// │     from whoever is NOT on duty today.                                       │
// │                                                                             │
// │ Nima, 2026-09-18: "have the dots walking around be the images of the other   │
// │ crew members random generated not including the ones assigned to a building  │
// │ for that day."                                                              │
// │                                                                             │
// │ "Random" here means UNPREDICTABLE-LOOKING, not actually random — see below.  │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ IT MUST BE STABLE, SO IT IS SEEDED AND NOT RANDOM ────────────────────────
//
// baseMap.test.js already asserts "the same feed always produces the same base". A real
// Math.random() would reshuffle every face on every render — the map would flicker as
// people teleported between roads, and the test would be unreproducible. So the pick is
// a hash of the mover's own id: stable across renders, different between movers, and it
// changes only when the underlying document does.

/**
 * A tiny deterministic hash. Not for security — only for picking the same face for the
 * same document every time.
 */
function hash(str) {
  let h = 2166136261
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

/**
 * Resolve today's postings into what the Base needs to draw.
 *
 * @param postings [{ building, characterId }]
 * @param ranks    Map characterId → the stored crew_rank row
 * @param canMan   injected from crewRank.js — kept out of the import graph so this
 *                 module stays about placement, not about the rank ladder
 *
 * ⚠️ A POSTING THAT NO LONGER MEETS ITS BUILDING'S RANK IS FLAGGED, NOT HIDDEN. A person
 * can be posted and then the requirement changed, or a rank cleared. Quietly dropping
 * them would make the building read "unmanned" when somebody is standing in it.
 */
export function postingsForBase({ postings = [], ranks = new Map(), buildings = [], canMan } = {}) {
  const byBuilding = {}
  const minRankOf = new Map(buildings.map((b) => [b.key, b.minRank ?? null]))
  for (const p of postings) {
    if (!p?.building || !p?.characterId) continue
    const record = ranks.get(p.characterId) || null
    const check = canMan ? canMan(record, minRankOf.get(p.building)) : { ok: true }
    byBuilding[p.building] = {
      characterId: p.characterId,
      rank: record?.rank || null,
      // ⚠️ Named when the post outranks the person, so a screen can say so rather than
      // pretend the building is empty.
      underRanked: !check.ok,
      why: check.why || null,
    }
  }
  return byBuilding
}

/**
 * Give each mover a face — from the crew who are NOT on duty.
 *
 * @param movers  [{ id, ... }] from baseMap.moversFrom
 * @param roster  [{ id }] every character
 * @param postedIds  Set of character ids posted somewhere today
 *
 * ⚠️ THE POSTED CREW ARE EXCLUDED, which is the whole point: somebody manning the Pack
 * house should not also be walking the road to it. With 43 characters and at most 8
 * movers plus 15 posts there is always room — but if the roster ever shrinks below the
 * number of movers, this REPEATS a face rather than leaving a blank dot. A dot with no
 * face is what the map looked like before; a repeated face is merely a repeat.
 */
export function crewOnRoads({ movers = [], roster = [], postedIds = new Set() } = {}) {
  const available = roster.filter((c) => c?.id && !postedIds.has(c.id))
  // ⚠️ NO CREW LEFT IS AN HONEST EMPTY, not a crash. Every mover keeps its dot.
  if (!available.length) return movers.map((m) => ({ ...m, characterId: null }))

  const used = new Set()
  return movers.map((m) => {
    const start = hash(m.id) % available.length
    // Walk forward from the hashed position to the first unused face, so two movers
    // never wear the same one while spares remain.
    let pick = available[start]
    for (let i = 0; i < available.length; i++) {
      const c = available[(start + i) % available.length]
      if (!used.has(c.id)) { pick = c; break }
    }
    used.add(pick.id)
    return { ...m, characterId: pick.id }
  })
}
