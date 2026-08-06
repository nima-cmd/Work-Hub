import { useEffect, useMemo, useState } from 'react'
import {
  fetchRouting, assignRoutingBol, voidRoutingShipment, setShipmentShipped,
  setShipmentRefs, saveRoutingAuth, deleteRoutingAuth,
  bolPdfUrl, fileBolToDrive, holdRoutingPo, releaseRoutingPo,
  masterBolPdfUrl, fileMasterToDrive, refreshRoutingFeed, pushToShipstation, applyTender,
} from '../api.js'
import { consolidateRouting } from '../../../src/model/routing.js'
import { CARRIERS, macysDc } from '../../../src/model/bolAddresses.js'
import { checkGroupPack, packSummary } from '../../../src/model/packCheck.js'
import EmailLinks from '../EmailLinks.jsx'

// One-line preview of the stored DC address, so a DC-direct routing shows WHERE
// it is going before the BOL is generated. Returns null when we hold no address
// for that DC — the caller says so plainly rather than printing a guess (the same
// rule bolAddresses.js follows: a missing field renders "(confirm …)", never a
// plausible-looking address).
// ⚠️ Goes through macysDc, NOT MACYS_DCS[dc] — a shipment's `dc` is the
// ABBREVIATION ('SC'), while the table is keyed on the full name ('Secaucus'), so
// the direct index silently returns null and this rendered "No stored address" for
// every DC. Caught on screen, not in review.
function shipToLine(dc) {
  const a = macysDc(dc)
  return a ? `→ ${a.name}, ${a.street}, ${a.city}, ${a.state} ${a.zip}` : null
}

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
// Per-pallet tare added to the freight weight on a master BOL (mirrors PALLET_LB
// in server/bolPdf.js) — for the tooltip only; the server does the real math.
const PALLET_TARE_LB = 43

