import { useState } from 'react'
import { imagesFor } from '../data/characterImages.js'

// Collectible character trading card (Nima, 2026-07-17). Front = the character
// art + relationship tier; click flips to the back = RPG stats (agility from
// task speed, strength from task difficulty, intelligence from mission count),
// a mission log, and a spoken quote referencing their latest mission. Click
// again flips back. Purely a motivation/collectible layer over the affection data.

const STAT_CAP = 60 // bar fills toward this; raw number is always shown

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
}

function StatBar({ label, value }) {
  return (
    <div className="tcStat">
      <span className="tcStatLabel">{label}</span>
      <span className="tcStatBar"><span style={{ width: `${Math.min(100, (value / STAT_CAP) * 100)}%` }} /></span>
      <span className="tcStatNum">{value}</span>
    </div>
  )
}

export default function TradingCard({ card }) {
  const [flipped, setFlipped] = useState(false)
  const imgs = imagesFor(card.characterId)
  const name = card.character?.name || card.characterId
  const s = card.stats || { agility: 0, strength: 0, intelligence: 0 }

  return (
    <div className={'tcard' + (flipped ? ' flipped' : '')} onClick={() => setFlipped((f) => !f)} title="Click to flip">
      <div className="tcardInner">
        {/* FRONT */}
        <div className="tcardFace tcardFront">
          <div className="tcTopBar">
            <span className="tcName">{name}</span>
            <span className="tcTier">L{card.level.tier}</span>
          </div>
          <div className="tcArt">
            {imgs.length
              ? <img src={imgs[0]} alt={name} />
              : <div className="tcArtFallback">{initials(name)}</div>}
            <div className="tcArtFade" />
          </div>
          <div className="tcFrontFoot">
            <div className="tcLevel">{card.level.name}</div>
            <div className="tcMeta">{card.points} affection · {card.questsDone} mission{card.questsDone === 1 ? '' : 's'}</div>
            <div className="tcProg"><span style={{ width: `${Math.round(card.level.progress * 100)}%` }} /></div>
            <div className="tcFlipHint">tap for stats ↻</div>
          </div>
        </div>

        {/* BACK */}
        <div className="tcardFace tcardBack">
          <div className="tcTopBar">
            <span className="tcName">{name}</span>
            <span className="tcTier">{card.character?.universe || ''}</span>
          </div>
          {card.quote && <div className="tcQuote">{card.quote}</div>}
          <div className="tcStats">
            <StatBar label="AGI" value={s.agility} />
            <StatBar label="STR" value={s.strength} />
            <StatBar label="INT" value={s.intelligence} />
          </div>
          <div className="tcLogHead">Mission log</div>
          <div className="tcLog">
            {card.missions.slice(0, 8).map((m) => (
              <div key={m.id} className="tcLogRow">
                <span className="tcLogDot" />
                <span className="tcLogName">{m.subject || 'Mission'}</span>
                <span className="tcLogDate">{m.completedAt ? new Date(m.completedAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' }) : ''}</span>
              </div>
            ))}
            {!card.missions.length && <div className="tcLogEmpty">No missions logged yet.</div>}
          </div>
          <div className="tcFlipHint">tap to flip back ↻</div>
        </div>
      </div>
    </div>
  )
}
