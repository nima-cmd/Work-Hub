import { useEffect, useMemo, useState } from 'react'
import { fetchRouting, assignRoutingBol, voidRoutingShipment } from '../api.js'
import { consolidateRouting } from '../../../src/model/routing.js'

// EDI Routing (Nima, 2026-07-22) — replaces the NetSuite routing_helper.js
// Suitelet + Google Sheet. Takes the packed-carton feed (EDIPackagesVolume),
// lets you pick which POs are shipping, consolidates them into ONE shipment per
// DC, and shows the exact whole-number portal entries (cartons / weight /
// rounded cubic feet, + units for Nordstrom). Assign a guaranteed-unique BOL
// per DC; the DC is shown big since the number itself is just a unique serial.
export default function Routing() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const [selected, setSelected] = useState(null) // Set<poNumber> | null (=all)

  function load() {
    fetchRouting().then(setData).catch((e) => setErr(e.message))
  }
  useEffect(load, [])

  // All PO numbers present in the feed, sorted.
  const allPos = useMemo(() => {
    if (!data) return []
    return [...new Set((data.packages || []).map((p) => p.poNumber).filter(Boolean))].sort()
  }, [data])

  // Default: every PO selected. (null means "all", so a re-import that adds a
  // PO shows it selected without us having to reconcile the set.)
  const isSelected = (po) => (selected ? selected.has(po) : true)
  function togglePo(po) {
    setSelected((prev) => {
      const next = new Set(prev ? prev : allPos)
      next.has(po) ? next.delete(po) : next.add(po)
      return next
    })
  }
  const selectAll = () => setSelected(null)
  const selectNone = () => setSelected(new Set())

  // Re-consolidate client-side over the selected POs (same pure model the
  // server uses), then re-attach any already-assigned shipment by its key.
  const groups = useMemo(() => {
    if (!data) return []
    const rows = (data.packages || []).filter((p) => isSelected(p.poNumber))
    const byKey = new Map((data.shipments || []).map((s) => [s.dcPoKey, s]))
    return consolidateRouting(rows).map((g) => {
      const dcPoKey = `${g.partner}|${g.dc}|${g.memberPos.join(',')}`
      return { ...g, dcPoKey, shipment: byKey.get(dcPoKey) || null }
    })
  }, [data, selected])

  const byPartner = useMemo(() => {
    const m = new Map()
    for (const g of groups) {
      if (!m.has(g.partner)) m.set(g.partner, [])
      m.get(g.partner).push(g)
    }
    return [...m.entries()]
  }, [groups])

  async function onAssign(g) {
    setBusy(g.dcPoKey)
    setErr(null)
    try {
      setData(await assignRoutingBol({
        partner: g.partner, dc: g.dc, memberPos: g.memberPos,
        cartons: g.cartons, units: g.units, weightLb: g.weightLb, cubicFeet: g.cubicFeet,
      }))
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  async function onVoid(shipment) {
    if (!confirm(`Void BOL ${shipment.bolNumber}? The number stays retired and is never reused.`)) return
    setBusy('void' + shipment.id)
    setErr(null)
    try {
      setData(await voidRoutingShipment(shipment.id))
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  if (err && !data) return <div className="banner error">⚠ {err}</div>
  if (!data) return <div className="banner">Loading routing feed…</div>

  const detached = data.detached || []

  return (
    <div className="routing">
      <div className="rt-head">
        <div>
          <h2>EDI Routing <span className="muted">· BOL consolidation</span></h2>
          <div className="muted rt-sub">
            Packed cartons from the EDI Packages Volume feed, consolidated into one shipment per DC.
            The numbers below are the exact whole-number entries for the partner portal.
          </div>
        </div>
        <button className="btnGhost" onClick={load}>↻ Reload feed</button>
      </div>

      {err && <div className="banner error">⚠ {err}</div>}

      {!data.packageCount ? (
        <div className="rt-empty">
          No routing feed loaded yet. Export <b>EDI Packages Volume</b> (searchid=3947) from NetSuite
          and use <b>⤓ Import CSV</b> to load it.
        </div>
      ) : (
        <>
          <div className="rt-pos">
            <span className="muted">POs in feed ({allPos.length}):</span>
            {allPos.map((po) => (
              <button
                key={po}
                className={'rt-poChip' + (isSelected(po) ? ' on' : '')}
                onClick={() => togglePo(po)}
              >{po}</button>
            ))}
            <button className="btnGhost" onClick={selectAll}>All</button>
            <button className="btnGhost" onClick={selectNone}>None</button>
          </div>

          {byPartner.map(([partner, list]) => (
            <section key={partner} className="rt-partner">
              <h3>{partner} <span className="muted">· {list.length} DC{list.length === 1 ? '' : 's'}</span></h3>
              <div className="rt-cards">
                {list.map((g) => (
                  <ShipmentCard
                    key={g.dcPoKey}
                    g={g}
                    busy={busy}
                    onAssign={() => onAssign(g)}
                    onVoid={onVoid}
                  />
                ))}
              </div>
            </section>
          ))}

          {detached.length > 0 && (
            <section className="rt-partner rt-detached">
              <h3>Assigned BOLs no longer in the feed <span className="muted">· already routed / re-exported away</span></h3>
              <div className="rt-cards">
                {detached.map((s) => (
                  <div key={s.id} className="rt-card">
                    <div className="rt-dc">
                      <span className="rt-dcCode">{s.dc}</span>
                      <span className="muted">{s.partner}</span>
                    </div>
                    <div className="rt-bol assigned">
                      <span className="rt-bolLabel">BOL</span>
                      <span className="rt-bolNum">{s.bolNumber}</span>
                    </div>
                    <div className="muted rt-memberPos">PO {(s.memberPos || []).join(', ')}</div>
                    <div className="rt-portal">
                      <Cell label="Cartons" v={s.cartons} />
                      <Cell label="Weight (lb)" v={s.weightLb} />
                      <Cell label="Cubic ft" v={s.cubicFeet} />
                    </div>
                    <button className="btnGhost" disabled={busy === 'void' + s.id} onClick={() => onVoid(s)}>Void</button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ShipmentCard({ g, busy, onAssign, onVoid }) {
  const s = g.shipment
  return (
    <div className={'rt-card' + (s ? ' has-bol' : '')}>
      <div className="rt-dc">
        <span className="rt-dcCode">{g.dc}</span>
        <span className="rt-dcName">{g.dcLabel}</span>
      </div>
      <div className="muted rt-memberPos">
        {g.poCount} PO{g.poCount === 1 ? '' : 's'}: {g.memberPos.join(', ')}
      </div>

      <div className="rt-portal">
        <Cell label="Cartons" v={g.cartons} big />
        <Cell label="Weight (lb)" v={g.weightLb} big />
        <Cell label="Cubic ft" v={g.cubicFeet} big />
        {g.showUnits && <Cell label="Units" v={g.units} big />}
      </div>

      {g.cubicRoundingDiffers && (
        <div className="rt-warn" title="The feed's summed per-row rounded cubic feet differs from a single round-up of the raw total.">
          ⚠ cubic ft: {g.cubicFeet} (round-up of {g.rawCubicFeet}); feed's per-row sum = {g.cubicFeetRoundedSum}
        </div>
      )}

      {s ? (
        <div className="rt-bol assigned">
          <span className="rt-bolLabel">BOL</span>
          <span className="rt-bolNum">{s.bolNumber}</span>
          <button className="btnGhost" disabled={busy === 'void' + s.id} onClick={() => onVoid(s)}>Void</button>
        </div>
      ) : (
        <button className="btn rt-assign" disabled={busy === g.dcPoKey} onClick={onAssign}>
          {busy === g.dcPoKey ? 'Assigning…' : 'Assign BOL'}
        </button>
      )}
    </div>
  )
}

function Cell({ label, v, big }) {
  return (
    <div className={'rt-cell' + (big ? ' big' : '')}>
      <div className="rt-cellV num">{v ?? '—'}</div>
      <div className="rt-cellL muted">{label}</div>
    </div>
  )
}
