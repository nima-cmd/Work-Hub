// src/model/affection.js — the relationship / collectible-card tracker
// (Nima, 2026-07-17). Every quest is delivered by a roster character; each
// completed quest levels them up as a collectible trading card:
//   • AGILITY     grows with how FAST quests are finished;
//   • STRENGTH    grows with how HARD the quests are (difficulty ← urgency);
//   • INTELLIGENCE grows with the NUMBER of quests completed together.
// Plus an overall affection score / relationship tier, a mission log for the
// card back, and a spoken quote referencing their latest mission. All derived
// purely from completed quest_tasks — no separate table.

const BASE = 10 // affection per completed quest, before the speed bonus

// How fast the quest was closed (created → completed).
function speedPoints(createdAt, completedAt) {
  if (!createdAt || !completedAt) return 1
  const hours = (new Date(completedAt) - new Date(createdAt)) / 3.6e6
  if (hours < 4) return 5
  if (hours < 24) return 3
  if (hours < 72) return 2
  if (hours < 168) return 1
  return 0
}

// Difficulty ← urgency (the only difficulty signal tasks carry today). Tunable.
function difficultyPoints(urgency) {
  return { hi: 5, mid: 3, lo: 1 }[urgency] ?? 2
}

const LEVELS = [
  { min: 0, name: 'Stranger' },
  { min: 50, name: 'Acquaintance' },
  { min: 150, name: 'Comrade' },
  { min: 350, name: 'Trusted ally' },
  { min: 700, name: 'Confidant' },
  { min: 1200, name: 'Bonded' },
]

export function levelFor(points) {
  let level = LEVELS[0]
  for (const l of LEVELS) if (points >= l.min) level = l
  const idx = LEVELS.indexOf(level)
  const next = LEVELS[idx + 1] || null
  return {
    name: level.name,
    tier: idx + 1,
    progress: next ? Math.min(1, (points - level.min) / (next.min - level.min)) : 1,
    toNext: next ? next.min - points : 0,
    nextName: next?.name || null,
  }
}

// A short spoken line referencing the most recent mission — picked
// deterministically (no RNG) so it's stable per render.
const QUOTE_TEMPLATES = [
  (m) => `Told you I'd handle ${m} — consider it done.`,
  (m) => `${m}? Already sorted. What's next?`,
  (m) => `I've got your back on ${m}. Always.`,
  (m) => `Another one down: ${m}.`,
  (m) => `${m} — handled, no sweat.`,
]
function shortSubject(subject) {
  const s = (subject || '').trim().replace(/\s+/g, ' ')
  if (!s) return 'that job'
  const words = s.split(' ').slice(0, 5).join(' ')
  return words.length < s.length ? `“${words}…”` : `“${words}”`
}
export function missionQuote(characterId, recentMissions) {
  if (!recentMissions?.length) return null
  const m = shortSubject(recentMissions[0].subject)
  const idx = ((characterId || '').length + recentMissions.length) % QUOTE_TEMPLATES.length
  return QUOTE_TEMPLATES[idx](m)
}

// tasks: quest_tasks rows (any status). One entry per character with ≥1
// completed quest, sorted by affection desc.
export function computeAffection(tasks = []) {
  const byChar = new Map()
  for (const t of tasks) {
    if (t.status !== 'done' || !t.characterId) continue
    if (!byChar.has(t.characterId)) {
      byChar.set(t.characterId, {
        characterId: t.characterId, points: 0, questsDone: 0,
        agility: 0, strength: 0, intelligence: 0, missions: [],
      })
    }
    const a = byChar.get(t.characterId)
    const sp = speedPoints(t.createdAt, t.completedAt)
    a.points += BASE + sp
    a.questsDone += 1
    a.agility += sp
    a.strength += difficultyPoints(t.urgency)
    a.intelligence += 4 // per mission completed together
    a.missions.push({ id: t.id, subject: t.subject, completedAt: t.completedAt, urgency: t.urgency })
  }
  return [...byChar.values()]
    .map((a) => {
      // newest missions first for the card-back log + the quote
      const missions = a.missions.sort((x, y) => new Date(y.completedAt || 0) - new Date(x.completedAt || 0))
      return {
        characterId: a.characterId,
        points: a.points,
        questsDone: a.questsDone,
        level: levelFor(a.points),
        stats: { agility: a.agility, strength: a.strength, intelligence: a.intelligence },
        missions,
        quote: missionQuote(a.characterId, missions),
      }
    })
    .sort((x, y) => y.points - x.points)
}
