import { useEffect, useMemo, useState } from 'react'
import {
  fetchRouting, assignRoutingBol, voidRoutingShipment,
  setShipmentRefs, saveRoutingAuth, deleteRoutingAuth,
  bolPdfUrl, fileBolToDrive,
} from '../api.js'
import { consolidateRouting } from '../../../src/model/routing.js'

// EDI Routing (Nima, 2026-07-22) — replaces the NetSuite routing_helper.js
// Suitelet + Google Sheet. Pick which POs are shipping, consolidate into ONE
// shipment per DC, show the exact whole-number portal entries (cartons /
// weight / rounded cubic feet, + units for Nordstrom), assign a guaranteed-
// unique BOL per DC, then capture the routing references (portal Project# /
// Shipment#, authorization, carrier / SCAC) as they come back.
const STATUS = {
  bol_assigned: { label: 'BOL assigned', cls: '' },
  submitted: { label: 'Submitted', cls: 'st-sub' },
  authorized: { label: 'Authorized', cls: 'st-auth' },
  routed: { label: 'Routed', cls: 'st-routed' },
}
const STATUS_ORDER = ['bol_assigned', 'submitted', 'authorized', 'routed']

export default function Routing() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const [selected, setSelected] = useState(null) // Set<poNumber> | null (=all)

  function load() {
    fetchRouting().then(setData).catch((e) => setErr(e.message))
  }
  useEffect(load, [])

  const allPos = useMemo(() => {
    if (!data) return []
    return [...new Set((data.packages || []).map((p) => p.poNumber).filter(Boolean))].sort()
  }, [data])

  const isSelected = (po) => (selected ? selected.has(po) : true)
  function togglePo(po) {
    setSelected((prev) => {
      const next = new Set(prev ? prev : allPos)
      next.has(po) ? next.delete(po) : next.add(po)
      return next
    })
  }

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

  async function run(key, fn) {
    setBusy(key); setErr(null)
    try { setData(await fn()) } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

  const onAssign = (g) => run(g.dcPoKey, () => assignRoutingBol({
    partner: g.partner, dc: g.dc, memberPos: g.memberPos,
    cartons: g.cartons, units: g.units, weightLb: g.weightLb, cubicFeet: g.cubicFeet,
  }))
  const onVoid = (s) => {
    if (!confirm(`Void BOL ${s.bolNumber}? The number stays retired and is never reused.`)) return
    run('void' + s.id, () => voidRoutingShipment(s.id))
  }
  const onSaveRefs = (id, fields) => run('refs' + id, () => setShipmentRefs(id, fields))

  if (err && !data) return <div className="banner error">⚠ {err}</div>
  if (!data) return <div className="banner">Loading routing feed…</div>

  const auths = data.auths || []
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
              <button key={po} className={'rt-poChip' + (isSelected(po) ? ' on' : '')} onClick={() => togglePo(po)}>{po}</button>
            ))}
            <button className="btnGhost" onClick={() => setSelected(null)}>All</button>
            <button className="btnGhost" onClick={() => setSelected(new Set())}>None</button>
          </div>

          <AuthPanel auths={auths} busy={busy}
            onSave={(b) => run('auth', () => saveRoutingAuth(b))}
            onDelete={(n) => run('authdel' + n, () => deleteRoutingAuth(n))} />

          {byPartner.map(([partner, list]) => (
            <section key={partner} className="rt-partner">
              <h3>{partner} <span className="muted">· {list.length} DC{list.length === 1 ? '' : 's'}</span></h3>
              <div className="rt-cards">
                {list.map((g) => (
                  <ShipmentCard key={g.dcPoKey} g={g} auths={auths} busy={busy}
                    onAssign={() => onAssign(g)} onVoid={onVoid} onSaveRefs={onSaveRefs} />
                ))}
              </div>
            </section>
          ))}

          {detached.length > 0 && (
            <section className="rt-partner rt-detached">
              <h3>Assigned BOLs no longer in the feed <span className="muted">· already routed / re-exported away</span></h3>
              <div className="rt-cards">
                {detached.map((s) => (
                  <ShipmentCard key={s.id} g={{ ...s, dcLabel: s.dc, poCount: (s.memberPos || []).length, shipment: s }}
                    auths={auths} busy={busy} onVoid={onVoid} onSaveRefs={onSaveRefs} detached />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function AuthPanel({ auths, busy, onSave, onDelete }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ authNumber: '', partner: "Bloomingdale's", carrier: '', scac: '' })
  function add() {
    if (!draft.authNumber.trim()) return
    onSave(draft)
    setDraft({ authNumber: '', partner: "Bloomingdale's", carrier: '', scac: '' })
  }
  return (
    <div className="rt-auths">
      <button className="rt-authsToggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Routing authorizations <span className="muted">({auths.length})</span>
      </button>
      {open && (
        <div className="rt-authsBody">
          <div className="muted rt-authsHint">
            One auth number covers a set of shipments (from the routing email). Create it here, then
            select it on each shipment it covers — that stamps the carrier / SCAC.
          </div>
          <div className="rt-authList">
            {auths.map((a) => (
              <div key={a.authNumber} className="rt-authChip">
                <b>{a.authNumber}</b>
                <span className="muted"> · {a.partner || '—'}</span>
                {a.carrier && <span className="muted"> · {a.carrier}</span>}
                {a.scac && <span className="rt-scac">{a.scac}</span>}
                <button className="rt-x" disabled={busy === 'authdel' + a.authNumber} onClick={() => onDelete(a.authNumber)} title="Delete auth">✕</button>
              </div>
            ))}
            {!auths.length && <span className="muted">No authorizations yet.</span>}
          </div>
          <div className="rt-authForm">
            <input placeholder="Auth #" value={draft.authNumber} onChange={(e) => setDraft({ ...draft, authNumber: e.target.value })} />
            <select value={draft.partner} onChange={(e) => setDraft({ ...draft, partner: e.target.value })}>
              <option>Bloomingdale's</option>
              <option>Nordstrom</option>
            </select>
            <input placeholder="Carrier" value={draft.carrier} onChange={(e) => setDraft({ ...draft, carrier: e.target.value })} />
            <input placeholder="SCAC" value={draft.scac} onChange={(e) => setDraft({ ...draft, scac: e.target.value })} />
            <button className="btn" disabled={busy === 'auth' || !draft.authNumber.trim()} onClick={add}>Add auth</button>
          </div>
        </div>
      )}
    </div>
  )
}

function ShipmentCard({ g, auths, busy, onAssign, onVoid, onSaveRefs, detached }) {
  const s = g.shipment
  const [editing, setEditing] = useState(false)
  const st = s ? (STATUS[s.status] || STATUS.bol_assigned) : null

  return (
    <div className={'rt-card' + (s ? ' has-bol' : '')}>
      <div className="rt-dc">
        <span className="rt-dcCode">{g.dc}</span>
        <span className="rt-dcName">{g.dcLabel}</span>
        {st && <span className={'rt-status ' + st.cls}>{st.label}</span>}
      </div>
      <div className="muted rt-memberPos">
        {g.poCount} PO{g.poCount === 1 ? '' : 's'}: {(g.memberPos || []).join(', ')}
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

      {!s ? (
        <button className="btn rt-assign" disabled={busy === g.dcPoKey} onClick={onAssign}>
          {busy === g.dcPoKey ? 'Assigning…' : 'Assign BOL'}
        </button>
      ) : (
        <>
          <div className="rt-bol assigned">
            <span className="rt-bolLabel">BOL</span>
            <span className="rt-bolNum">{s.bolNumber}</span>
            <button className="btnGhost" disabled={busy === 'void' + s.id} onClick={() => onVoid(s)}>Void</button>
          </div>

          <BolActions s={s} />
          <RefSummary s={s} />
          <button className="rt-editToggle" onClick={() => setEditing((e) => !e)}>
            {editing ? '▾ Route info' : '✎ Route info'}
          </button>
          {editing && (
            <RefEditor s={s} auths={auths} busy={busy === 'refs' + s.id}
              onSave={(fields) => { onSaveRefs(s.id, fields); setEditing(false) }} />
          )}
        </>
      )}
    </div>
  )
}

// Generate / file the VICS BOL. The PDF opens inline (browser can save/print);
// "File to Drive" uploads it to /Work-Hub BOLs/<partner>/<PO>/ and links back.
function BolActions({ s }) {
  const [state, setState] = useState(null) // { busy } | { msg, ok, links }
  async function file() {
    setState({ busy: true })
    try {
      const r = await fileBolToDrive(s.id)
      if (r.needsReauth) setState({ msg: 'Drive not authorized yet — re-run connect-gmail.js to add the Drive scope.', ok: false })
      else if (r.configured === false) setState({ msg: 'Google not connected on this server.', ok: false })
      else setState({ msg: `Filed to Drive (${r.uploaded.length} folder${r.uploaded.length === 1 ? '' : 's'}).`, ok: true, links: r.uploaded })
    } catch (e) { setState({ msg: e.message, ok: false }) }
  }
  return (
    <div className="rt-bolActions">
      <a className="btnGhost" href={bolPdfUrl(s.id)} target="_blank" rel="noreferrer">BOL PDF ↗</a>
      <button className="btnGhost" disabled={state?.busy} onClick={file}>
        {state?.busy ? 'Filing…' : '⤒ File to Drive'}
      </button>
      {state?.msg && (
        <div className={'rt-driveMsg ' + (state.ok ? 'ok' : 'err')}>
          {state.msg}
          {state.links?.map((u) => u.link && <a key={u.id} href={u.link} target="_blank" rel="noreferrer"> · PO {u.po} ↗</a>)}
        </div>
      )}
    </div>
  )
}

// Compact read-only summary of whatever references are set.
function RefSummary({ s }) {
  const bits = []
  if (s.authNumber) bits.push(['Auth', s.authNumber])
  if (s.carrier) bits.push(['Carrier', s.carrier + (s.scac ? ` (${s.scac})` : '')])
  if (s.projectNumber) bits.push(['Project', s.projectNumber])
  if (s.shipmentNumber) bits.push(['Shipment', s.shipmentNumber])
  if (s.shipDate) bits.push(['Ship', String(s.shipDate).slice(0, 10)])
  if (!bits.length) return null
  return (
    <div className="rt-refSummary">
      {bits.map(([k, v]) => <span key={k} className="rt-refBit"><span className="muted">{k}</span> {v}</span>)}
    </div>
  )
}

function RefEditor({ s, auths, busy, onSave }) {
  const [d, setD] = useState({
    status: s.status || 'bol_assigned',
    authNumber: s.authNumber || '',
    carrier: s.carrier || '',
    scac: s.scac || '',
    projectNumber: s.projectNumber || '',
    shipmentNumber: s.shipmentNumber || '',
    shipDate: s.shipDate ? String(s.shipDate).slice(0, 10) : '',
  })
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value })

  // Picking an existing auth fills carrier/SCAC from it (the routing email
  // delivers them together) — still editable afterwards.
  function pickAuth(e) {
    const authNumber = e.target.value
    const a = auths.find((x) => x.authNumber === authNumber)
    setD((prev) => ({
      ...prev, authNumber,
      carrier: a?.carrier || prev.carrier,
      scac: a?.scac || prev.scac,
      status: prev.status === 'bol_assigned' || prev.status === 'submitted' ? 'authorized' : prev.status,
    }))
  }

  return (
    <div className="rt-editor">
      <label>Status
        <select value={d.status} onChange={set('status')}>
          {STATUS_ORDER.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
        </select>
      </label>
      <label>Authorization
        <select value={d.authNumber} onChange={pickAuth}>
          <option value="">— none —</option>
          {auths.map((a) => <option key={a.authNumber} value={a.authNumber}>{a.authNumber}{a.carrier ? ` · ${a.carrier}` : ''}</option>)}
        </select>
      </label>
      <div className="rt-editRow">
        <label>Project #<input value={d.projectNumber} onChange={set('projectNumber')} placeholder="Bloomingdale's" /></label>
        <label>Shipment #<input value={d.shipmentNumber} onChange={set('shipmentNumber')} /></label>
      </div>
      <div className="rt-editRow">
        <label>Carrier<input value={d.carrier} onChange={set('carrier')} /></label>
        <label>SCAC<input value={d.scac} onChange={set('scac')} /></label>
      </div>
      <label>Ship date<input type="date" value={d.shipDate} onChange={set('shipDate')} /></label>
      <button className="btn" disabled={busy} onClick={() => onSave(d)}>{busy ? 'Saving…' : 'Save route info'}</button>
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
