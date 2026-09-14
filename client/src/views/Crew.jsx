import { useEffect, useState } from 'react'
import { fetchAffection } from '../api.js'
import { imagesFor } from '../data/characterImages.js'
import { CHARACTERS } from '../../../src/model/characters.js'
import { levelFor } from '../../../src/model/affection.js'
import TradingCard from '../lib/TradingCard.jsx'

// Crew (Nima, 2026-07-20) — the trading-card roster, split out of Transmissions
// into its own tab so it isn't buried under the task list. Transmissions keeps
// a compact top-banner strip that links here for the full view.
//
// ── ⚠️ IT SHOWS THE WHOLE ROSTER, NOT JUST WHO HAS DELIVERED ────────────────
//
// Nima, 2026-09-11, asked twice: "are they added to crew". They were not, and the
// reason was this view. It used to render `affection.map(...)` — one card per
// character WITH COMPLETED QUESTS — so the 24 portraits added that day were in the
// roster and in the messenger rotation but invisible here, and would have appeared
// one at a time over weeks as a brand-new sender happened to draw each of them.
//
// So the grid is now the roster, and affection is joined ONTO it. A character you
// have not worked with yet gets a real zero-state card — L1 Stranger, 0 affection,
// empty mission log — which is honest rather than hidden. Earned cards still sort
// first by affection, so the collection you have built stays the top of the page.
//
// ⚠️ AND THE ZERO STATE IS BUILT FROM levelFor(0), NOT TYPED OUT. TradingCard reads
// card.level.tier and card.missions unguarded, so a hand-written stub would be one
// renamed field away from a blank card — and "Stranger"/tier 1 hard-coded here would
// silently disagree with affection.js the moment the level bands change.
const zeroCard = (c) => ({
  characterId: c.id,
  points: 0,
  questsDone: 0,
  level: levelFor(0),
  stats: { agility: 0, strength: 0, intelligence: 0 },
  missions: [],
  quote: null,
  unearned: true,
})

export default function Crew() {
  const [affection, setAffection] = useState(null)

  useEffect(() => {
    fetchAffection().then(setAffection).catch(() => setAffection([]))
  }, [])

  if (!affection) return <div className="banner">Loading crew…</div>

  const missing = CHARACTERS.filter((c) => imagesFor(c.id).length === 0)

  // ⚠️ THE API DOES NOT SEND `character`, AND THE CARD NEEDS IT. /api/affection
  // returns characterId only, while TradingCard reads card.character?.name — which
  // optional-chains to the raw id, so every card has been titled "yoda" / "bb8"
  // instead of "Yoda" / "BB-8", and the universe line on the back has always been
  // blank. Joining the roster on here fixes that for earned and unearned alike.
  const byId = new Map(affection.map((a) => [a.characterId, a]))
  const cards = CHARACTERS
    .map((c) => ({ ...(byId.get(c.id) || zeroCard(c)), character: c }))
    .sort((x, y) => (y.points - x.points)
      || (x.character.name || '').localeCompare(y.character.name || ''))

  // ⚠️ An affection row for a character no longer on the roster would vanish
  // silently from the grid, taking its mission history with it. Counted, not dropped.
  const orphans = affection.filter((a) => !CHARACTERS.some((c) => c.id === a.characterId))
  const met = affection.length

  return (
    <div className="crewPage">
      <h2>Crew <span className="count">{met} / {CHARACTERS.length}</span></h2>
      <p className="hint">A collectible card per character. Finishing quests fast raises AGILITY, harder quests raise STRENGTH, and more missions together raise INTELLIGENCE. Tap a card to flip to their stats + mission log. Cards you haven’t worked with yet show dimmed until their first mission closes.</p>
      {orphans.length > 0 && (
        <div className="missingArt">
          <b>◈ {orphans.length} card{orphans.length > 1 ? 's' : ''} with no roster entry</b> — mission history exists for
          {' '}{orphans.map((o) => <code key={o.characterId}>{o.characterId}</code>)}, but no character is defined in
          <code> src/model/characters.js</code>. Nothing is lost; the card is just not shown.
        </div>
      )}
      {missing.length > 0 && (
        <div className="missingArt">
          <b>◈ {missing.length} crew member{missing.length > 1 ? 's' : ''} awaiting a portrait</b> — drop the file into
          <code> client/src/assets/characters/</code> with these names (any image type), then rebuild:
          <div className="missingList">
            {missing.map((c) => <code key={c.id}>{c.id}-1.jpg <span>({c.name})</span></code>)}
          </div>
        </div>
      )}
      <div className="tcGrid">
        {cards.map((a) => <TradingCard key={a.characterId} card={a} />)}
      </div>
    </div>
  )
}
