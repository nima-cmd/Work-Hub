import { useEffect, useState } from 'react'
import { fetchAffection } from '../api.js'
import { imagesFor } from '../data/characterImages.js'
import { CHARACTERS } from '../../../src/model/characters.js'
import TradingCard from '../lib/TradingCard.jsx'

// Crew (Nima, 2026-07-20) — the trading-card roster, split out of Transmissions
// into its own tab so it isn't buried under the task list. Transmissions keeps
// a compact top-banner strip that links here for the full view.
export default function Crew() {
  const [affection, setAffection] = useState(null)

  useEffect(() => {
    fetchAffection().then(setAffection).catch(() => setAffection([]))
  }, [])

  if (!affection) return <div className="banner">Loading crew…</div>

  const missing = CHARACTERS.filter((c) => imagesFor(c.id).length === 0)

  return (
    <div className="crewPage">
      <h2>Crew <span className="count">{affection.length}</span></h2>
      <p className="hint">A collectible card per character. Finishing quests fast raises AGILITY, harder quests raise STRENGTH, and more missions together raise INTELLIGENCE. Tap a card to flip to their stats + mission log.</p>
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
        {affection.map((a) => <TradingCard key={a.characterId} card={a} />)}
      </div>
      {!affection.length && <div className="empty">No missions completed yet — the crew roster fills in as tasks close.</div>}
    </div>
  )
}
