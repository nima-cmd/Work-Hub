// src/model/characters.js — the messenger roster for Gmail-to-quest hologram
// transmissions (see docs/quest-emails). Plain config, not a DB table: add a
// character by adding a line here, no migration needed. `id` is the stable
// key used everywhere else (DB rows, character image folder filenames).
export const CHARACTERS = [
  { id: 'jessika-pava', name: 'Jessika Pava', universe: 'Star Wars' },
  { id: 'rey', name: 'Rey', universe: 'Star Wars' },
  { id: 'jyn-erso', name: 'Jyn Erso', universe: 'Star Wars' },
  { id: 'colleen-wing', name: 'Colleen Wing', universe: 'Marvel' },
  { id: 'bugs', name: 'Bugs', universe: 'The Matrix Resurrections' },
  { id: 'nymeria-sand', name: 'Nymeria Sand', universe: 'Game of Thrones' },
  { id: 'obi-wan', name: 'Obi-Wan Kenobi', universe: 'Star Wars' },
  { id: 'han-solo', name: 'Han Solo', universe: 'Star Wars' },
  { id: 'yoda', name: 'Yoda', universe: 'Star Wars' },
  { id: 'poe-dameron', name: 'Poe Dameron', universe: 'Star Wars' },
  { id: 'leia-organa', name: 'Princess Leia Organa', universe: 'Star Wars' },
  { id: 'din-djarin', name: 'Din Djarin', universe: 'Star Wars' },
  { id: 'grogu', name: 'Grogu', universe: 'Star Wars' },
  { id: 'boba-fett', name: 'Boba Fett', universe: 'Star Wars' },
  { id: 'frieren', name: 'Frieren', universe: 'Frieren' },
  { id: 'fern', name: 'Fern', universe: 'Frieren' },
  { id: 'yor-forger', name: 'Yor Forger', universe: 'Spy x Family' },
  { id: 'anya-forger', name: 'Anya Forger', universe: 'Spy x Family' },
  { id: 'bb8', name: 'BB-8', universe: 'Star Wars' },
]

export function getCharacterById(id) {
  return CHARACTERS.find((c) => c.id === id) || null
}

// Which character delivers a given email. A sender we've already assigned a
// character to (via the reassign action, see loadToDb.js's
// assignQuestEmailCharacter) keeps getting that same messenger; a brand-new
// sender gets a random pick. `rng` is injectable so this stays pure/testable
// (real callers just use the default Math.random).
export function resolveCharacterForSender(fromAddress, prefsByAddress = {}, rng = Math.random) {
  const pref = fromAddress ? prefsByAddress[fromAddress] : null
  if (pref && CHARACTERS.some((c) => c.id === pref)) return pref
  return CHARACTERS[Math.floor(rng() * CHARACTERS.length)].id
}
