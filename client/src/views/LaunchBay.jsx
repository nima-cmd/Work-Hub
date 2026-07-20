import { useEffect, useState } from 'react'
import { fetchLaunchBay } from '../api.js'
import { LabelButtons } from '../lib.jsx'
import { resolveShipForKey, getShipById } from '../../../src/model/ships.js'
import { shipImagesFor } from '../data/shipImages.js'
import { bayBackdrop } from '../data/bayBackdrop.js'

// Launch Bay (Nima, 2026-07-17, Phase B) — the departure bay as a single
// composited SCENE on the Mos Espa spaceport backdrop (per Nima's mock), NOT a
// grid of cards:
//   • APPROVED-TO-SHIP ships FLY in the sky — cleared for launch;
//   • everything else is GROUNDED on the sand, its status telling you why it's
//     stuck — payment (red) / invoice (yellow);
//   • a ship cleared on a PRIOR day and still here (never marked shipped) gets a
//     DELAY ALARM — the record-loss miss Nima wants caught before it disappears.
// FOB ("China-Warehouse, ships direct") is excluded server-side. Ships are drawn
// from src/model/ships.js — real art from assets/ships/, CSS hull fallback
// otherwise. Data: /api/launch-bay.

const STATE_LABEL = {
  payment: 'Waiting on payment',
  invoice: 'Pending invoice',
  approved: 'Cleared for launch',
  scanned_in: 'Scanned in — prep to ship',
  other: 'Holding',
}

// The "why it hasn't left yet" line under a grounded ship (Nima, 2026-07-17).
const WHY = {
  payment: 'Grounded — customer payment must clear before it ships',
  invoice: 'Grounded — invoice hasn’t been generated yet',
  scanned_in: 'Back in our hands — generate the shipping label & get it ready to invoice',
  other: 'Grounded — not yet cleared to ship',
}

// Stable per-IF pseudo-random in [0,1) so a ship keeps its spot across reloads.
function jitter(key, salt) {
  const s = String(key) + salt
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h % 1000) / 1000
}

// Lay ships out in a GRID within a band so many ships fit without crowding:
// evenly spaced columns, wrapping into rows once past `perRow`, each with a
// little deterministic wobble so it reads as a scene, not a spreadsheet.
function place(ships, { top, bottom }, perRow = 5) {
  const n = ships.length
  if (!n) return []
  const cols = Math.min(perRow, n)
  const rows = Math.ceil(n / cols)
  return ships.map((s, i) => {
    const key = s.ifNumber || s.soNumber
    const row = Math.floor(i / cols)
    const inThisRow = Math.min(cols, n - row * cols)
    const col = i % cols
    const x = 8 + ((col + 0.5) / inThisRow) * 84 + (jitter(key, 'x') - 0.5) * 5
    const y = rows === 1
      ? (top + bottom) / 2
      : top + (row / (rows - 1)) * (bottom - top)
    return { ...s, _x: Math.max(5, Math.min(93, x)), _y: y + (jitter(key, 'y') - 0.5) * 3 }
  })
}

function SceneShip({ s }) {
  const cls = s.delayed ? 'delayed' : s.state
  const shipId = resolveShipForKey(s.ifNumber || s.soNumber)
  const art = shipImagesFor(shipId)[0] || null
  const shipName = getShipById(shipId)?.name

  return (
    <div
      className={`sceneShip ${s.floating ? 'flying' : 'grounded'} ship-${cls}`}
      style={{ left: `${s._x}%`, top: `${s._y}%` }}
    >
      {s.delayed && <div className="shipAlarm" title="Cleared on a prior day — mark it shipped">!</div>}
      <div className="sceneShipCraft">
        {art ? (
          <img className="shipArt" src={art} alt={shipName || 'ship'} title={shipName} draggable={false} />
        ) : (
          <div className="shipHull"><div className="shipCockpit" /></div>
        )}
        {s.floating && <div className="shipThrust" />}
      </div>
      <div className="sceneShipTag">
        <div className="tagTop">
          <span className="tagIf">{s.ifNumber || s.soNumber}</span>
          <span className={`tagDot st-${cls}`} />
        </div>
        <div className="tagCust">{s.customer || 'Unknown consignee'}{s.poNumber ? ` · PO ${s.poNumber}` : ''}</div>
        <div className={`tagStatus st-${cls}`}>
          {s.delayed ? `Overdue ${s.floatingDays}d — mark shipped` : STATE_LABEL[s.state]}
        </div>
        {!s.floating && <div className="tagWhy">{WHY[s.state] || WHY.other}</div>}
        <LabelButtons info={s} />
      </div>
    </div>
  )
}

export default function LaunchBay() {
  const [ships, setShips] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetchLaunchBay().then(setShips).catch((e) => setErr(e.message))
  }, [])

  if (err) return <div className="banner error">⚠ Couldn’t load the launch bay: {err}</div>
  if (!ships) return <div className="banner">Powering up the launch bay…</div>

  const floating = ships.filter((s) => s.floating)
  const grounded = ships.filter((s) => !s.floating)
  const delayed = floating.filter((s) => s.delayed)

  // sky band up top for cleared ships; sand band lower for the grounded ones.
  // Bands widen as more ships arrive so rows never pile onto each other.
  const skyRows = Math.ceil(floating.length / 5)
  const groundRows = Math.ceil(grounded.length / 5)
  const placed = [
    ...place(floating, { top: 9, bottom: skyRows > 1 ? 36 : 22 }),
    ...place(grounded, { top: groundRows > 1 ? 52 : 64, bottom: 76 }),
  ]

  return (
    <div className="launchBay">
      <div className="bayHeader">
        <h2>Launch Bay <span className="count">{ships.length}</span></h2>
        <div className="baySummary">
          {delayed.length > 0 && <span className="pill danger">{delayed.length} delayed launch</span>}
          <span className="pill fresh">{floating.length} cleared</span>
          <span className="pill">{grounded.length} grounded</span>
        </div>
      </div>

      {delayed.length > 0 && (
        <div className="banner error" style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(248,81,73,0.08)', marginBottom: 12 }}>
          ⚠ {delayed.length} ship{delayed.length > 1 ? 's were' : ' was'} cleared to launch on an earlier day and {delayed.length > 1 ? 'are' : 'is'} still
          in the air — if {delayed.length > 1 ? 'they' : 'it'} already shipped, mark the Item Fulfillment shipped before the record is lost.
        </div>
      )}

      <div className={'bayScene' + (bayBackdrop ? ' hasBackdrop' : '')}
           style={bayBackdrop ? { backgroundImage: `url("${bayBackdrop}")` } : undefined}>
        {placed.map((s) => <SceneShip key={s.ifNumber || s.soNumber} s={s} />)}
        {!ships.length && (
          <div className="sceneEmpty">The bay is clear — nothing packed waiting to depart. 🚀</div>
        )}
        <span className="whLabel">MOS&nbsp;ESPA&nbsp;·&nbsp;NAGHEDI&nbsp;DOCKS</span>
      </div>
    </div>
  )
}
