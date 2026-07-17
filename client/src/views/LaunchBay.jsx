import { useEffect, useState } from 'react'
import { fetchLaunchBay } from '../api.js'
import { printIfLabel } from '../lib/labels.js'
import { PaperTagButton } from '../lib.jsx'

// Launch Bay (Nima, 2026-07-17, Phase B) — the 2D departure bay. Every packed-
// but-not-yet-shipped IF is a ship:
//   • GROUNDED, coloured by why it can't leave — payment (red), invoice
//     (yellow), FOB (amber);
//   • APPROVED TO SHIP ships FLOAT above the warehouse, cleared for launch;
//   • a float still here on a later day (never marked shipped) turns into a
//     DELAY ALARM — the "we shipped it but forgot to mark it, and lost the
//     record" miss Nima wants caught before it disappears.
// Data: /api/launch-bay (fulfillments + the REACHED_APPROVED ledger stamp).

const STATE_LABEL = {
  payment: 'Waiting on payment',
  invoice: 'Pending invoice',
  fob: 'FOB — awaiting approval',
  approved: 'Cleared for launch',
  other: 'Holding',
}

function Ship({ s }) {
  const cls = s.delayed ? 'delayed' : s.state
  return (
    <div className={`ship ${s.floating ? 'floating' : 'grounded'} ship-${cls}`}>
      {s.delayed && <div className="shipAlarm" title="Cleared on a prior day — mark it shipped">!</div>}
      <div className="shipBody">
        <div className="shipHull">
          <div className="shipCockpit" />
        </div>
        {s.floating ? <div className="shipThrust" /> : <><span className="clamp clampL" /><span className="clamp clampR" /></>}
      </div>
      <div className="shipLabel">{s.ifNumber || s.soNumber}</div>
      <div className="shipCust">
        {s.customer || 'Unknown consignee'}
        {s.poNumber ? ` · PO ${s.poNumber}` : ''}
      </div>
      <div className={`shipStatus st-${cls}`}>
        {s.delayed
          ? `Should have launched ${s.floatingDays}d ago — mark it shipped`
          : STATE_LABEL[s.state]}
      </div>
      <div className="tagBtns">
        <button className="linkBtn" title="Print the 4×6 thermal cargo tag" onClick={() => printIfLabel(s)}>🖨 4×6</button>
        <PaperTagButton info={s} />
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
  if (!ships.length) return <div className="empty">The bay is clear — nothing packed waiting to depart. 🎉</div>

  const floating = ships.filter((s) => s.floating)
  const grounded = ships.filter((s) => !s.floating)
  const delayed = floating.filter((s) => s.delayed)

  // grounded grouped by why they're held (most urgent colour first)
  const GROUND_ORDER = ['payment', 'invoice', 'fob', 'other']
  const groundGroups = GROUND_ORDER
    .map((state) => ({ state, items: grounded.filter((s) => s.state === state) }))
    .filter((g) => g.items.length)

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
        <div className="banner error" style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(248,81,73,0.08)' }}>
          ⚠ {delayed.length} ship{delayed.length > 1 ? 's were' : ' was'} cleared to launch on an earlier day and {delayed.length > 1 ? 'are' : 'is'} still
          in the air — if {delayed.length > 1 ? 'they' : 'it'} already shipped, mark the Item Fulfillment shipped before the record is lost.
        </div>
      )}

      {/* The sky: approved ships floating above the warehouse roofline */}
      <div className="baySky">
        <div className="skyShips">
          {floating.length
            ? floating.map((s) => <Ship key={s.ifNumber || s.soNumber} s={s} />)
            : <div className="empty" style={{ padding: 8 }}>Nothing cleared for launch right now.</div>}
        </div>
        <div className="warehouseRoof">
          <span className="whLabel">NAGHEDI WAREHOUSE</span>
        </div>
      </div>

      {/* The ground: everything held, on landing pads coloured by why */}
      <div className="bayGround">
        {groundGroups.map(({ state, items }) => (
          <div key={state} className="groundGroup">
            <div className="colHead">{STATE_LABEL[state]} <span className="count">{items.length}</span></div>
            <div className="groundRow">
              {items.map((s) => <Ship key={s.ifNumber || s.soNumber} s={s} />)}
            </div>
          </div>
        ))}
        {!groundGroups.length && <div className="empty">No ships grounded — the whole bay is cleared. 🚀</div>}
      </div>
    </div>
  )
}
