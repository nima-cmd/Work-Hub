import { useEffect, useMemo, useState } from 'react'
import { fetchLedger, fetchOrderLedger } from '../api.js'
import { SPINE, SPINE_ORDER, TASK_DONE } from '../../../src/model/orderEvents.js'
import { NsLink } from '../lib.jsx'

// Ledger — the order history (rebuilt 2026-07-31).
//
// This view used to render completed quest TASKS and never touched order_events
// at all, which made its name actively misleading: the one place called "Ledger"
// couldn't answer "what happened to SO12293" or "what moved on Tuesday". That
// archive still exists under the Tasks tab's "All" toggle; this is now the
// document history the ledger was built for ([[work-hub-order-ledger]]).
//
// Two ways in, matching the API:
//   • an ORDER — everything that happened to one SO and to every document
//     hanging off it, oldest first, walked along the pipeline spine.
//   • a WINDOW — what occurred in a date range, newest first, filterable.
//
// THE THING THIS VIEW MUST NOT GET WRONG: some events carry a real source date
// and some are only a first-sighting. PACKED, INVOICED and PAID have no upstream
// timestamp — nothing records when an invoice was raised, only its current
// state — so the ledger tags them `observed` and the backfill refuses to invent
// one. Rendering those identically to a real date would quietly assert a history
// that never happened. They read "seen" here, never "on".

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '')

// Local YYYY-MM-DD — grouping on toISOString would shift days across the date
// line in a negative-offset timezone (the same trap the daily-counts query hit).
function dayKey(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key) {
  if (!key) return 'Undated'
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diff = Math.round((today - date) / 86_400_000)
  const rel = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff > 1 ? `${diff}d ago` : ''
  const full = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
  return rel ? `${full} · ${rel}` : full
}

// Colour by what kind of moment it is, not by event name — arrival, physical
// handling, money, and outbound EDI each read differently at a glance.
const TONE = {
  SO_IMPORTED: 'arrive', IF_CREATED: 'arrive',
  CUSTODY_OUT: 'hands', CUSTODY_IN: 'hands', CUSTODY_CLEARED: 'hands', PACKED: 'hands',
  INVOICED: 'money', PAID: 'money', SHIPPED_VALUE: 'money',
  REACHED_APPROVED: 'go', ROUTED: 'go', DEPARTED: 'go',
  ASN_SENT: 'edi', INVOICE_SENT: 'edi',
  // Completed tasks share the feed but not the pipeline — their own tone so a day's
  // work reads apart from a document's movement at a glance.
  [TASK_DONE]: 'task',
}

