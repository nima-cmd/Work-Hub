import { useEffect, useMemo, useState } from 'react'
import {
  fetchRouting, assignRoutingBol, voidRoutingShipment,
  setShipmentRefs, saveRoutingAuth, deleteRoutingAuth,
  bolPdfUrl, fileBolToDrive, holdRoutingPo, releaseRoutingPo,
  masterBolPdfUrl, fileMasterToDrive,
} from '../api.js'
import { consolidateRouting } from '../../../src/model/routing.js'
import EmailLinks from '../EmailLinks.jsx'

// EDI Routing (Nima, 2026-07-22) — replaces the NetSuite routing_helper.js
// Suitelet + Google Sheet. Pick which POs are shipping, consolidate into ONE
// shipment per DC, show the exact whole-number portal entries (cartons /
// weight / rounded cubic feet, + units for Nordstrom), assign a guaranteed-
// unique BOL per DC, then capture the routing references (portal Project# /
// Shipment#, authorization, carrier / SCAC) as they come back.
const STATUS = {
  needs_routing: { label: 'Needs routing', cls: 'st-need' },
  submitted: { label: 'Submitted', cls: 'st-sub' },
  authorized: { label: 'Authorized', cls: 'st-auth' },
  routed: { label: 'Routed', cls: 'st-routed' },
  // legacy value from before the rename — still render it if any row has it
  bol_assigned: { label: 'Needs routing', cls: 'st-need' },
}
const STATUS_ORDER = ['needs_routing', 'submitted', 'authorized', 'routed']

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
  // Held PO-DCs are excluded so they can't be bundled into a DC's BOL.
  const groups = useMemo(() => {
    if (!data) return []
    const held = new Set(data.heldKeys || [])
    const rows = (data.packages || []).filter((p) => isSelected(p.poNumber) && !held.has(`${p.poNumber}|${p.dc}`))
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
  function onHold(po, dc) {
    const note = window.prompt(`Hold PO ${po} · DC ${dc} out of routing (packed, can’t ship yet). Reason (optional):`, '')
    if (note === null) return // cancelled
    run('hold' + po + dc, () => holdRoutingPo({ po, dc, note: note || null }))
  }
  const onRelease = (po, dc) => run('rel' + po + dc, () => releaseRoutingPo(po, dc))

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

          <GapsPanel gaps={data.gaps} />

          <HeldPanel held={data.held} busy={busy} onRelease={onRelease} />

          <AuthPanel auths={auths} shipments={data.shipments || []} busy={busy}
            onSave={(b) => run('auth', () => saveRoutingAuth(b))}
            onDelete={(n) => run('authdel' + n, () => deleteRoutingAuth(n))} />

          {byPartner.map(([partner, list]) => (
            <section key={partner} className="rt-partner">
              <h3>{partner} <span className="muted">· {list.length} DC{list.length === 1 ? '' : 's'}</span></h3>
              <div className="rt-cards">
                {list.map((g) => (
                  <ShipmentCard key={g.dcPoKey} g={g} auths={auths} busy={busy}
                    onAssign={() => onAssign(g)} onVoid={onVoid} onSaveRefs={onSaveRefs} onHold={onHold} />
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

// The Scan Bay bridge: DC cartons in our possession that we can't route because
// the feed is missing them or is older than the scan. Tells Nima what to export
// and why. Cartons already given a BOL are shown as handled, not as gaps.
function GapsPanel({ gaps }) {
  const items = (gaps?.items || []).filter((g) => !g.hasShipment)
  if (!items.length) return null
  const missing = items.filter((g) => g.reason === 'missing')
  const stale = items.filter((g) => g.reason === 'stale')
  return (
    <div className="rt-gaps">
      <div className="rt-gapsHead">
        ⚠ {items.length} PO-DC{items.length === 1 ? '' : 's'} in your possession, not routable yet
        <span className="muted"> — scanned back in but missing package info</span>
      </div>
      {missing.length > 0 && (
        <div className="rt-gapGroup">
          <div className="rt-gapWhy"><b>Missing from the feed</b> — packed &amp; scanned back, but not in EDI Packages Volume. Export/re-import searchid=3947 (or finish packing them in NetSuite).</div>
          <div className="rt-gapChips">{missing.map((g) => <span key={g.label} className="rt-gapChip miss">{g.label}</span>)}</div>
        </div>
      )}
      {stale.length > 0 && (
        <div className="rt-gapGroup">
          <div className="rt-gapWhy"><b>Feed is stale</b> — you scanned these back <i>after</i> the last EDI Packages Volume export{gaps.feedImportedAt ? ` (${new Date(gaps.feedImportedAt).toLocaleDateString()})` : ''}. Re-import 3947 so the numbers are current.</div>
          <div className="rt-gapChips">{stale.map((g) => <span key={g.label} className="rt-gapChip stale">{g.label}</span>)}</div>
        </div>
      )}
    </div>
  )
}

// Held PO-DCs — pulled out of routing (packed, can't ship). Kept off every DC
// group so they're never bundled onto another PO's BOL; released back here.
function HeldPanel({ held, busy, onRelease }) {
  const items = held || []
  if (!items.length) return null
  return (
    <div className="rt-heldPanel">
      <div className="rt-heldHead">⏸ Held — packed, not shipping <span className="muted">· kept off every BOL until released</span></div>
      <div className="rt-heldList">
        {items.map((h) => (
          <div key={h.label} className="rt-heldChip">
            <b>{h.label}</b>
            {h.cartons != null && <span className="muted"> · {h.cartons} ctn</span>}
            {h.note && <span className="rt-heldNote">“{h.note}”</span>}
            {!h.inFeed && <span className="muted"> · not in feed</span>}
            <button className="rt-return" disabled={busy === 'rel' + h.po + h.dc} onClick={() => onRelease(h.po, h.dc)}>↩ return to routing</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function AuthPanel({ auths, shipments, busy, onSave, onDelete }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ authNumber: '', partner: "Bloomingdale's", carrier: '', scac: '' })
  function add() {
    if (!draft.authNumber.trim()) return
    onSave(draft)
    setDraft({ authNumber: '', partner: "Bloomingdale's", carrier: '', scac: '' })
  }
  const countFor = (n) => shipments.filter((s) => s.authNumber === n).length
  return (
    <div className="rt-auths">
      <button className="rt-authsToggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Routing authorizations <span className="muted">({auths.length})</span>
      </button>
      {open && (
        <div className="rt-authsBody">
          <div className="muted rt-authsHint">
            One auth number covers a set of shipments (from the routing email). Create it here, then
            select it on each shipment it covers — that stamps the carrier / SCAC. When an auth covers
            multiple final DCs, generate ONE Master BOL for the merge center (not sent on the 856).
          </div>
          <div className="rt-authList">
            {auths.map((a) => {
              const n = countFor(a.authNumber)
              return (
                <div key={a.authNumber} className="rt-authChip">
                  <div className="rt-authChipTop">
                    <b>{a.authNumber}</b>
                    <span className="muted"> · {a.partner || '—'}</span>
                    {a.carrier && <span className="muted"> · {a.carrier}</span>}
                    {a.scac && <span className="rt-scac">{a.scac}</span>}
                    <span className="muted"> · {n} shipment{n === 1 ? '' : 's'}</span>
                    {n >= 2 && a.partner !== 'Nordstrom' && <MasterActions auth={a} />}
                    <button className="rt-x" disabled={busy === 'authdel' + a.authNumber} onClick={() => onDelete(a.authNumber)} title="Delete auth">✕</button>
                  </div>
                  <EmailLinks docType="AUTH" docNumber={a.authNumber} compact />
                </div>
              )
            })}
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

function ShipmentCard({ g, auths, busy, onAssign, onVoid, onSaveRefs, onHold, detached }) {
  const s = g.shipment
  const [editing, setEditing] = useState(false)
  const st = s ? (STATUS[s.status] || STATUS.needs_routing) : null
  const canHold = onHold && !detached

  return (
    <div className={'rt-card' + (s ? ' has-bol' : '')}>
      <div className="rt-dc">
        <span className="rt-dcCode">{g.dc}</span>
        <span className="rt-dcName">{g.dcLabel}</span>
        {st && <span className={'rt-status ' + st.cls}>{st.label}</span>}
      </div>
      <div className="rt-memberPos">
        <span className="muted">{g.poCount} PO{g.poCount === 1 ? '' : 's'}:</span>
        {(g.memberPos || []).map((po) => (
          <span key={po} className="rt-poTag">
            {po}
            {canHold && (
              <button className="rt-holdBtn" title="Hold this PO out of routing (packed, can’t ship — keeps it off this BOL)"
                disabled={busy === 'hold' + po + g.dc} onClick={() => onHold(po, g.dc)}>⊘</button>
            )}
          </span>
        ))}
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
          <EmailLinks docType="ROUTING_SHIPMENT" docNumber={s.id} compact />
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

// Master BOL for an authorization covering multiple final DCs (merge-center
// consolidation). Opens the aggregated Master BOL PDF; files it to Drive.
function MasterActions({ auth }) {
  const [state, setState] = useState(null)
  async function file() {
    setState({ busy: true })
    try {
      const r = await fileMasterToDrive(auth.authNumber)
      if (r.needsReauth) setState({ msg: 'Drive not authorized yet', ok: false })
      else if (r.configured === false) setState({ msg: 'Google not connected', ok: false })
      else setState({ msg: 'filed', ok: true })
    } catch (e) { setState({ msg: e.message, ok: false }) }
  }
  return (
    <span className="rt-masterActions">
      <a className="rt-masterLink" href={masterBolPdfUrl(auth.authNumber)} target="_blank" rel="noreferrer">
        📋 Master BOL{auth.masterBolNumber ? ` ${auth.masterBolNumber}` : ''} ↗
      </a>
      <button className="rt-masterFile" disabled={state?.busy} onClick={file}>{state?.busy ? '…' : '⤒ Drive'}</button>
      {state?.msg && <span className={'rt-masterMsg ' + (state.ok ? 'ok' : 'err')}>{state.ok ? '✓ filed' : state.msg}</span>}
    </span>
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
    status: s.status || 'needs_routing',
    authNumber: s.authNumber || '',
    carrier: s.carrier || '',
    scac: s.scac || '',
    projectNumber: s.projectNumber || '',
    shipmentNumber: s.shipmentNumber || '',
    shipDate: s.shipDate ? String(s.shipDate).slice(0, 10) : '',
    mergeCenter: s.mergeCenter || 'CA',
    trailerNumber: s.trailerNumber || '',
    sealNumber: s.sealNumber || '',
  })
  const isBloomies = s.partner === "Bloomingdale's"
  const set = (k) => (e) => setD({ ...d, [k]: e.target.value })

  // The Bloomingdale's auth # comes from the routing email — typed in directly.
  // If what's typed matches an auth we already have, fill carrier/SCAC from it
  // and advance the status; otherwise it registers as a new auth on save.
  function onAuthType(e) {
    const authNumber = e.target.value
    const a = auths.find((x) => x.authNumber === authNumber)
    setD((prev) => ({
      ...prev, authNumber,
      carrier: a?.carrier || prev.carrier,
      scac: a?.scac || prev.scac,
      status: a && (prev.status === 'needs_routing' || prev.status === 'submitted') ? 'authorized' : prev.status,
    }))
  }

  return (
    <div className="rt-editor">
      <label>Status
        <select value={d.status} onChange={set('status')}>
          {STATUS_ORDER.map((k) => <option key={k} value={k}>{STATUS[k].label}</option>)}
        </select>
      </label>
      <label>Authorization # <span className="rt-fieldHint">— from the Bloomingdale's routing email</span>
        <input list="rt-auth-list" value={d.authNumber} onChange={onAuthType} placeholder="type the auth # from the email" />
        <datalist id="rt-auth-list">
          {auths.map((a) => <option key={a.authNumber} value={a.authNumber}>{a.carrier ? `${a.carrier}${a.scac ? ` (${a.scac})` : ''}` : ''}</option>)}
        </datalist>
      </label>
      <div className="rt-editRow">
        <label>Project #<input value={d.projectNumber} onChange={set('projectNumber')} placeholder="Bloomingdale's" /></label>
        <label>Shipment #<input value={d.shipmentNumber} onChange={set('shipmentNumber')} /></label>
      </div>
      <div className="rt-editRow">
        <label>Carrier<input value={d.carrier} onChange={set('carrier')} /></label>
        <label>SCAC<input value={d.scac} onChange={set('scac')} /></label>
      </div>
      {isBloomies && (
        <label>Merge center (ship-to)
          <select value={d.mergeCenter} onChange={set('mergeCenter')}>
            <option value="CA">Mega-Merge CA · Santa Fe Springs</option>
            <option value="NJ">Mega-Merge NJ · Burlington</option>
            <option value="HP">High Point Merge · Dynamic</option>
          </select>
        </label>
      )}
      <div className="rt-editRow">
        <label>Trailer #<input value={d.trailerNumber} onChange={set('trailerNumber')} /></label>
        <label>Seal #<input value={d.sealNumber} onChange={set('sealNumber')} /></label>
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