// Local-time YYYY-MM-DD (not toISOString, which is UTC and can roll a day).
function todayStr() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export default function Routing() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const [selected, setSelected] = useState(null) // Set<poNumber> | null (=all)
  const [groupSel, setGroupSel] = useState(() => new Set()) // Set<shipmentId> to master-group
  const [tab, setTab] = useState('active') // 'active' | 'shipped'

  const [pulled, setPulled] = useState(null) // last NetSuite pull's result line
  const [pushed, setPushed] = useState(null) // last ShipStation push's result line

  function load() {
    fetchRouting().then(setData).catch((e) => setErr(e.message))
  }
  useEffect(load, [])

  // Go back to NetSuite for cartons packed since the last sync. Safe to hit
  // repeatedly mid-pack — it's the same work the scheduled sync does.
  async function onPull() {
    setBusy('pull'); setErr(null)
    try {
      const r = await refreshRoutingFeed()
      setData(r.routing)
      setPulled(r.synced)
    } catch (e) { setErr(e.message) } finally { setBusy(null) }
  }

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
    // Pack check, recomputed here for the same reason consolidation is: the PO
    // selection above changes which fulfilments belong to a group.
    const packByPoDc = new Map()
    for (const f of data.fulfilmentPack || []) {
      if (!packByPoDc.has(f.poDc)) packByPoDc.set(f.poDc, [])
      packByPoDc.get(f.poDc).push(f)
    }
    return consolidateRouting(rows).map((g) => {
      const dcPoKey = `${g.partner}|${g.dc}|${g.memberPos.join(',')}`
      const members = (g.memberPos || []).flatMap((po) => packByPoDc.get(`${po}-${g.dc}`) || [])
      return { ...g, dcPoKey, shipment: byKey.get(dcPoKey) || null, pack: checkGroupPack(members) }
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
  // Accept the partner TMS's tender across every BOL it covers. Confirmed first: it
  // rewrites a date on several shipments at once, and the count is the point.
  const onApplyTender = (t) => {
    if (!confirm(`Accept tender ${t.shipmentId}?\n\nSets pickup ${t.pickupDate}` +
      `${t.carrier ? ` and carrier ${t.carrier}` : ''} on every BOL it covers.\n` +
      `A routing request number you typed yourself is never overwritten.`)) return
    run('tender' + t.shipmentId, async () => (await applyTender(t.shipmentId)).routing)
  }

  const onVoid = (s) => {
    if (!confirm(`Void BOL ${s.bolNumber}? The number stays retired and is never reused.`)) return
    run('void' + s.id, () => voidRoutingShipment(s.id))
  }
  async function onPushShipstation() {
    setBusy('ss')
    try {
      const r = await pushToShipstation({ scope: 'edi' })
      setPushed(r)
      setErr(r.failed ? `${r.failed} of ${r.candidates} carton(s) failed to reach ShipStation` : null)
    } catch (e) {
      setErr('ShipStation push failed: ' + e.message)
    } finally { setBusy(null) }
  }
  const onSaveRefs = (id, fields) => run('refs' + id, () => setShipmentRefs(id, fields))
  const onShip = (s) => run('ship' + s.id, () => setShipmentShipped(s.id, !s.shippedAt))
  // Toggle the routed flag with no paperwork attached — Nordstrom never gets a
  // number to record, so the status is the only thing that can move.
  const onSetRouted = (s, routed) =>
    run('routed' + s.id, () => setShipmentRefs(s.id, { status: routed ? 'routed' : 'needs_routing' }))
  function toggleGroup(id) {
    setGroupSel((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }
  // Group the checkbox-selected BOLs under one dated Master BOL: assign them the
  // auth (created if new), stamp the ship date, mint the master.
  async function onGroup({ authNumber, shipDate, carrier, scac }) {
    const ids = [...groupSel]
    // carrier/scac ride along on the same call (Nima, 2026-08-02). saveRoutingAuth
    // upserts the auth FIRST and then stamps its carrier/SCAC onto every grouped
    // shipment, so one click sets the master and all its children. Blank means
    // "unchanged", not "clear" — upsertRoutingAuth COALESCEs, so grouping more
    // BOLs into an existing auth can't wipe a carrier that's already right.
    await run('group', () => saveRoutingAuth({
      authNumber, partner: "Bloomingdale's", shipDate, carrier, scac, shipmentIds: ids,
    }))
    setGroupSel(new Set())
  }
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
  // Shipped shipments (physically left) move out of the active board into the
  // Shipped archive tab. Active = everything not-yet-shipped.
  const shippedShipments = (data.shipments || []).filter((s) => s.shippedAt)
  const activeByPartner = byPartner
    .map(([p, list]) => [p, list.filter((g) => !g.shipment?.shippedAt)])
    .filter(([, list]) => list.length)
  const activeDetached = detached.filter((s) => !s.shippedAt)
  const shippedByPartner = [...shippedShipments.reduce((m, s) => {
    if (!m.has(s.partner)) m.set(s.partner, [])
    m.get(s.partner).push(s)
    return m
  }, new Map()).entries()]

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
        <div className="rt-headActions">
          {/* Two genuinely different refreshes, and conflating them is why packed
              cartons appeared to be "missing from the feed": Reload re-reads
              what Neon already has, Pull goes back to NetSuite for cartons
              packed since the last sync. Packing runs for hours, so Pull is the
              one that matters mid-pack — hence it's the primary button. */}
          <button className="btn rt-pull" disabled={busy === 'pull'} onClick={onPull}
                  title="Re-read the carton records straight from NetSuite — use this as you finish packing">
            {busy === 'pull' ? '⟳ Pulling from NetSuite…' : '⟳ Pull from NetSuite'}
          </button>
          {/* Queue the DC-direct parcel cartons in ShipStation so labels can be
              bought there rather than typed. Creates/updates orders ONLY — nothing
              is purchased, and a re-push updates in place (orderKey is the carton's
              stable identity), so it is safe to press twice. */}
          <button className="btn" disabled={busy === 'ss'} onClick={onPushShipstation}
                  title="Create/update ShipStation orders for the DC-direct parcel cartons. Never buys a label.">
            {busy === 'ss' ? '⇪ Pushing…' : '⇪ Push to ShipStation'}
          </button>
          <button className="btnGhost" disabled={busy === 'pull'} onClick={load}
                  title="Re-read what the app already has — does not go back to NetSuite">↻ Reload
          </button>
        </div>
      </div>

      {err && <div className="banner error">⚠ {err}</div>}
      {pulled && (
        <div className={'banner ' + (pulled.skipped ? 'warn' : 'ok')}>
          {pulled.skipped
            ? `NetSuite returned no cartons — the feed was left untouched (${pulled.skipped}).`
            : `Pulled ${pulled.cartons} carton${pulled.cartons === 1 ? '' : 's'} from NetSuite across ${pulled.loaded} PO-DC group${pulled.loaded === 1 ? '' : 's'}.`}
        </div>
      )}

      {/* Says what to do NEXT — a queued order is not a label until someone buys it,
          and leaving that implicit is how a shipment sits unshipped. */}
      {pushed && (
        <div className={'banner ' + (pushed.failed ? 'warn' : 'ok')}>
          ⇪ ShipStation: {pushed.pushed} carton{pushed.pushed === 1 ? '' : 's'} queued
          {pushed.failed ? `, ${pushed.failed} failed` : ''} — buy the labels in ShipStation. Nothing was purchased.
        </div>
      )}

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

          <PackWarning groups={groups} />

          <GapsPanel gaps={data.gaps} />

          <HeldPanel held={data.held} busy={busy} onRelease={onRelease} />

          <AuthPanel auths={auths} shipments={data.shipments || []} busy={busy}
            onSave={(b) => run('auth', () => saveRoutingAuth(b))}
            onDelete={(n) => run('authdel' + n, () => deleteRoutingAuth(n))} />

          <div className="rt-tabs">
            <button className={'tab' + (tab === 'active' ? ' active' : '')} onClick={() => setTab('active')}>
              Active <span className="count">{activeByPartner.reduce((n, [, l]) => n + l.length, 0) + activeDetached.length}</span>
            </button>
            <button className={'tab' + (tab === 'shipped' ? ' active' : '')} onClick={() => setTab('shipped')}>
              Shipped <span className="count">{shippedShipments.length}</span>
            </button>
          </div>

          {tab === 'active' && <>
          <GroupBar groups={groups} groupSel={groupSel} auths={auths} busy={busy}
            onGroup={onGroup} onClear={() => setGroupSel(new Set())} />

          {activeByPartner.map(([partner, list]) => (
            <section key={partner} className="rt-partner">
              <h3>{partner} <span className="muted">· {list.length} DC{list.length === 1 ? '' : 's'}</span></h3>
              <div className="rt-cards">
                {list.map((g) => (
                  <ShipmentCard key={g.dcPoKey} g={g} auths={auths} busy={busy}
                    onAssign={() => onAssign(g)} onVoid={onVoid} onSaveRefs={onSaveRefs} onHold={onHold}
                    onShip={g.shipment ? onShip : null}
                    onSetRouted={g.shipment ? onSetRouted : null}
                    onApplyTender={onApplyTender}
                    groupable={partner === "Bloomingdale's"}
                    groupChecked={g.shipment ? groupSel.has(g.shipment.id) : false}
                    onToggleGroup={g.shipment ? () => toggleGroup(g.shipment.id) : null} />
                ))}
              </div>
            </section>
          ))}

          {activeDetached.length > 0 && (
            <section className="rt-partner rt-detached">
              <h3>Assigned BOLs no longer in the feed <span className="muted">· already routed / re-exported away</span></h3>
              <div className="rt-cards">
                {activeDetached.map((s) => (
                  <ShipmentCard key={s.id} g={{ ...s, dcLabel: s.dc, poCount: (s.memberPos || []).length, shipment: s }}
                    auths={auths} busy={busy} onVoid={onVoid} onSaveRefs={onSaveRefs} onShip={onShip}
                    onApplyTender={onApplyTender} detached />
                ))}
              </div>
            </section>
          )}
          </>}

          {tab === 'shipped' && (
            shippedShipments.length === 0
              ? <div className="rt-empty">Nothing shipped yet. Hit <b>🚚 Mark shipped</b> on a routed BOL when the truck leaves — it moves here (record kept, BOL never reused).</div>
              : shippedByPartner.map(([partner, list]) => (
                <section key={partner} className="rt-partner">
                  <h3>{partner} <span className="muted">· {list.length} shipped</span></h3>
                  <div className="rt-cards">
                    {list.map((s) => (
                      <ShipmentCard key={s.id} g={{ ...s, dcLabel: s.dc, poCount: (s.memberPos || []).length, shipment: s }}
                        auths={auths} busy={busy} onSaveRefs={onSaveRefs} onShip={onShip} detached />
                    ))}
                  </div>
                </section>
              ))
          )}
        </>
      )}
    </div>
  )
}

