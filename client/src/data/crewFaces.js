// client/src/data/crewFaces.js — the small FACE crop of each crew member.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ The portraits in assets/characters are full pictures — often the whole      │
// │ body. Drawn into an 18-pixel circle on a road you saw a torso, not a face,  │
// │ and nobody was recognisable.                                                │
// │                                                                             │
// │ assets/crew holds a 96px square of each one's FACE, cut once at build time. │
// │ Same naming rule as the portraits: the file is the character id.            │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ HOW THE CROPS WERE MADE, because they will need remaking ─────────────────
//
// macOS Vision found a face in only 15 of 43 — the rest are anime, a droid, a puppet
// and two helmets, which no face detector handles. Those fall back to a top-centre crop
// sized off the aspect ratio: a full-body shot is tall and its head is a small fraction
// of the frame, a bust is nearly square and its head fills it. All 43 were eyeballed on
// a contact sheet before shipping (2026-09-18).
//
// ⚠️ SO A NEW PORTRAIT NEEDS A NEW CROP. Dropping a file into assets/characters gives
// you the big portrait everywhere and NO face here — `faceFor` then falls back to the
// full picture, which is the old behaviour rather than a blank. Re-run the crop script
// when art is added.
const thumbs = import.meta.glob('../assets/crew/*.{png,jpg,jpeg,webp}', { eager: true, import: 'default' })

const byId = {}
for (const [path, url] of Object.entries(thumbs)) {
  const id = path.split('/').pop().replace(/\.\w+$/, '').toLowerCase()
  byId[id] = url
}

/** The face crop for a character, or null when there is not one yet. */
export function faceFor(characterId) {
  if (!characterId) return null
  return byId[String(characterId).toLowerCase()] || null
}

export const FACE_COUNT = Object.keys(byId).length