export default function Ledger() {
  const [mode, setMode] = useState('window') // 'window' | 'order'
  const [q, setQ] = useState('')
  const [types, setTypes] = useState(() => new Set())
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [order, setOrder] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  // The window feed. `q` matches a document number server-side, so "IF7413"
  // finds its whole trail without needing to know its SO.
  useEffect(() => {
    if (mode !== 'window') return
    setBusy(true)
    const from = new Date(Date.now() - days * 86_400_000).toISOString()
    fetchLedger({ from, q: q.trim() || null, type: [...types], limit: 800 })
      .then((r) => { setData(r); setErr(null) })
      .catch((e) => setErr(e.message))
      .finally(() => setBusy(false))
  }, [mode, q, types, days])

  async function openOrder(soNumber) {
    if (!soNumber) return
    setBusy(true); setErr(null)
    try {
      setOrder(await fetchOrderLedger(soNumber))
      setMode('order')
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const events = data?.events || []
  const grouped = useMemo(() => {
    const out = []; const byKey = new Map()
    for (const e of events) {
      const k = dayKey(e.occurredAt)
      let g = byKey.get(k)
      if (!g) { g = { key: k, items: [] }; byKey.set(k, g); out.push(g) }
      g.items.push(e)
    }
    return out
  }, [events])

  const observedCount = events.filter((e) => e.observed).length

  function toggleType(key) {
    setTypes((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  return (
    <div className="ledgerView">
      <div className="lgHead">
        <div>
          <h2>Ledger <span className="muted">· order history</span></h2>
          <div className="muted lgSub">
            Every document transition, from sales order to departure. Search a document number
            to pull its whole trail, or click an order to walk it end to end.
          </div>
        </div>
        <div className="lgModes">
          <button className={'btnGhost' + (mode === 'window' ? ' on' : '')} onClick={() => setMode('window')}>By date</button>
          <button className={'btnGhost' + (mode === 'order' ? ' on' : '')} disabled={!order}
            onClick={() => setMode('order')}>{order ? `Order ${order.soNumber}` : 'By order'}</button>
        </div>
      </div>

      {err && <div className="banner error">⚠ {err}</div>}

      {mode === 'window' && (
        <>
          <div className="lgBar">
            <input className="tasksSearch" placeholder="Search a document — SO12293, IF7413, INV11244…"
              value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && /^SO/i.test(q.trim())) openOrder(q.trim().toUpperCase()) }} />
            <select className="lgSelect" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>last 7 days</option>
              <option value={30}>last 30 days</option>
              <option value={90}>last 90 days</option>
              <option value={3650}>everything</option>
            </select>
            <span className="muted lgCount">
              {busy ? 'loading…' : `${events.length} event${events.length === 1 ? '' : 's'}`}
              {observedCount > 0 && <> · <em className="lgObsNote">{observedCount} first-seen</em></>}
            </span>
          </div>

          <div className="lgTypes">
            {SPINE.map((s) => (
              <button key={s.key} className={'lgType t-' + (TONE[s.key] || 'arrive') + (types.has(s.key) ? ' on' : '')}
                onClick={() => toggleType(s.key)} title={s.label}>{s.label}</button>
            ))}
            {types.size > 0 && <button className="btnGhost" onClick={() => setTypes(new Set())}>clear</button>}
          </div>

          {!busy && !events.length && (
            <div className="empty">Nothing in this window. Widen the range, or clear the filters.</div>
          )}

          {/* A dated timeline (Nima, 2026-08-19): "break it up as a timeline by dates
              … the task to be spread out and not stacked atop one another". The date is
              a milestone on a rail down the left; the day's entries fan out to the right
              in as many columns as the window allows, rather than one long column of
              800 rows in a 980px gutter. */}
          <div className="lgTimeline">
            {grouped.map((g) => (
              <section key={g.key || 'undated'} className="ledgerDay">
                <div className="ledgerDayHead">
                  <span className="lgRailDot" aria-hidden="true" />
                  <span className="ledgerDayLabel">{dayLabel(g.key)}</span>
                  <span className="sectorCount">{g.items.length}</span>
                  {g.items.some((e) => e.eventType === TASK_DONE) && (
                    <span className="lgDayTasks">
                      {g.items.filter((e) => e.eventType === TASK_DONE).length} task{g.items.filter((e) => e.eventType === TASK_DONE).length === 1 ? '' : 's'} done
                    </span>
                  )}
                </div>
                <div className="lgRows">
                  {g.items.map((e) => <EventRow key={e.id} e={e} onOpenOrder={openOrder} />)}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {mode === 'order' && order && <OrderTimeline order={order} />}
    </div>
  )
}

// One event. An `observed` row is visually a different KIND of fact — dashed
// rule, muted, and the word "seen" instead of a time — so a first-sighting can
// never be read as the day the thing actually happened.
function EventRow({ e, onOpenOrder }) {
  const tone = TONE[e.eventType] || 'arrive'
  // ⚠️ A task's SUBJECT is its content, not a note. Rendering it in the `note` slot
  // (quoted, italic, muted) buried the only part that says what was actually done.
  const isTask = e.eventType === TASK_DONE
  if (isTask) {
    return (
      <div className="lgRow t-task lgTask">
        <span className="lgWhen" title={new Date(e.occurredAt).toLocaleString()}>{fmtTime(e.occurredAt)}</span>
        <span className="lgDot d-task" />
        <span className="lgTaskSubject" title={e.note || ''}>{e.note || 'Task'}</span>
        {e.docNumber && <span className="lgDoc">{e.docNumber}</span>}
        {e.taskFrom && <span className="lgTaskFrom">{e.taskFrom}</span>}
        <span className="lgTaskTag">done</span>
      </div>
    )
  }
  return (
    <div className={'lgRow t-' + tone + (e.observed ? ' observed' : '')}>
      <span className="lgWhen" title={e.observed
        ? 'First sighting — nothing upstream records when this actually happened, so the ledger will not claim a date'
        : new Date(e.occurredAt).toLocaleString()}>
        {e.observed ? <em>seen</em> : fmtTime(e.occurredAt)}
      </span>
      <span className={'lgDot d-' + tone} />
      <span className="lgLabel">{e.label}</span>
      <span className="lgDoc">{e.docNumber}</span>
      {e.soNumber && (
        <button className="lgSo" onClick={() => onOpenOrder(e.soNumber)}
          title="Open this order's full history">{e.soNumber}</button>
      )}
      {e.note && <span className="lgNote">“{e.note}”</span>}
      {e.observed && <span className="lgObsTag" title="Date is a first sighting, not a source timestamp">first seen</span>}
    </div>
  )
}

// One order, walked along the pipeline spine. Stages the order never reached
// are shown greyed rather than omitted — the GAP is the useful part, which is
// the whole reason the ledger exists.
function OrderTimeline({ order }) {
  const byType = new Map()
  for (const e of order.events || []) {
    if (!byType.has(e.eventType)) byType.set(e.eventType, [])
    byType.get(e.eventType).push(e)
  }
  const reached = [...byType.keys()].filter((k) => SPINE_ORDER.has(k))
  const furthest = reached.length ? Math.max(...reached.map((k) => SPINE_ORDER.get(k))) : -1
  const docs = order.documents || {}

  return (
    <div className="lgOrder">
      <div className="lgOrderHead">
        <h3><NsLink doc={order.soNumber} /></h3>
        <span className="muted">
          {(docs.fulfillments || []).length} fulfilment{(docs.fulfillments || []).length === 1 ? '' : 's'} ·{' '}
          {(docs.invoices || []).length} invoice{(docs.invoices || []).length === 1 ? '' : 's'} ·{' '}
          {(order.events || []).length} events
        </span>
      </div>

      <div className="lgSpine">
        {SPINE.map((s, i) => {
          const hits = byType.get(s.key) || []
          const done = hits.length > 0
          // "Never happened" and "hasn't happened yet" are different facts.
          const skipped = !done && i < furthest
          return (
            <div key={s.key} className={'lgStage' + (done ? ' done' : skipped ? ' skipped' : ' pending')}>
              <span className={'lgDot d-' + (TONE[s.key] || 'arrive')} />
              <span className="lgStageLabel">{s.label}</span>
              {done ? (
                <span className="lgStageWhen">
                  {hits.map((h) => (
                    <span key={h.id} className={'lgStageHit' + (h.observed ? ' observed' : '')}
                      title={h.observed ? 'First sighting — not a source timestamp' : new Date(h.occurredAt).toLocaleString()}>
                      {h.docNumber} · {h.observed ? <em>seen {fmtDate(h.occurredAt)}</em> : fmtDate(h.occurredAt)}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="lgStageWhen muted">{skipped ? 'no record' : '—'}</span>
              )}
            </div>
          )
        })}
      </div>

      {!(order.events || []).length && (
        <div className="empty">No events recorded against {order.soNumber} yet.</div>
      )}
    </div>
  )
}