// Short-packed fulfilments, hoisted to the top of the view (Nima, 2026-08-02).
// The per-card badge is the detail; this is the thing you cannot scroll past.
// A shortage that reaches a BOL means the 856 announces units that aren't in the
// boxes, which is a chargeback — so it earns the same treatment as the gaps
// panel rather than living only beside the group it belongs to.
//
// 'not_started' and 'in_progress' groups never appear here. Mid-pack most of the
// board is unfinished, and warning about that would make this permanent
// furniture that gets ignored — the same reasoning as the strip hiding itself
// when clear.
function PackWarning({ groups = [] }) {
  const bad = groups.filter((g) => g.pack?.status === 'short' || g.pack?.status === 'over')
  if (!bad.length) return null
  const units = bad.reduce((n, g) => n + g.pack.shortUnits, 0)

  return (
    <div className="rt-gaps rt-packWarn">
      <div className="rt-gapsHead">
        ⚠ {bad.length} shipment{bad.length === 1 ? '' : 's'} {bad.length === 1 ? 'is' : 'are'} short {units} unit{units === 1 ? '' : 's'}
        <span className="muted"> — packed cartons don’t add up to what the fulfilment says it ships</span>
      </div>
      <div className="rt-gapGroup">
        <div className="rt-gapWhy">
          Routing one of these transmits an 856 claiming units that aren’t in the boxes.
          Go back to the fulfilment and finish it, then <b>⟳ Pull from NetSuite</b>.
        </div>
        {bad.map((g) => (
          <div key={g.dcPoKey} className="rt-packRow">
            <span className="rt-packRowDc">{g.dc}</span>
            <span className="muted">{g.memberPos.join(', ')}</span>
            {g.pack.problems.map((p) => (
              <span key={p.ifNumber} className="rt-gapChip miss">
                {p.ifNumber} · {p.packedUnits}/{p.ifUnits}
                {p.blankCartons
                  ? ` · ${p.cartons} carton${p.cartons === 1 ? '' : 's'} with no quantity entered`
                  : ` · ${p.short} short`}
              </span>
            ))}
          </div>
        ))}
      </div>
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
  return (
    <div className="rt-auths">
      <button className="rt-authsToggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Routing authorizations <span className="muted">({auths.length})</span>
      </button>
      {open && (
        <div className="rt-authsBody">
          <div className="muted rt-authsHint">
            One auth number covers a set of shipments (from the routing email). Set its carrier / SCAC
            once and hit <b>Apply to all shipments</b> to stamp them across every DC on the auth in one go.
            When an auth covers multiple final DCs, generate ONE Master BOL for the merge center (not sent on the 856).
          </div>
          <div className="rt-authList">
            {auths.map((a) => (
              <AuthChip key={a.authNumber} a={a} shipments={shipments} busy={busy} onSave={onSave} onDelete={onDelete} />
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

// One authorization chip: edit its carrier/SCAC inline, then bulk-stamp them
// (plus the auth #) onto every shipment the auth covers in a single click
// (Nima, 2026-07-27). "Applicable" = same-partner shipments not already tied to
// a DIFFERENT auth, so this never steals a DC from another authorization. The
// backend (assignAuthToShipments via saveRoutingAuth) upserts the carrier/SCAC
// on the auth first, then stamps them + advances status to Authorized.
function AuthChip({ a, shipments, busy, onSave, onDelete }) {
  const [carrier, setCarrier] = useState(a.carrier || '')
  const [scac, setScac] = useState(a.scac || '')
  const [shipDate, setShipDate] = useState(a.shipDate ? String(a.shipDate).slice(0, 10) : todayStr())
  const [pickup, setPickup] = useState(a.fedexPickupNumber || '')
  const [pallets, setPallets] = useState(a.palletCount ?? '')
  const assignable = shipments.filter(
    (s) => s.partner === a.partner && (!s.authNumber || s.authNumber === a.authNumber),
  )
  const n = shipments.filter((s) => s.authNumber === a.authNumber).length
  function apply() {
    onSave({
      authNumber: a.authNumber,
      partner: a.partner,
      carrier: carrier.trim(),
      scac: scac.trim(),
      shipDate: shipDate || null,
      fedexPickupNumber: pickup.trim(),
      palletCount: pallets === '' ? null : Number(pallets),
      shipmentIds: assignable.map((s) => s.id),
    })
  }
  return (
    <div className="rt-authChip">
      <div className="rt-authChipTop">
        <b>{a.authNumber}</b>
        <span className="muted"> · {a.partner || '—'}</span>
        <span className="muted"> · {n} shipment{n === 1 ? '' : 's'}</span>
        {n >= 2 && a.partner !== 'Nordstrom' && <MasterActions auth={a} />}
        <button className="rt-x" disabled={busy === 'authdel' + a.authNumber} onClick={() => onDelete(a.authNumber)} title="Delete auth">✕</button>
      </div>
      <div className="rt-authChipEdit">
        <input className="rt-authCarrier" placeholder="Carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
        <input className="rt-authScac" placeholder="SCAC" value={scac} onChange={(e) => setScac(e.target.value)} />
        <label className="rt-authDate" title="Master BOL ship date">📅<input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} /></label>
        <input className="rt-authPickup" placeholder="FedEx pickup #" value={pickup} onChange={(e) => setPickup(e.target.value)} />
        <label className="rt-authPallets" title={`Master BOL pallet count (manual) — adds ${PALLET_TARE_LB} lb per pallet to the freight weight`}>
          🟫<input type="number" min="0" step="1" placeholder="pallets" value={pallets} onChange={(e) => setPallets(e.target.value)} />
        </label>
        <button className="btn" disabled={busy === 'auth'} onClick={apply}
          title="Save carrier / SCAC / date / pickup # on the auth and stamp them onto all its shipments at once">
          {assignable.length
            ? `Apply to ${assignable.length} shipment${assignable.length === 1 ? '' : 's'}`
            : 'Save details'}
        </button>
      </div>
      <EmailLinks docType="AUTH" docNumber={a.authNumber} compact />
    </div>
  )
}


// One line per carton, for typing UPS/FedEx labels by hand (Nima, 2026-08-05).
//
// A DC-direct shipment goes to ONE address but its cartons belong to different
// STORES — the DC cross-docks them — so the PO + store pair is the only thing
// distinguishing otherwise identical labels, and it is what has to be printed.
//
// Collapsed by default: 22 rows would swamp a routing card, and this is only needed
// at the moment labels are being made.
function LabelWorksheet({ s }) {
  const [open, setOpen] = useState(false)
  const w = s.labels
  if (!w?.applicable || !w.cartons) return null
  return (
    <div className="rt-labels">
      <button className="rt-editToggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '⌖'} Labels to create ({w.cartons})
      </button>
      {open && (
        <div className="rt-labelSheet">
          <div className="rt-labelHead">
            {w.shipTo
              ? <span>{w.shipTo.name} · {w.shipTo.street}, {w.shipTo.city}, {w.shipTo.state} {w.shipTo.zip}</span>
              : <span className="rt-warn">No stored address for “{w.dc}” — confirm it before printing</span>}
            {w.carrier && <span className="rt-labelCarrier">{w.carrier}</span>}
          </div>
          {/* Billing is per-carrier on a Macy's routing: UPS Ground is THIRD PARTY
              BILL to Macy's own account, FedEx publishes none so it ships collect on
              ours. Shown here because it is typed on every single label. */}
          {(w.freightTerms || w.billToAccount) && (
            <div className="rt-labelHead">
              <span>{w.freightTerms || 'terms not recorded'}</span>
              {w.billToAccount && <span className="rt-mono">bill-to {w.billToAccount}</span>}
            </div>
          )}
          <table className="rt-labelTable">
            <thead>
              <tr><th>#</th><th>PO</th><th>Store</th><th>Weight</th><th>Dimensions</th><th>SSCC</th></tr>
            </thead>
            <tbody>
              {w.lines.map((l) => (
                <tr key={`${l.ifNumber}-${l.seq}`} className={l.weightLb == null || l.lengthIn == null ? 'rt-rowGap' : ''}>
                  <td>{l.seq}</td>
                  <td className="rt-mono">{l.poNumber}</td>
                  <td className="rt-mono rt-store">{l.storeNumber || '?'}</td>
                  {/* Real per-carton values. Two boxes of the same type genuinely
                      differ (44lb vs 47lb live), so nothing here is averaged. */}
                  <td className="rt-mono">{l.weightLb != null ? `${l.weightLb} lb` : <span className="rt-warn">—</span>}</td>
                  <td className="rt-mono">{l.dims || <span className="rt-warn">no dims</span>}</td>
                  <td className="rt-mono rt-sscc" title={l.ucc || ''}>{l.ucc ? l.ucc.slice(-8) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="rt-labelFoot">
            <span>{w.cartons} carton(s) · {w.totalWeightLb} lb total</span>
            {w.incomplete > 0 && <span className="rt-warn">{w.incomplete} missing weight or dimensions</span>}
            <a className="btnGhost" href={`/api/label-worksheet.csv?bol=${encodeURIComponent(w.bolNumber)}`}>⤓ CSV</a>
          </div>
        </div>
      )}
    </div>
  )
}

// What the partner's TMS ACCEPTED, next to what we asked for.
//
// We pick a ship date when we submit a routing request; Nordstrom's Manhattan Active
// TMS answers with the datetime the truck will actually come, and that answer used to
// live only in Nima's inbox. Shown as EVIDENCE, deliberately not applied: ship date,
// carrier and SRR are all hand-entered on this very card, and a sync that silently
// overwrote them would make the card stop being worth reading.
//
// Nothing renders on lanes with no tender (Bloomingdale's routes through its own
// portal), and nothing renders when the tender agrees — a row that always shows is a
// row nobody reads.
function TenderLine({ tender, busy, onApply }) {
  if (!tender) return null
  const date = tender.diffs.find((d) => d.kind === 'pickup_date')
  const carrier = tender.diffs.find((d) => d.kind === 'carrier')
  const srr = tender.diffs.find((d) => d.kind === 'srr')
  if (tender.agrees) {
    return (
      <div className="rt-tender agrees" title={`Tender ${tender.shipmentId} — ${tender.pickupRaw}`}>
        ✓ tender {tender.shipmentId} agrees · pickup {tender.pickupDate}
      </div>
    )
  }
  return (
    <div className="rt-tender" title={`Tender ${tender.shipmentId} accepted — ${tender.pickupRaw}`}>
      <div className="rt-tenderHead">Tender {tender.shipmentId} accepted</div>
      {date && (
        <div>
          pickup <b>{date.theirs}</b> — this card says {date.ours || 'no date'}
        </div>
      )}
      {carrier && <div>carrier <b>{carrier.theirs}</b>{carrier.ours ? ` — card says ${carrier.ours}` : ' — not set on this card'}</div>}
      {srr && <div>SRR <b>{srr.theirs}</b>{srr.ours ? ` — card says ${srr.ours}` : ' — not set on this card'}</div>}
      {tender.cartonsAgree === true && <div className="muted">{tender.cartons} cartons reconciled</div>}
      {onApply && (
        <button className="rt-tenderApply" disabled={busy === 'tender' + tender.shipmentId}
          title="Write the accepted pickup date and carrier onto every BOL this tender covers"
          onClick={() => onApply(tender)}>
          {busy === 'tender' + tender.shipmentId ? 'Applying…' : 'Accept tender →'}
        </button>
      )}
    </div>
  )
}

function ShipmentCard({ g, auths, busy, onAssign, onVoid, onSaveRefs, onHold, onShip, onSetRouted, onApplyTender, detached, groupable, groupChecked, onToggleGroup }) {
  const s = g.shipment
  const [editing, setEditing] = useState(false)
  const st = s ? (STATUS[s.status] || STATUS.needs_routing) : null
  const canHold = onHold && !detached && !s?.shippedAt

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

      <PackCheck pack={g.pack} />

      <TenderLine tender={s?.tender} busy={busy} onApply={onApplyTender} />

      {g.cubicRoundingDiffers && (
        <div className="rt-warn" title="The feed's summed per-row rounded cubic feet differs from a single round-up of the raw total.">
          ⚠ cubic ft: {g.cubicFeet} (round-up of {g.rawCubicFeet}); feed's per-row sum = {g.cubicFeetRoundedSum}
        </div>
      )}

      {!s ? (
        <button className="btn rt-assign" disabled={busy === g.dcPoKey} onClick={onAssign}
                title={g.pack?.status === 'short' ? 'This group is short — assigning a BOL now would ship an 856 claiming units that aren’t in the boxes.' : undefined}>
          {busy === g.dcPoKey ? 'Assigning…' : g.pack?.status === 'short' ? 'Assign BOL anyway' : 'Assign BOL'}
        </button>
      ) : (
        <>
          <div className="rt-bol assigned">
            {groupable && onToggleGroup && (
              <label className="rt-groupCheck" title="Select this BOL to group into a Master BOL">
                <input type="checkbox" checked={groupChecked} onChange={onToggleGroup} />
              </label>
            )}
            <span className="rt-bolLabel">BOL</span>
            <span className="rt-bolNum">{s.bolNumber}</span>
            {s.shippedAt
              ? <span className="rt-shippedTag" title={`Shipped ${new Date(s.shippedAt).toLocaleString()}`}>✓ shipped {new Date(s.shippedAt).toLocaleDateString()}</span>
              : !detached && <button className="btnGhost" disabled={busy === 'void' + s.id} onClick={() => onVoid(s)}>Void</button>}
            {/* The ASN went out but NetSuite still doesn't call the freight shipped
                — surfaced, never used to auto-archive. Names the lagging POs so
                it points at a specific fix rather than a lumped count. */}
            {s.asnAheadOfNetsuite && !s.shippedAt && (
              <span className="rt-asnAhead"
                title={`856 transmitted, but NetSuite hasn't marked every IF shipped for PO ${(s.netsuite?.pending || []).join(', ')} — go mark them shipped.`}>
                856 sent · NetSuite behind ({(s.netsuite?.pending || []).join(', ')})
              </span>
            )}
          </div>
          {/* Mark routed by hand (Nima, 2026-08-02). Bloomingdale's reaches
              'routed' through the portal — project/shipment numbers, then an
              auth from the routing email. NORDSTROM HAS NONE OF THAT: it's
              always CTE/CAIE with no auth email, so there was literally nothing
              to enter and its BOLs sat on "Needs routing" forever. A plain
              checkmark is the whole mechanism it needs. Left on every partner —
              a Bloomingdale's shipment routed by phone deserves it too. */}
          {onSetRouted && !s.shippedAt && (
            <button className={'btnGhost rt-routedBtn' + (s.status === 'routed' ? ' on' : '')}
              disabled={busy === 'routed' + s.id}
              title={s.status === 'routed'
                ? 'Put this back in the routing queue'
                : 'Routing is done for this BOL — no number to record'}
              onClick={() => onSetRouted(s, s.status !== 'routed')}>
              {s.status === 'routed' ? '✓ Routed' : '○ Mark routed'}
            </button>
          )}
          {onShip && (
            <button className={'btnGhost rt-shipBtn' + (s.shippedAt ? ' on' : '') + (s.closeReady?.ok ? ' ready' : '')}
              disabled={busy === 'ship' + s.id}
              title={s.shippedAt
                ? 'Move back to the active queue'
                : s.closeReady
                  ? `${s.closeReady.ok ? 'Ready: ' : 'Not confirmed yet — '}${s.closeReady.why}`
                  : 'Shipment has physically left — archive it to the Shipped tab (record kept)'}
              onClick={() => onShip(s)}>
              {s.shippedAt ? '↩ Un-ship' : '🚚 Mark shipped'}
            </button>
          )}
          {/* Evidence, not an action — the button above is still the only way
              a BOL closes. See src/model/closeReady.js. */}
          {s.closeReady?.ok && (
            <span className="rt-closeReady" title={s.closeReady.why}>✓ confirmed by the partner</span>
          )}

          <BolActions s={s} />
          <RefSummary s={s} />
          <LabelWorksheet s={s} />
          <EdiTrail s={s} />
          <Parcels s={s} />
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

// Sticky action bar for grouping checkbox-selected BOLs into one dated Master
// BOL (Nima, 2026-07-27). Records the group under an authorization (the master's
// key) + stamps the ship date; the shared auth of the selection pre-fills.
function GroupBar({ groups, groupSel, auths, busy, onGroup, onClear }) {
  const [authNumber, setAuthNumber] = useState('')
  const [shipDate, setShipDate] = useState(todayStr())
  // Carrier/SCAC here too (Nima, 2026-08-02) — they arrive in the same routing
  // email as the auth #, so typing them on the auth chip afterwards was a second
  // trip for one piece of information.
  const [carrier, setCarrier] = useState('')
  const [scac, setScac] = useState('')
  // SCAC is the field that gets typo'd, and a wrong one is a chargeback. Picking
  // a known carrier fills it from the same CARRIERS table the BOL prints from,
  // so the two can't disagree. Still free text: the map isn't every carrier, and
  // an unknown name must not be blocked.
  function pickCarrier(v) {
    setCarrier(v)
    if (CARRIERS[v]) setScac(CARRIERS[v])
  }
  if (!groupSel.size) return null
  const selShips = groups.map((g) => g.shipment).filter((s) => s && groupSel.has(s.id))
  const dcs = selShips.map((s) => s.dc)
  const authSet = new Set(selShips.map((s) => s.authNumber || ''))
  const sharedAuth = authSet.size === 1 ? [...authSet][0] : ''
  const auth = (authNumber || sharedAuth).trim()
  // What the selection already carries, so the placeholders show what grouping
  // would leave untouched rather than reading as empty fields you forgot.
  const existing = auths.find((a) => a.authNumber === auth) || {}
  const canGroup = selShips.length >= 1 && auth
  const scacKnown = carrier && CARRIERS[carrier]
  return (
    <div className="rt-groupBar">
      <span className="rt-groupCount">{selShips.length} BOL{selShips.length === 1 ? '' : 's'} selected</span>
      <span className="muted rt-groupDcs">{dcs.join(' · ')}</span>
      <input list="rt-group-auth-list" className="rt-groupAuth"
        placeholder={sharedAuth ? `auth ${sharedAuth}` : 'auth # (from routing email)'}
        value={authNumber} onChange={(e) => setAuthNumber(e.target.value)} />
      <datalist id="rt-group-auth-list">{auths.map((a) => <option key={a.authNumber} value={a.authNumber} />)}</datalist>
      <input list="rt-group-carrier-list" className="rt-authCarrier"
        placeholder={existing.carrier || 'Carrier'}
        value={carrier} onChange={(e) => pickCarrier(e.target.value)} />
      <datalist id="rt-group-carrier-list">{Object.keys(CARRIERS).map((c) => <option key={c} value={c} />)}</datalist>
      <input className="rt-authScac" placeholder={existing.scac || 'SCAC'}
        title={scacKnown ? `SCAC for ${carrier} — edit if this shipment differs` : 'Carrier SCAC'}
        value={scac} onChange={(e) => setScac(e.target.value.toUpperCase())} />
      <label className="rt-groupDate" title="Master BOL ship date">📅<input type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} /></label>
      <button className="btn" disabled={!canGroup || busy === 'group'}
        onClick={() => onGroup({ authNumber: auth, shipDate, carrier: carrier.trim(), scac: scac.trim() })}>
        {busy === 'group' ? 'Grouping…' : 'Group into Master BOL'}
      </button>
      <button className="btnGhost" onClick={onClear}>clear</button>
      {!auth && <span className="muted rt-groupHint">enter the auth # to group these under</span>}
      {auth && !carrier && !existing.carrier &&
        <span className="muted rt-groupHint">no carrier yet — the BOL prints a blank CARRIER NAME / SCAC</span>}
    </div>
  )
}

// Master BOL for an authorization covering multiple final DCs (merge-center
// consolidation). Opens the aggregated Master BOL PDF; files it to Drive.
// A Drive upload that gave up says why. Rate limits get their own wording
// because the fix is "try again shortly", not "go fix your credentials" — and
// Drive reports throttling as a 403, which used to be read as a scope problem.
function driveFailure(r) {
  if (r.reason && /rate|quota/i.test(r.reason)) {
    return `Drive throttled this${r.where ? ` on ${r.where}` : ''} even after retries — try again in a moment.`
  }
  return `Not filed — ${r.where || 'upload'} failed${r.reason ? ` (${r.reason})` : ''}.`
}

function MasterActions({ auth }) {
  const [state, setState] = useState(null)
  async function file() {
    setState({ busy: true })
    try {
      const r = await fileMasterToDrive(auth.authNumber)
      // ⚠️ Check ok FIRST. A Drive failure now returns { ok:false, reason } instead
      // of throwing, so an `else` fallthrough would report "filed" for an upload
      // that never happened — the one outcome worse than a visible error.
      if (r.needsReauth) setState({ msg: 'Drive not authorized yet', ok: false })
      else if (r.configured === false) setState({ msg: 'Google not connected', ok: false })
      else if (!r.ok) setState({ msg: driveFailure(r), ok: false })
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
      else if (!r.ok) setState({ msg: driveFailure(r), ok: false })
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

// The parcels we pushed to ShipStation for this BOL, and what came back
// (Nima, 2026-08-05: "we now have tracking we can add to the routing cards").
//
// ⚠️ Reported as COUNTS, never as a state. A tracking number means a label was
// bought — not that the carton left. On this lane the label and the "mark
// shipped" that triggers the ASN both happen deliberately ahead of the pickup,
// so "3 of 4 labelled" is the only honest sentence here.
function Parcels({ s }) {
  const [open, setOpen] = useState(false)
  const p = s.parcels
  if (!p) return null
  const waiting = p.pushed - p.labelled - p.voided
  return (
    <div className="rt-ediTrail">
      <button className="rt-ediToggle" onClick={() => setOpen((o) => !o)}
        title="Parcel orders pushed to ShipStation for this BOL. A label is bought by hand in ShipStation.">
        {open ? '▾' : '▸'} Parcels
        <span className="rt-ediChip">{p.labelled} of {p.pushed} labelled</span>
        {waiting > 0 && <span className="rt-ediChip pending">{waiting} awaiting a label</span>}
        {p.voided > 0 && <span className="rt-ediChip bad">{p.voided} voided</span>}
      </button>
      {open && (
        <div className="rt-ediBody">
          {p.items.map((it) => (
            <div key={it.orderKey} className={'rt-ediRow' + (it.voided ? ' bad' : '')}>
              <span className="rt-ediNum">{it.orderNumber}</span>
              <span className="muted">{it.ifNumber}{it.cartonNo ? ` · carton ${it.cartonNo}` : ''}</span>
              {it.trackingNumber
                ? <a className="rt-ediNum" href={`https://www.ups.com/track?tracknum=${it.trackingNumber}`}
                     target="_blank" rel="noreferrer">{it.trackingNumber}</a>
                : <span className="muted">no label yet</span>}
              {it.voided && <span className="muted">voided</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The EDI paper trail for a BOL: the 850(s) that ordered it and the 856 that
// announced it, with Orderful transaction ids so you can go straight back to the
// document. Kept as a disclosure rather than always-open — it's reference
// material, not work, and the routing board's job is to show what needs doing.
function EdiTrail({ s }) {
  const [open, setOpen] = useState(false)
  const edi = s.edi
  if (!edi?.asn) {
    // Archived with no ASN found is worth saying out loud — an EDI partner
    // shipment with no 856 means the ship notice never went out.
    if (!s.shippedAt) return null
    return <div className="rt-ediTrail none" title="No outbound 856 was found for this BOL number.">⚠ no 856 on file for this BOL</div>
  }
  const linked = (edi.po850 || []).filter((p) => p.transactionId)
  const ok = edi.asn.ackStatus === 'ACCEPTED'
  const rejected = edi.asn.ackStatus === 'REJECTED'
  return (
    <div className="rt-ediTrail">
      <button className="rt-ediToggle" onClick={() => setOpen((o) => !o)}
        title="The 850 → BOL → 856 reference for this shipment">
        {open ? '▾' : '▸'} EDI trail
        <span className="rt-ediChip">{linked.length} × 850</span>
        <span className={'rt-ediChip asn' + (rejected ? ' bad' : ok ? ' ok' : ' pending')}>
          856 {rejected ? 'rejected' : ok ? 'accepted' : 'pending'}
        </span>
      </button>
      {open && (
        <div className="rt-ediBody">
          <div className="rt-ediRow">
            <span className="rt-ediKind out">856</span>
            <span className="rt-ediNum">{edi.asn.businessNumber}</span>
            <span className="muted">tx {edi.asn.transactionId}</span>
            {edi.asn.createdAt && <span className="muted">sent {String(edi.asn.createdAt).slice(0, 10)}</span>}
            <span className="muted">{edi.asn.deliveryStatus}/{edi.asn.ackStatus}</span>
          </div>
          {(edi.po850 || []).map((p) => (
            <div className="rt-ediRow" key={p.po}>
              <span className="rt-ediKind in">850</span>
              <span className="rt-ediNum">PO {p.po}</span>
              {p.transactionId
                ? <>
                    <span className="muted">tx {p.transactionId}</span>
                    {p.createdAt && <span className="muted">rec'd {String(p.createdAt).slice(0, 10)}</span>}
                    {p.totalUnits != null && <span className="muted">{p.totalUnits} units</span>}
                  </>
                : <span className="rt-ediMissing">no 850 on file</span>}
            </div>
          ))}
          {edi.snapshotAt && (
            <div className="rt-ediSnap muted">
              archived reference frozen {new Date(edi.snapshotAt).toLocaleDateString()}
              {edi.fromSnapshot && ' · transaction has aged out of Orderful'}
            </div>
          )}
        </div>
      )}
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
    // Default to today so the date picker opens on the current date ready to
    // pick (Nima, 2026-07-27) — they can still calendar-pick any other day.
    shipDate: s.shipDate ? String(s.shipDate).slice(0, 10) : todayStr(),
    mergeCenter: s.mergeCenter || 'CA',
    trailerNumber: s.trailerNumber || '',
    sealNumber: s.sealNumber || '',
    fedexPickupNumber: s.fedexPickupNumber || '',
    // Straight-to-DC routing (Nima, 2026-08-05).
    shipDirect: !!s.shipDirect,
    consignedTo: s.consignedTo || '',
    trackingNumbers: (s.trackingNumbers || []).join(', '),
    routingRequestNumber: s.routingRequestNumber || '',
    routingRequestLine: s.routingRequestLine || '',
  })
  const isBloomies = s.partner === "Bloomingdale's"
  const isNordstrom = s.partner === 'Nordstrom'
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
      {/* Bloomingdale's is no longer always consigned via a Merge Center (Nima,
          2026-08-05): the Aug-4 notifications sent 6 of 6 POs DIRECT to the DC.
          The toggle picks the DESTINATION, and it is deliberately independent of
          the carrier — freight can go direct to a DC too, so "direct" must not
          come to mean "parcel". */}
      {isBloomies && (
        <>
          <label>Ship-to
            <select value={d.shipDirect ? 'dc' : 'merge'}
              onChange={(e) => setD({ ...d, shipDirect: e.target.value === 'dc' })}>
              <option value="merge">Via 1:1 Merge Center</option>
              <option value="dc">Direct to the DC{s.dc ? ` · ${s.dc}` : ''}</option>
            </select>
          </label>
          {!d.shipDirect && (
            <label>Merge center
              <select value={d.mergeCenter} onChange={set('mergeCenter')}>
                <option value="CA">Mega-Merge CA · Santa Fe Springs</option>
                <option value="NJ">Mega-Merge NJ · Burlington</option>
                <option value="HP">High Point Merge · Dynamic</option>
              </select>
            </label>
          )}
          {d.shipDirect && (
            <p className="hint" style={{ margin: '2px 0 0' }}>
              {shipToLine(s.dc) || `No stored address for “${s.dc}” — the BOL will ask you to confirm it.`}
            </p>
          )}
        </>
      )}
      {/* Nordstrom routes through its own Manhattan portal rather than a routing
          email, and the request number is the reference to keep (Nima, 2026-08-05).
          The supplier PO there reads "<our PO>-<DC>" (50073677-89), so unlike the
          Macy's emails it joins to a shipment exactly. */}
      {isNordstrom && (
        <div className="rt-editRow">
          <label>Routing request #
            <input value={d.routingRequestNumber} onChange={set('routingRequestNumber')}
              placeholder="5189002RR000000061" />
          </label>
          <label>Request line
            <input value={d.routingRequestLine} onChange={set('routingRequestLine')}
              placeholder="RRL7854657822930187974" />
          </label>
        </div>
      )}
      <div className="rt-editRow">
        <label>Trailer #<input value={d.trailerNumber} onChange={set('trailerNumber')} /></label>
        <label>Seal #<input value={d.sealNumber} onChange={set('sealNumber')} /></label>
      </div>
      <label>FedEx pickup #<input value={d.fedexPickupNumber} onChange={set('fedexPickupNumber')} placeholder="pickup confirmation #" /></label>
      {/* One number per carton is normal on a DC-direct parcel shipment, so this
          takes a list; commas, spaces or a pasted column all split correctly. */}
      <label>Tracking #s
        <input value={d.trackingNumbers} onChange={set('trackingNumbers')}
          placeholder="1Z… , 1Z…  (one per carton — paste is fine)" />
      </label>
      {/* The consignee block verbatim off the routing notification, so "where did
          we actually send it" survives any later change to our address table. */}
      <label>Consigned to (from the routing email)
        <input value={d.consignedTo} onChange={set('consignedTo')}
          placeholder="MINOOKA DC 601 MIDPOINT ROAD MINOOKA , IL 60447" />
      </label>
      <label>Ship date<input type="date" value={d.shipDate} onChange={set('shipDate')} /></label>
      <button className="btn" disabled={busy} onClick={() => onSave(d)}>{busy ? 'Saving…' : 'Save route info'}</button>
    </div>
  )
}

// Did every unit on every fulfilment in this group actually get packed?
// (Nima, 2026-08-02.) Packing is manual and a missed item is otherwise
// invisible until it comes back as a chargeback, so a clean group states its
// numbers too — silence would be indistinguishable from "not checked".
function PackCheck({ pack }) {
  if (!pack || pack.status === 'empty') return null
  const cls = pack.status === 'short' || pack.status === 'over' ? 'bad'
    : pack.status === 'ok' ? 'good' : 'idle'
  return (
    <div className={'rt-pack ' + cls}>
      <span className="rt-packMark">{cls === 'good' ? '✓' : cls === 'bad' ? '⚠' : '·'}</span>
      <span className="rt-packText">{packSummary(pack)}</span>
      {pack.problems.map((p) => (
        <span key={p.ifNumber} className="rt-packIf"
              title={p.blankCartons
                ? `${p.ifNumber}: ${p.cartons} carton(s) exist but no quantities were entered on them`
                : `${p.ifNumber}: ${p.packedUnits} of ${p.ifUnits} units packed across ${p.cartons} carton(s)`}>
          {p.ifNumber} {p.packedUnits}/{p.ifUnits}
          {p.blankCartons && <em> (cartons have no qty)</em>}
        </span>
      ))}
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
