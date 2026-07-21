import { Fragment, useEffect, useState } from 'react'
import {
  fetchEdiReview, syncEdi, linkEdiTransaction, unlinkEdiTransaction,
  addEdiManualOrder, removeEdiManualOrder, resolveEdiPo, unresolveEdiPo,
  ackEdiTransaction, unackEdiTransaction, fetchSeasons, saveSeason, createEdiTask,
  setEdiSupply, clearEdiSupply,
} from '../api.js'
import { computeEdiWork } from '../../../src/model/ediWork.js'
import { NoteWidget, SeasonBadge, DocLinks } from '../lib.jsx'

const ISSUE_STATUSES = new Set(['INVALID', 'FAILED', 'REJECTED', 'OVERDUE'])
const isIssueValue = (v) => ISSUE_STATUSES.has(v)
const fmtD = (d) => (d ? new Date(d).toLocaleDateString() : '—')

const DAY_MS = 86400000
const sod = (x) => { const d = new Date(x); d.setHours(0, 0, 0, 0); return d.getTime() }

// Ship-window calendar (Nima, 2026-07-20): the EDI view's own month grid —
// every open PO plotted on its cancel-after (red = the drop-dead day) and
// ship-not-before (cyan = window opens). Click a day for exactly what's due.
function EdiCalendar({ openPos }) {
  const today = sod(Date.now())
  const [cursor, setCursor] = useState(today)
  const [sel, setSel] = useState(null)

  const byDay = new Map()
  const push = (day, item) => { if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(item) }
  for (const o of openPos) {
    if (o.cancelAfter) push(sod(o.cancelAfter), { kind: 'cancel', o })
    if (o.shipNotBefore) push(sod(o.shipNotBefore), { kind: 'window', o })
  }

  const first = new Date(new Date(cursor).getFullYear(), new Date(cursor).getMonth(), 1).getTime()
  const gridStart = first - new Date(first).getDay() * DAY_MS
  const days = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY_MS)
  const curMonth = new Date(cursor).getMonth()
  const selItems = sel != null ? byDay.get(sel) || [] : []

  return (
    <div className="ediCal">
      <div className="calNav">
        <button className="calNavBtn" onClick={() => setCursor(new Date(new Date(cursor).getFullYear(), new Date(cursor).getMonth() - 1, 1).getTime())}>‹</button>
        <h3 className="calTitle">{new Date(cursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button className="calNavBtn" onClick={() => setCursor(new Date(new Date(cursor).getFullYear(), new Date(cursor).getMonth() + 1, 1).getTime())}>›</button>
        <span className="hint">■ <i style={{ color: 'var(--hi)', fontStyle: 'normal' }}>cancel-by</i> · ■ <i style={{ color: 'var(--holo)', fontStyle: 'normal' }}>window opens</i></span>
      </div>
      <div className="calGrid ediCalGrid">
        {['S', 'M', 'T', 'W', 'T2', 'F', 'S2'].map((w) => <div key={w} className="calWeekday">{w[0]}</div>)}
        {days.map((day) => {
          const items = byDay.get(day) || []
          const cancels = items.filter((i) => i.kind === 'cancel').length
          const windows = items.filter((i) => i.kind === 'window').length
          const inMonth = new Date(day).getMonth() === curMonth
          const overdue = day < today && cancels > 0
          return (
            <button key={day}
                    className={'calCell calCellBtn ediCell' + (inMonth ? '' : ' calCell-dim') +
                      (day === today ? ' calCell-today' : '') + (sel === day ? ' calCell-sel' : '') + (overdue ? ' ediCellOverdue' : '')}
                    onClick={() => setSel(sel === day ? null : day)}>
              <div className="calDayNum">{new Date(day).getDate()}</div>
              <div className="calDots">
                {cancels > 0 && <span className="ediDue bad">{cancels}</span>}
                {windows > 0 && <span className="ediDue win">{windows}</span>}
              </div>
            </button>
          )
        })}
      </div>
      {sel != null && (
        <div className="ediCalDay">
          <div className="taskGroupHead">{new Date(sel).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} <span className="sectorCount">{selItems.length}</span></div>
          {selItems.map((it, i) => (
            <div key={i} className="calRow">
              <span className={'caltag ' + (it.kind === 'cancel' ? 'sev-hi' : 'sev-lo')}>{it.kind === 'cancel' ? 'Cancel by' : 'Window opens'}</span>
              <span className="so">{it.o.businessNumber}</span>
              <span className="cust">{it.o.tradingPartner}</span>
              <span className="calNote">{it.o.work.needed}</span>
            </div>
          ))}
          {!selItems.length && <div className="empty">Nothing due this day.</div>}
        </div>
      )}
    </div>
  )
}

// EDI command board (rebuilt 2026-07-18 — "EDI is too basic to function as
// is"). The questions this view answers, in order:
//   1. Which POs are OPEN, per partner, and what does each need next?
//   2. Did we MISS an 850? (arrived, never entered in NetSuite — the failure
//      that already happened once)
//   3. Are any cancel dates passing while a PO sits unshipped?
// Layout: partner rail LEFT (open counts + closed ratio), the selected
// partner's OPEN work queue RIGHT, closed POs in their own drawer below.
// Manual resolution — connect a PO to its NetSuite ref, or close it out —
// lives on every card; always flagged as manual (src/model/ediWork.js).
export default function EdiOrders({ onNavigate } = {}) {
  const [review, setReview] = useState(null)
  const [err, setErr] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)
  const [selectedPartner, setSelectedPartner] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const [linkDrafts, setLinkDrafts] = useState({})
  const [linkBusy, setLinkBusy] = useState(null)
  const [manualDraft, setManualDraft] = useState(null)
  const [manualBusy, setManualBusy] = useState(false)
  const [resolveDrafts, setResolveDrafts] = useState({}) // bn -> {netsuiteRef, note, open}
  const [resolveBusy, setResolveBusy] = useState(null)
  const [ediTab, setEdiTab] = useState('open') // open | orphans | cancelled | closed — per-partner tabs under the calendar
  const [ackDrafts, setAckDrafts] = useState({}) // txnId -> linkedTransactionId
  const [ackBusy, setAckBusy] = useState(null)
  const [seasons, setSeasons] = useState({})
  const [taskBusy, setTaskBusy] = useState(null)
  const [supplyDrafts, setSupplyDrafts] = useState({}) // bn -> {poNumber, note}
  const [supplyBusy, setSupplyBusy] = useState(null)

  function load() {
    fetchEdiReview().then(setReview).catch((e) => setErr(e.message))
    fetchSeasons().then((rows) => setSeasons(Object.fromEntries(rows.map((s) => [`${s.docType}|${s.docNumber}`, s.season])))).catch(() => {})
  }
  useEffect(load, [])

  async function onSaveSeason(businessNumber, season) {
    // 'EDI_PO' — the customer's own PO number on the sales side, a different
    // numbering domain from purchase_orders.po_number (inbound vendor supply,
    // tagged 'PO' in Allocations.jsx) — see db/schema.sql doc_seasons.
    const rows = await saveSeason({ docType: 'EDI_PO', docNumber: businessNumber, season })
    setSeasons(Object.fromEntries(rows.map((s) => [`${s.docType}|${s.docNumber}`, s.season])))
  }

  async function onSync() {
    setSyncing(true); setSyncMsg(null); setErr(null)
    try {
      const r = await syncEdi()
      setSyncMsg(`Synced ${r.upserted} transaction(s) from Orderful.`)
      load()
    } catch (e) { setErr(e.message) } finally { setSyncing(false) }
  }

  const toggle = (bn) => setExpanded((s) => { const n = new Set(s); n.has(bn) ? n.delete(bn) : n.add(bn); return n })
  const setDraft = (txnId, patch) => setLinkDrafts((s) => ({ ...s, [txnId]: { ...s[txnId], ...patch } }))
  const setRDraft = (bn, patch) => setResolveDrafts((s) => ({ ...s, [bn]: { ...s[bn], ...patch } }))

  async function submitLink(txnId) {
    const draft = linkDrafts[txnId]
    if (!draft?.businessNumber) return setErr('Enter the PO/business number to link this to')
    setLinkBusy(txnId); setErr(null)
    try {
      setReview(await linkEdiTransaction({ transactionId: txnId, businessNumber: draft.businessNumber, note: draft.note }))
      setLinkDrafts((s) => { const n = { ...s }; delete n[txnId]; return n })
    } catch (e) { setErr(e.message) } finally { setLinkBusy(null) }
  }

  async function undoLink(txnId) {
    if (!window.confirm('Remove this manual link? The document will go back to being unlinked.')) return
    setLinkBusy(txnId)
    try { setReview(await unlinkEdiTransaction(txnId)) } catch (e) { setErr(e.message) } finally { setLinkBusy(null) }
  }

  // Per-document acknowledgment (Nima, 2026-07-20): a Bloomingdale's 856 that
  // Orderful flagged INVALID but was actually resent and accepted — link it to
  // that valid replacement, or (if there really is nothing to link) confirm
  // that. Either way it stops blocking the PO from reading as clean.
  async function submitAck(txnId, linkedTransactionId, note) {
    setAckBusy(txnId); setErr(null)
    try {
      setReview(await ackEdiTransaction({ transactionId: txnId, linkedTransactionId, note }))
      setAckDrafts((s) => { const n = { ...s }; delete n[txnId]; return n })
    } catch (e) { setErr(e.message) } finally { setAckBusy(null) }
  }

  async function undoAck(txnId) {
    setAckBusy(txnId)
    try { setReview(await unackEdiTransaction(txnId)) } catch (e) { setErr(e.message) } finally { setAckBusy(null) }
  }

  // Make this PO into a task (Nima, 2026-07-20). Idempotent — POs that already
  // exist as a NetSuite SO auto-generate a task, so this is mainly for the
  // no-SO cases (missed 850s / needs entering).
  async function makeTask(bn) {
    setTaskBusy(bn); setErr(null)
    try { setReview(await createEdiTask(bn)) } catch (e) { setErr(e.message) } finally { setTaskBusy(null) }
  }

  const setSDraft = (bn, patch) => setSupplyDrafts((s) => ({ ...s, [bn]: { ...s[bn], ...patch } }))
  // Inbound production PO the EDI order's goods come from, or from-stock.
  async function saveSupply(bn, { fromStock } = {}) {
    const d = supplyDrafts[bn] || {}
    const existing = review.ediSupply?.[bn]
    setSupplyBusy(bn); setErr(null)
    try {
      setReview(await setEdiSupply({
        businessNumber: bn,
        poNumber: fromStock ? '' : (d.poNumber ?? existing?.poNumber ?? ''),
        fromStock: fromStock ?? existing?.fromStock ?? false,
        note: d.note ?? existing?.note ?? '',
      }))
      setSupplyDrafts((s) => { const n = { ...s }; delete n[bn]; return n })
    } catch (e) { setErr(e.message) } finally { setSupplyBusy(null) }
  }
  async function removeSupply(bn) {
    setSupplyBusy(bn)
    try { setReview(await clearEdiSupply(bn)) } catch (e) { setErr(e.message) } finally { setSupplyBusy(null) }
  }

  // Manual resolution: save a NetSuite connection (stays open), close the PO,
  // or mark it CANCELLED (buyer killed it — no further documents ever coming).
  async function submitResolution(o, kind) {
    const d = resolveDrafts[o.businessNumber] || {}
    const existing = o.work.resolution
    setResolveBusy(o.businessNumber); setErr(null)
    try {
      setReview(await resolveEdiPo({
        businessNumber: o.businessNumber,
        closed: kind === 'close',
        cancelled: kind === 'cancel',
        netsuiteRef: d.netsuiteRef ?? existing?.netsuiteRef ?? '',
        note: d.note ?? existing?.note ?? '',
      }))
      setResolveDrafts((s) => { const n = { ...s }; delete n[o.businessNumber]; return n })
    } catch (e) { setErr(e.message) } finally { setResolveBusy(null) }
  }

  async function removeResolution(bn) {
    if (!window.confirm('Remove this manual resolution? The PO goes back to automatic tracking.')) return
    setResolveBusy(bn)
    try { setReview(await unresolveEdiPo(bn)) } catch (e) { setErr(e.message) } finally { setResolveBusy(null) }
  }

  async function onAddManual(e) {
    e.preventDefault()
    if (!manualDraft?.businessNumber?.trim()) return
    setManualBusy(true); setErr(null)
    try { setReview(await addEdiManualOrder(manualDraft)); setManualDraft(null) }
    catch (e2) { setErr(e2.message) } finally { setManualBusy(false) }
  }

  async function onRemoveManual(id) {
    if (!window.confirm('Remove this manually-entered EDI order?')) return
    try { setReview(await removeEdiManualOrder(id)) } catch (e2) { setErr(e2.message) }
  }

  if (err && !review) return <div className="banner error">⚠ Couldn’t load EDI review: {err}</div>
  if (!review) return <div className="banner">Loading EDI review…</div>

  const { manualOrders = [] } = review
  const work = computeEdiWork(review.orders || [], review.resolutions || [])
  const { partners, totals } = work
  const ratio = totals.open + totals.closed ? Math.round((totals.closed / (totals.open + totals.closed)) * 100) : 0

  const scope = selectedPartner
    ? work.orders.filter((o) => (o.tradingPartner || '(unknown partner)') === selectedPartner)
    : work.orders
  const urgency = (o) =>
    o.work.cancelState === 'passed' ? 0 : o.work.missed850 ? 1 : o.work.cancelState === 'soon' ? 2 : o.hasIssue ? 3 : 4
  const allOpen = scope.filter((o) => !o.work.closed).sort((a, b) => urgency(a) - urgency(b) || (b.work.age850 || 0) - (a.work.age850 || 0))
  // Orphans get their OWN section (Nima, 2026-07-20): every 856/810 with no
  // 850 anywhere is un-tracked work — impossible to miss up top, linkable
  // right there (works for 856s and 810s alike).
  const orphans = allOpen.filter((o) => o.bucket === 'NO_850_FOUND')
  const openPos = allOpen.filter((o) => o.bucket !== 'NO_850_FOUND')
  const cancelledPos = scope.filter((o) => o.work.closedBy === 'cancelled')
  const closedPos = scope.filter((o) => o.work.closed && o.work.closedBy !== 'cancelled')

  return (
    <div className="ediBoard">
      {err && <div className="banner error">⚠ {err}</div>}
      {syncMsg && <div className="banner ok">{syncMsg}</div>}

      {/* ── mission stats: the open:closed pulse ── */}
      <div className="ediStats">
        <span className="opStat bad"><b>{totals.open}</b> open POs</span>
        <span className="opStat ok"><b>{totals.closed}</b> closed</span>
        <span className="opStat"><b>{ratio}%</b> completion</span>
        {totals.missed > 0 && <span className="opStat bad"><b>{totals.missed}</b> possibly missed 850s</span>}
        {totals.cancelDanger > 0 && <span className="opStat bad"><b>{totals.cancelDanger}</b> cancel-date danger</span>}
        <button className="btnGhost" disabled={syncing} onClick={onSync} style={{ marginLeft: 'auto' }}>
          {syncing ? 'Syncing…' : '↻ Sync from Orderful'}
        </button>
      </div>

      <div className="ediSplit">
        {/* ── partner rail ── */}
        <aside className="partnerRail">
          <div
            className={'partnerTile' + (!selectedPartner ? ' active' : '')}
            onClick={() => setSelectedPartner(null)}
          >
            <div className="ptName">ALL PARTNERS</div>
            <div className="ptCounts"><b>{totals.open}</b> open · {totals.closed} closed</div>
          </div>
          {partners.map((p) => {
            // relationship health (Nima, 2026-07-20: "make sure we are all
            // green on our EDI partners"): red = missed 850s or cancel-date
            // danger (real exposure); amber = EDI errors; green = clean.
            const health = p.missed > 0 || p.cancelDanger > 0 ? 'red' : p.issues > 0 ? 'amber' : 'green'
            return (
            <div
              key={p.tradingPartner}
              className={'partnerTile targeting pt-' + health + (selectedPartner === p.tradingPartner ? ' active' : '')}
              onClick={() => setSelectedPartner(selectedPartner === p.tradingPartner ? null : p.tradingPartner)}
            >
              <span className={'ptHealth h-' + health}>{health === 'red' ? '⬤ CRITICAL' : health === 'amber' ? '⬤ WATCH' : '⬤ NOMINAL'}</span>
              <div className="ptName">{p.tradingPartner}</div>
              <div className="ptCounts"><b>{p.open}</b> open · {p.closed} closed</div>
              <div className="ratioBar"><div style={{ width: `${Math.round(p.closedRatio * 100)}%` }} /></div>
              <div className="ptFlags">
                {p.missed > 0 && <span className="flag sev-hi">{p.missed} missed?</span>}
                {p.cancelDanger > 0 && <span className="flag sev-hi">{p.cancelDanger} cancel ⚠</span>}
                {p.issues > 0 && <span className="flag sev-mid">{p.issues} EDI errors</span>}
                {!p.missed && !p.cancelDanger && !p.issues && <span className="flag sev-lo">clean</span>}
              </div>
            </div>
          )})}
        </aside>

        {/* ── the open work queue ── */}
        <section className="ediQueue">
          <EdiCalendar openPos={allOpen} />

          {/* partner-level tabs, right below the calendar (Nima, 2026-07-20) */}
          <div className="tabs" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <button className={'tab' + (ediTab === 'open' ? ' active' : '')} onClick={() => setEdiTab('open')}>Open <span className="count">{openPos.length}</span></button>
            <button className={'tab' + (ediTab === 'orphans' ? ' active' : '')} onClick={() => setEdiTab('orphans')}>Unassigned 856/810 <span className="count">{orphans.length}</span></button>
            <button className={'tab' + (ediTab === 'cancelled' ? ' active' : '')} onClick={() => setEdiTab('cancelled')}>Cancelled <span className="count">{cancelledPos.length}</span></button>
            <button className={'tab' + (ediTab === 'closed' ? ' active' : '')} onClick={() => setEdiTab('closed')}>Closed <span className="count">{closedPos.length}</span></button>
          </div>

          {ediTab === 'orphans' && orphans.length === 0 && <div className="empty">No unassigned 856/810 documents{selectedPartner ? ' for this partner' : ''} — everything resolves to an 850. 🎉</div>}
          {ediTab === 'orphans' && orphans.length > 0 && (
            <div className="orphanBox">
              <h2>⚠ Unassigned documents <span className="count">{orphans.length}</span></h2>
              <p className="hint">856s / 810s with no 850 anywhere — un-tracked work. Link each to the PO it belongs to (verified by your data), and it joins that order's pipeline.</p>
              {orphans.map((o) => (
                <div key={o.businessNumber} className="poCard po-danger">
                  <div className="poHead">
                    <span className="miniSo">{o.businessNumber}</span>
                    <span className="cust">{o.tradingPartner}</span>
                    {o.transactions.map((t) => (
                      <span key={t.id} className="flag sev-mid">{t.type.split('_')[0]}</span>
                    ))}
                    <span className="poDates">{o.transactions[0]?.createdAt ? new Date(o.transactions[0].createdAt).toLocaleDateString() : ''}</span>
                  </div>
                  {o.transactions.map((t) => {
                    const draft = linkDrafts[t.id] || {}
                    return (
                      <div key={t.id} className="resolveRow">
                        <span className="mono" style={{ fontSize: 12 }}>{t.type.split('_')[0]}</span>
                        <span className="mono cust" style={{ fontSize: 12 }} title="This document's own reference number">ref {t.businessNumber || '—'}</span>
                        <input className="qtyInput" style={{ width: 140 }} placeholder="Link to PO / 850 #"
                               value={draft.businessNumber ?? ''}
                               onChange={(e) => setDraft(t.id, { businessNumber: e.target.value })} />
                        <input className="qtyInput" style={{ width: 200 }} placeholder="How you verified it (note)"
                               value={draft.note ?? ''}
                               onChange={(e) => setDraft(t.id, { note: e.target.value })} />
                        <button className="btn" disabled={linkBusy === t.id} onClick={() => submitLink(t.id)}>
                          {linkBusy === t.id ? '…' : 'Link'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )}

          {ediTab === 'open' && !openPos.length && <div className="empty">No open POs here — everything’s closed out. 🎉</div>}
          {ediTab === 'open' && openPos.map((o) => {
            const isOpen = expanded.has(o.businessNumber)
            const w = o.work
            const rd = resolveDrafts[o.businessNumber]
            return (
              <div key={o.businessNumber}
                   className={'poCard' + (w.cancelState === 'passed' || w.missed850 ? ' po-danger' : w.cancelState === 'soon' ? ' po-warn' : '')}>
                <div className="poHead" onClick={() => toggle(o.businessNumber)}>
                  <span className="miniSo">{o.businessNumber}</span>
                  <SeasonBadge season={seasons[`EDI_PO|${o.businessNumber}`]} onSave={(s) => onSaveSeason(o.businessNumber, s)} highlightCore />
                  {!selectedPartner && <span className="cust">{o.tradingPartner}</span>}
                  <span className={'flag ' + (o.hasIssue ? 'sev-hi' : 'sev-lo')}>{o.stage}</span>
                  {w.missed850 && <span className="flag sev-hi">MISSED? {w.age850}d old</span>}
                  {w.cancelState === 'passed' && <span className="flag sev-hi">cancel passed {w.cancelDays}d</span>}
                  {w.cancelState === 'soon' && <span className="flag sev-mid">cancel in {w.cancelDays}d</span>}
                  {w.resolution && <span className="flag sev-mid">manual: {w.resolution.netsuiteRef || 'note'}</span>}
                  {review.ediSupply?.[o.businessNumber]?.fromStock && <span className="flag sev-lo">📦 from stock</span>}
                  {review.ediSupply?.[o.businessNumber]?.poNumber && <span className="flag sev-lo">📦 PO {review.ediSupply[o.businessNumber].poNumber}</span>}
                  <span className="poDates">
                    {fmtD(o.shipNotBefore)} → {fmtD(o.cancelAfter)}
                  </span>
                  <button className="btnGhost poQuickClose" disabled={resolveBusy === o.businessNumber}
                          onClick={(ev) => { ev.stopPropagation(); if (window.confirm(`Mark ${o.businessNumber} closed (work complete)?`)) submitResolution(o, 'close') }}>
                    ✓ Close
                  </button>
                  <button className="btnGhost poQuickClose" disabled={resolveBusy === o.businessNumber}
                          onClick={(ev) => { ev.stopPropagation(); if (window.confirm(`Mark ${o.businessNumber} CANCELLED — no further documents coming?`)) submitResolution(o, 'cancel') }}>
                    ⊘ Cancelled
                  </button>
                  {review.ediTasks?.[o.businessNumber] === 'open'
                    ? <button className="btnGhost poQuickClose" title="A task is open for this PO — open Transmissions"
                              onClick={(ev) => { ev.stopPropagation(); onNavigate?.('transmissions') }}>◉ Task</button>
                    : review.ediTasks?.[o.businessNumber] === 'done'
                    ? <button className="btnGhost poQuickClose" title="This PO's task was completed — open Transmissions"
                              onClick={(ev) => { ev.stopPropagation(); onNavigate?.('transmissions') }}>✓ Task</button>
                    : <button className="btnGhost poQuickClose" disabled={taskBusy === o.businessNumber}
                              onClick={(ev) => { ev.stopPropagation(); makeTask(o.businessNumber) }}>＋ Task</button>}
                  <span className="cust">{isOpen ? '▾' : '▸'}</span>
                </div>
                <div className="neededLine">→ {w.needed}</div>
                {o.netsuiteOrder && (
                  <div className="poNs">{o.netsuiteOrder.soNumber} · {o.netsuiteOrder.stageLabel || o.netsuiteOrder.stage}</div>
                )}

                {isOpen && (
                  <div className="poDetail">
                    {/* manual resolution — the NetSuite connection the searches can't see */}
                    <div className="resolveRow">
                      <input className="qtyInput" style={{ width: 150 }} placeholder="NetSuite ref (SO/IF/INV#)"
                             value={rd?.netsuiteRef ?? w.resolution?.netsuiteRef ?? ''}
                             onChange={(e) => setRDraft(o.businessNumber, { netsuiteRef: e.target.value })} />
                      <input className="qtyInput" style={{ width: 240 }} placeholder="Note (why / where it stands)"
                             value={rd?.note ?? w.resolution?.note ?? ''}
                             onChange={(e) => setRDraft(o.businessNumber, { note: e.target.value })} />
                      <button className="btn" disabled={resolveBusy === o.businessNumber}
                              onClick={() => submitResolution(o, 'link')}>Save link</button>
                      <button className="btnGhost" disabled={resolveBusy === o.businessNumber}
                              onClick={() => submitResolution(o, 'close')}>Mark closed</button>
                      <button className="btnGhost" disabled={resolveBusy === o.businessNumber}
                              onClick={() => submitResolution(o, 'cancel')}>Mark cancelled</button>
                      {w.resolution && (
                        <button className="linkBtn" disabled={resolveBusy === o.businessNumber}
                                onClick={() => removeResolution(o.businessNumber)}>remove manual</button>
                      )}
                    </div>

                    {/* supply side: which inbound production PO this comes from,
                        or from-stock (Nima, 2026-07-20) */}
                    <div className="resolveRow">
                      <span className="hint" style={{ margin: 0 }}>Supply:</span>
                      <input className="qtyInput" style={{ width: 170 }} placeholder="Inbound production PO #"
                             disabled={review.ediSupply?.[o.businessNumber]?.fromStock}
                             value={supplyDrafts[o.businessNumber]?.poNumber ?? review.ediSupply?.[o.businessNumber]?.poNumber ?? ''}
                             onChange={(e) => setSDraft(o.businessNumber, { poNumber: e.target.value })} />
                      <button className="btn" disabled={supplyBusy === o.businessNumber}
                              onClick={() => saveSupply(o.businessNumber, { fromStock: false })}>Save PO</button>
                      <button className={'btnGhost' + (review.ediSupply?.[o.businessNumber]?.fromStock ? ' active' : '')}
                              disabled={supplyBusy === o.businessNumber}
                              onClick={() => saveSupply(o.businessNumber, { fromStock: !review.ediSupply?.[o.businessNumber]?.fromStock })}>
                        {review.ediSupply?.[o.businessNumber]?.fromStock ? '✓ From stock' : 'From stock'}
                      </button>
                      {review.ediSupply?.[o.businessNumber] && (
                        <button className="linkBtn" disabled={supplyBusy === o.businessNumber}
                                onClick={() => removeSupply(o.businessNumber)}>clear</button>
                      )}
                    </div>

                    <NoteWidget docType="EDI_PO" docNumber={o.businessNumber} />
                    <DocLinks docType="EDI_PO" docNumber={o.businessNumber} selfLabel={o.tradingPartner} />

                    {!!o.linkGaps.length && (
                      <div className="allocPos">{o.linkGaps.map((g, i) => <div key={i} className="sev-hi">⚠ {g}</div>)}</div>
                    )}
                    {!!o.fulfillments.length && (
                      <div className="allocPos">
                        {o.fulfillments.map((f, i) => (
                          <div key={i}>
                            DC {f.dc} ({f.dcCity || '—'}) · BOL {f.bol || '—'} · carrier {f.scac || '—'}
                            {f.shipDate && ` · shipped ${fmtD(f.shipDate)}`}
                          </div>
                        ))}
                      </div>
                    )}
                    {o.netsuiteOrder && (o.netsuiteOrder.itemFulfillments?.length > 0 || o.netsuiteOrder.invoices?.length > 0) && (
                      <div className="allocPos">
                        <div className="cust">{o.netsuiteOrder.soNumber} — {o.netsuiteOrder.stageLabel}</div>
                        {o.netsuiteOrder.itemFulfillments.map((f) => (
                          <div key={f.ifNumber}>
                            IF {f.ifNumber} · {f.status}
                            {f.actualShipDate && ` · shipped ${fmtD(f.actualShipDate)}`}
                            {f.invoiceNumber && ` · invoice ${f.invoiceNumber}`}
                          </div>
                        ))}
                        {o.netsuiteOrder.invoices.map((i) => (
                          <div key={i.invNumber}>
                            Invoice {i.invNumber} · {i.status}
                            {i.amountRemaining > 0 && ` · $${i.amountRemaining} remaining`}
                          </div>
                        ))}
                      </div>
                    )}

                    <table className="grid">
                      <thead><tr><th>Document</th><th>Ref #</th><th>Direction</th><th>Status</th><th>Created</th><th></th></tr></thead>
                      <tbody>
                        {o.transactions.map((t) => {
                          const issue = [t.validationStatus, t.deliveryStatus, t.acknowledgmentStatus].find(isIssueValue)
                          const draft = linkDrafts[t.id] || {}
                          // Candidates to link an invalid/failed document to: another
                          // transaction of the SAME document type in this order that
                          // doesn't itself have an issue (e.g. a resent, valid 856).
                          const ackCandidates = issue && !t.ack
                            ? o.transactions.filter((t2) => t2.id !== t.id && t2.type === t.type &&
                                !ISSUE_STATUSES.has(t2.validationStatus) && !ISSUE_STATUSES.has(t2.deliveryStatus) &&
                                !ISSUE_STATUSES.has(t2.acknowledgmentStatus))
                            : []
                          return (
                            <Fragment key={t.id}>
                              <tr>
                                <td className="mono">{t.type}</td>
                                <td className="mono cust" title="The document's own business number — its trackable reference">{t.businessNumber || '—'}</td>
                                <td>{t.direction}</td>
                                <td className={issue && !t.ack ? 'sev-hi' : t.ack ? 'sev-lo' : ''}>
                                  {t.ack ? `✓ resolved${t.ack.linkedTransactionId ? ' (linked)' : ' (nothing to link)'}` : issue || t.deliveryStatus}
                                </td>
                                <td className="cust">{t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}</td>
                                <td>
                                  {t.manualLinkNote !== undefined && (
                                    <button className="btnGhost" disabled={linkBusy === t.id} onClick={() => undoLink(t.id)}>
                                      Undo link{t.manualLinkNote ? ` (${t.manualLinkNote})` : ''}
                                    </button>
                                  )}
                                  {t.ack && (
                                    <button className="btnGhost" disabled={ackBusy === t.id} onClick={() => undoAck(t.id)}>
                                      Undo ack{t.ack.note ? ` (${t.ack.note})` : ''}
                                    </button>
                                  )}
                                </td>
                              </tr>
                              {issue && !t.ack && (
                                <tr>
                                  <td colSpan={6}>
                                    {!!ackCandidates.length && (
                                      <>
                                        <select className="qtyInput" style={{ width: 260 }}
                                                value={ackDrafts[t.id] ?? ''}
                                                onChange={(e) => setAckDrafts((s) => ({ ...s, [t.id]: e.target.value }))}>
                                          <option value="">Link to the valid resend…</option>
                                          {ackCandidates.map((c) => (
                                            <option key={c.id} value={c.id}>{c.type} · {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : c.id}</option>
                                          ))}
                                        </select>
                                        <button className="btn" style={{ marginLeft: 6 }} disabled={ackBusy === t.id || !ackDrafts[t.id]}
                                                onClick={() => submitAck(t.id, ackDrafts[t.id], 'linked to valid resend')}>
                                          {ackBusy === t.id ? '…' : 'Link'}
                                        </button>
                                      </>
                                    )}
                                    <button className="btnGhost" style={{ marginLeft: 6 }} disabled={ackBusy === t.id}
                                            onClick={() => submitAck(t.id, null, 'confirmed nothing to link')}>
                                      Confirm: nothing to link
                                    </button>
                                  </td>
                                </tr>
                              )}
                              {o.bucket === 'NO_850_FOUND' && (
                                <tr>
                                  <td colSpan={6}>
                                    <input className="qtyInput" style={{ width: 140 }} placeholder="PO / business #"
                                           value={draft.businessNumber ?? ''}
                                           onChange={(e) => setDraft(t.id, { businessNumber: e.target.value })} />
                                    <input className="qtyInput" style={{ width: 220, marginLeft: 6 }} placeholder="Note (optional)"
                                           value={draft.note ?? ''}
                                           onChange={(e) => setDraft(t.id, { note: e.target.value })} />
                                    <button className="btn" style={{ marginLeft: 6 }} disabled={linkBusy === t.id}
                                            onClick={() => submitLink(t.id)}>
                                      {linkBusy === t.id ? '…' : 'Link'}
                                    </button>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}

          {(ediTab === 'closed' || ediTab === 'cancelled') && (
            <table className="grid" style={{ marginTop: 8 }}>
              <thead><tr><th>PO</th><th>Partner</th><th>{ediTab === 'cancelled' ? 'Status' : 'Closed by'}</th><th>NetSuite ref</th><th>Note</th><th></th></tr></thead>
              <tbody>
                {(ediTab === 'cancelled' ? cancelledPos : closedPos).map((o) => (
                  <tr key={o.businessNumber}>
                    <td className="mono">{o.businessNumber}</td>
                    <td className="cust">{o.tradingPartner}</td>
                    <td>{o.work.closedBy === 'cancelled'
                      ? <span className="flag sev-hi">⊘ cancelled</span>
                      : o.work.closedBy === 'manual'
                        ? <span className="flag sev-mid">manual</span>
                        : <span className="flag sev-lo">docs complete</span>}</td>
                    <td className="cust">{o.work.resolution?.netsuiteRef || o.netsuiteOrder?.soNumber || '—'}</td>
                    <td className="cust">{o.work.resolution?.note || ''}</td>
                    <td>
                      {(o.work.closedBy === 'manual' || o.work.closedBy === 'cancelled') && (
                        <button className="linkBtn" onClick={() => removeResolution(o.businessNumber)}>reopen</button>
                      )}
                    </td>
                  </tr>
                ))}
                {!(ediTab === 'cancelled' ? cancelledPos : closedPos).length && (
                  <tr><td colSpan={6} className="cust">Nothing here yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* ── manually-entered old orders (unchanged) ── */}
      <section style={{ marginTop: 28 }}>
        <h2>Manually-entered EDI orders <span className="count">{manualOrders.length}</span></h2>
        <p className="hint">
          Older orders that shipped before Orderful/the searches could see them. Hand-entered, never merged
          into the automated pipeline, always flagged MANUAL.
        </p>
        {!manualDraft && <button className="btnGhost" onClick={() => setManualDraft({ businessNumber: '', tradingPartner: '', note: '' })}>＋ Add one</button>}
        {manualDraft && (
          <form className="scanManual" style={{ maxWidth: 720 }} onSubmit={onAddManual}>
            <input className="qtyInput" placeholder="PO / business #" value={manualDraft.businessNumber}
                   onChange={(e) => setManualDraft({ ...manualDraft, businessNumber: e.target.value })} />
            <input className="qtyInput" placeholder="Trading partner" value={manualDraft.tradingPartner}
                   onChange={(e) => setManualDraft({ ...manualDraft, tradingPartner: e.target.value })} />
            <input className="qtyInput" style={{ flex: 1 }} placeholder="Note (ship date, docs seen, where found)" value={manualDraft.note}
                   onChange={(e) => setManualDraft({ ...manualDraft, note: e.target.value })} />
            <button className="importBtn" disabled={manualBusy}>{manualBusy ? '…' : 'Add'}</button>
            <button type="button" className="linkBtn" onClick={() => setManualDraft(null)}>cancel</button>
          </form>
        )}
        {!!manualOrders.length && (
          <table className="grid" style={{ marginTop: 10 }}>
            <thead><tr><th>PO</th><th>Partner</th><th>Note</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {manualOrders.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.businessNumber} <span className="flag sev-mid">MANUAL</span></td>
                  <td className="cust">{m.tradingPartner || '—'}</td>
                  <td className="cust">{m.note || ''}</td>
                  <td className="cust">{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}</td>
                  <td><button className="linkBtn" onClick={() => onRemoveManual(m.id)}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
