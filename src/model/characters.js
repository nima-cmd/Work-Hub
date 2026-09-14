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

  // ── Added 2026-09-11, from the Drive Characters folder ─────────────────────
  // Portraits are in client/src/assets/characters/<id>-1.jpeg, discovered by
  // import.meta.glob — no map to maintain, so an id here and a filename there are
  // the whole integration.
  { id: 'ai-hayasaka', name: 'Ai Hayasaka', universe: 'Kaguya-sama: Love Is War' },
  { id: 'chika-fujiwara', name: 'Chika Fujiwara', universe: 'Kaguya-sama: Love Is War' },
  { id: 'kaguya-shinomiya', name: 'Kaguya Shinomiya', universe: 'Kaguya-sama: Love Is War' },
  { id: 'miko-iino', name: 'Miko Iino', universe: 'Kaguya-sama: Love Is War' },
  { id: 'aqua', name: 'Aqua', universe: 'KonoSuba' },
  { id: 'darkness', name: 'Darkness', universe: 'KonoSuba' },
  { id: 'wiz', name: 'Wiz', universe: 'KonoSuba' },
  { id: 'yunyun', name: 'Yunyun', universe: 'KonoSuba' },
  { id: 'olivier-mira-armstrong', name: 'Olivier Mira Armstrong', universe: 'Fullmetal Alchemist' },
  { id: 'riza-hawkeye', name: 'Riza Hawkeye', universe: 'Fullmetal Alchemist' },
  { id: 'winry-rockbell', name: 'Winry Rockbell', universe: 'Fullmetal Alchemist' },
  { id: 'chisato-nishikigi', name: 'Chisato Nishikigi', universe: 'Lycoris Recoil' },
  { id: 'takina-inoue', name: 'Takina Inoue', universe: 'Lycoris Recoil' },
  { id: 'anisphia-wynn', name: 'Anisphia Wynn', universe: 'The Magical Revolution of the Reincarnated Princess' },
  { id: 'euphyllia-magenta', name: 'Euphyllia Magenta', universe: 'The Magical Revolution of the Reincarnated Princess' },
  { id: 'marin-kitagawa', name: 'Marin Kitagawa', universe: "My Dress-Up Darling" },
  { id: 'momo-ayase', name: 'Momo Ayase', universe: 'Dandadan' },
  { id: 'maomao', name: 'Maomao', universe: 'The Apothecary Diaries' },
  { id: 'emilia', name: 'Emilia', universe: 'Re:Zero' },

  // ── Identified by Nima, 2026-09-11 ────────────────────────────────────────
  // These five were added with `universe: null` because I could not name the series
  // from the art, and `universe` prints on the trading card and the hologram — a
  // plausible wrong franchise would have read as a fact. Nima supplied them.
  { id: 'alicia-glenfall', name: 'Alicia Glenfall', universe: 'Clevatess' },
  // Clen is Clevatess himself — the title character, and Alicia's master.
  { id: 'clen', name: 'Clen', universe: 'Clevatess' },
  { id: 'coco', name: 'Coco', universe: 'Witch Hat Atelier' },
  // ⚠️ THE HEDGE CAME OFF ON EVIDENCE, NOT ON REPETITION. These two were recorded
  // as attribution: 'believed' because Nima said "i believe are from Witch watch".
  // His later description of Nemu names her friends — Nico, Morihito, Keigo, Kanshi
  // and Miharu — which is the Witch Watch cast, and places BOTH of them in it. So
  // the hedge is resolved by corroborating detail, not by having been said twice.
  { id: 'nemu-miyao', name: 'Nemu Miyao', universe: 'Witch Watch' },
  { id: 'nico-wakatsuki', name: 'Nico Wakatsuki', universe: 'Witch Watch' },
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
