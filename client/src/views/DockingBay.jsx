import { sevClass, ifList } from '../lib.jsx'

// Docking Bay (Nima, 2026-07-17, Phase B) — every order that has an Item
// Fulfillment but hasn't shipped yet is a ship parked in the bay. Grounded
// ships show WHY (clamps + a warning light, colored by the order's existing
// severity); an order that's reached "Approved for Shipping" is cleared and
// sits in the departure lane instead, glowing and ready to go. Pure read of
// the same `orders` payload every other view gets — no new data, no new API.

const BAY_STAGES = new Set([
  'PICKED_NEEDS_PACK',
  'PACKED_PENDING_NEXT',
  'INVOICED_PENDING_PAYMENT',
  'APPROVED_FOR_SHIPPING',
])

// Highest-priority reason wins — most specific/actionable first. Reuses the
// same flag keys src/model/pipeline.js already computes, just phrased for a
// landing-pad readout instead of a table cell.
const GROUND_REASON = [
  ['WAREHOUSE_HOLDS', 'Warehouse custody overdue — chase it'],
  ['BACK_NOT_PACKED', 'Back from warehouse — needs packing'],
  ['PENDING_PAYMENT', 'Waiting on payment clearance'],
  ['FOB_HOLD', 'FOB hold — awaiting approval'],
  ['NEEDS_HANDOFF_SCAN', 'No handoff scan logged'],
  ['WITH_WAREHOUSE', 'With warehouse custody'],
  ['PICK_STALLED', 'Picked, not packed — stalled'],
  ['OVERDUE', 'Ship date overdue'],
  ['PARTIAL', 'Partial fulfillment — needs disposition'],
  ['DUE_TODAY', 'Ship date is today'],
  ['STALE', 'Aging in the bay — chase it'],
  ['AGING', 'Aging in the bay'],
]

// Fallback when the order is grounded but none of the above flags fired —
// just the ordinary stage it's sitting at.
const STAGE_FALLBACK = {
  PICKED_NEEDS_PACK: 'Being packed',
  PACKED_PENDING_NEXT: 'Packed — awaiting invoice',
  INVOICED_PENDING_PAYMENT: 'Invoiced — pending payment',
}

function shipFor(o) {
  const flagKeys = new Set((o.flags || []).map((f) => f.key))
  const ready = o.stage === 'APPROVED_FOR_SHIPPING'
  const reason = ready
    ? 'Cleared for departure'
    : GROUND_REASON.find(([key]) => flagKeys.has(key))?.[1] || STAGE_FALLBACK[o.stage] || 'Docked'
  return {
    key: o.soNumber,
    label: ifList(o) || o.soNumber,
    customer: o.customer || 'Unknown consignee',
    poNumber: o.poNumber,
    ready,
    reason,
    severity: o.severity || 0,
    daysPending: o.daysPending,
  }
}

function ShipPad({ ship, index }) {
  return (
    <div className={`pad ${ship.ready ? 'ready' : 'grounded ' + sevClass(ship.severity)}`}>
      <div className="padSlot">SLOT {index + 1}</div>
      <div className="padDeck">
        <div className="shipHull">
          <div className="shipCockpit" />
        </div>
        {ship.ready ? (
          <div className="thrusterGlow" />
        ) : (
          <>
            <div className="clamp clampL" />
            <div className="clamp clampR" />
            <div className="warnLight" />
          </>
        )}
      </div>
      <div className="padLabel">{ship.label}</div>
      <div className="padCust">
        {ship.customer}
        {ship.poNumber ? ` · PO ${ship.poNumber}` : ''}
      </div>
      <div className={'padStatus ' + (ship.ready ? 'ok' : sevClass(ship.severity))}>{ship.reason}</div>
    </div>
  )
}

export default function DockingBay({ orders }) {
  const ships = orders.filter((o) => BAY_STAGES.has(o.stage)).map(shipFor)
  const grounded = ships.filter((s) => !s.ready).sort((a, b) => b.severity - a.severity || (b.daysPending || 0) - (a.daysPending || 0))
  const ready = ships.filter((s) => s.ready)

  if (!ships.length) {
    return <div className="empty">The bay is empty — nothing packed or pending departure right now.</div>
  }

  return (
    <div className="dockingBay">
      <div className="bayHeader">
        <h2>
          Docking Bay <span className="count">{ships.length}</span>
        </h2>
        <div className="baySummary">
          <span className="pill danger">{grounded.length} grounded</span>
          <span className="pill fresh">{ready.length} cleared for departure</span>
        </div>
      </div>

      <section className="baySection">
        <div className="colHead">Docking Clamps <span className="count">{grounded.length}</span></div>
        <div className="bayGrid">
          {grounded.map((s, i) => <ShipPad key={s.key} ship={s} index={i} />)}
          {!grounded.length && <div className="empty">Nothing held up right now.</div>}
        </div>
      </section>

      <section className="baySection">
        <div className="colHead">Departure Lane <span className="count">{ready.length}</span></div>
        <div className="bayGrid ready">
          {ready.map((s, i) => <ShipPad key={s.key} ship={s} index={i} />)}
          {!ready.length && <div className="empty">Nothing cleared to launch yet.</div>}
        </div>
      </section>
    </div>
  )
}
