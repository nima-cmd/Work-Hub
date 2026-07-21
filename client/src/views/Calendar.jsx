import { useEffect, useMemo, useState } from 'react'
import { SourceBadge } from '../lib.jsx'
import { imagesFor } from '../data/characterImages.js'
import { fetchCalendarEvents, createManualTask } from '../api.js'

const DAY = 86400000

// Calendar (rebuilt 2026-07-18 to Nima's spec): three zones —
//   [ open tasks | month grid | selected day's events ]
// The calendar sits to the RIGHT of the tasks; clicking a day opens everything
// that happened/is due that day in the right-hand panel: ship/cancel deadlines,
// actual departures, custody scans + ledger events, and the task journal.
export default function Calendar({ orders, tasks = [], activity = [], events = [], onRefresh }) {
  const today = startOfDay(Date.now())
  const [selected, setSelected] = useState(today)
  const [cursor, setCursor] = useState(today)
  const [cal, setCal] = useState({ configured: false, events: [] }) // Google Calendar

  useEffect(() => {
    fetchCalendarEvents().then(setCal).catch(() => setCal({ configured: false, events: [] }))
  }, [])

  // ── every dated thing, indexed by day ─────────────────────────────────────
  const byDay = useMemo(() => {
    const m = new Map()
    const push = (day, item) => { if (!m.has(day)) m.set(day, []); m.get(day).push(item) }
    for (const o of orders) {
      if (o.shipDate) push(startOfDay(new Date(o.shipDate).getTime()), { cat: 'deadline', kind: 'Ship due', o })
      if (o.cancelDate) push(startOfDay(new Date(o.cancelDate).getTime()), { cat: 'deadline', kind: 'Cancel by', o })
      for (const f of o.fulfillments || []) {
        if (f.actualShipDate) push(startOfDay(new Date(f.actualShipDate).getTime()), { cat: 'shipped', kind: 'Departed', o, f })
      }
    }
    for (const a of activity) push(startOfDay(new Date(a.createdAt).getTime()), { cat: 'journal', kind: a.kind?.replace('_', ' ') || 'note', a })
    for (const e of events) push(startOfDay(new Date(e.occurredAt).getTime()), { cat: 'ledger', kind: ledgerKind(e), e })
    for (const ev of cal.events || []) {
      if (ev.start) push(startOfDay(new Date(ev.start).getTime()), { cat: 'invite', kind: ev.holocall ? 'Holocall' : 'Invite', ev })
    }
    return m
  }, [orders, activity, events, cal])

  const openTasks = tasks.filter((t) => t.status === 'open')
  const overdue = []
  for (const o of orders) {
    if (o.shipDate && startOfDay(new Date(o.shipDate).getTime()) < today && o.stage !== 'SHIPPED')
      overdue.push(o)
  }

  const gridStart = startOfWeek(startOfMonth(cursor))
  const days = Array.from({ length: 42 }, (_, i) => gridStart + i * DAY)
  const curMonth = new Date(cursor).getMonth()
  const dayItems = byDay.get(selected) || []

  return (
    <div className="calendar3">
      {/* ── zone 1: duties ── */}
      <aside className="calTasks">
        <div className="sectorHead"><span className="sectorTitle">◤ DUTIES</span><span className="sectorCount">{openTasks.length}</span></div>
        {overdue.length > 0 && (
          <div className="calOverdueNote">⚠ {overdue.length} order{overdue.length > 1 ? 's' : ''} past ship date</div>
        )}
        {cal.needsReauth && (
          <div className="calOverdueNote">📅 Connect Google Calendar — re-run <code>connect-gmail.js</code> to grant calendar access.</div>
        )}
        {openTasks.map((t) => {
          const img = imagesFor(t.characterId)[0]
          return (
            <div key={t.id} className={'calTask ' + (t.urgency === 'hi' ? 'sev-hi' : t.urgency === 'mid' ? 'sev-mid' : 'sev-lo')}>
              <span className="calTaskAvatar">{img ? <img src={img} alt="" /> : '◈'}</span>
              <span className="calTaskBody">
                <b>{t.character?.name || 'Messenger'}</b>
                <span>{t.subject}</span>
              </span>
            </div>
          )
        })}
        {!openTasks.length && <div className="empty">No open tasks.</div>}
      </aside>

      {/* ── zone 2: the month grid ── */}
      <section className="calMain">
        <div className="calNav">
          <button className="calNavBtn" onClick={() => setCursor(addMonths(cursor, -1).getTime())}>‹</button>
          <h3 className="calTitle">{new Date(cursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
          <button className="calNavBtn" onClick={() => setCursor(addMonths(cursor, 1).getTime())}>›</button>
          <button className="calToday" onClick={() => { setCursor(today); setSelected(today) }}>Today</button>
        </div>
        <div className="calGrid">
          {WEEKDAYS.map((w) => <div key={w} className="calWeekday">{w}</div>)}
          {days.map((day) => {
            const items = byDay.get(day) || []
            const cats = new Set(items.map((i) => i.cat))
            const inMonth = new Date(day).getMonth() === curMonth
            return (
              <button
                key={day}
                onClick={() => setSelected(day)}
                className={'calCell calCellBtn' + (inMonth ? '' : ' calCell-dim') +
                  (day === today ? ' calCell-today' : '') + (day === selected ? ' calCell-sel' : '')}
              >
                <div className="calDayNum">{new Date(day).getDate()}</div>
                <div className="calDots">
                  {cats.has('deadline') && <i className="calDot d-deadline" title="deadline" />}
                  {cats.has('shipped') && <i className="calDot d-shipped" title="departure" />}
                  {cats.has('ledger') && <i className="calDot d-ledger" title="custody / ledger" />}
                  {cats.has('journal') && <i className="calDot d-journal" title="journal" />}
                  {cats.has('invite') && <i className="calDot d-invite" title="calendar invite / holocall" />}
                </div>
                {items.length > 0 && <div className="calCount">{items.length}</div>}
              </button>
            )
          })}
        </div>
        <div className="calKey">
          <i className="calDot d-deadline" /> deadline &nbsp; <i className="calDot d-shipped" /> departed &nbsp;
          <i className="calDot d-ledger" /> custody/ledger &nbsp; <i className="calDot d-journal" /> journal &nbsp;
          <i className="calDot d-invite" /> invite/holocall
        </div>
      </section>

      {/* ── zone 3: everything on the selected day ── */}
      <aside className="calDay">
        <div className="sectorHead">
          <span className="sectorTitle">◤ {fmtLong(selected)}</span>
          <span className="sectorCount">{dayItems.length}</span>
        </div>
        {CAT_ORDER.map((cat) => {
          const list = dayItems.filter((i) => i.cat === cat)
          if (!list.length) return null
          return (
            <div key={cat} className="calDayGroup">
              <div className="taskGroupHead">{CAT_LABEL[cat]} <span className="sectorCount">{list.length}</span></div>
              {list.map((it, i) => <DayItem key={i} it={it} onRefresh={onRefresh} />)}
            </div>
          )
        })}
        {!dayItems.length && <div className="empty">Nothing recorded on this day.</div>}
      </aside>
    </div>
  )
}

const CAT_ORDER = ['invite', 'deadline', 'shipped', 'ledger', 'journal']
const CAT_LABEL = {
  invite: 'Calendar & holocalls', deadline: 'Deadlines', shipped: 'Departures', ledger: 'Custody & ledger', journal: 'Journal',
}

function DayItem({ it, onRefresh }) {
  if (it.cat === 'invite') return <InviteRow ev={it.ev} onRefresh={onRefresh} />
  if (it.cat === 'deadline' || it.cat === 'shipped') {
    return (
      <div className={'calRow ' + (it.kind === 'Cancel by' ? 'cancel' : '')}>
        <span className={'caltag ' + (it.kind === 'Cancel by' ? 'sev-hi' : it.cat === 'shipped' ? 'sev-lo' : 'sev-mid')}>{it.kind}</span>
        <span className="so">{it.f?.ifNumber || it.o.soNumber}</span>
        <span className="cust">{it.o.customer}</span>
        <SourceBadge source={it.o.source} />
      </div>
    )
  }
  if (it.cat === 'ledger') {
    const e = it.e
    return (
      <div className="calRow">
        <span className="caltag sev-lo">{it.kind}</span>
        <span className="so">{e.docNumber}</span>
        <span className="cust">{e.customer || e.soNumber || ''}</span>
        {e.note && <span className="calNote">“{e.note}”</span>}
        <span className="caldate">{fmtTime(e.occurredAt)}</span>
      </div>
    )
  }
  return (
    <div className="calRow">
      <span className="caltag sev-lo">{it.kind}</span>
      <span className="cust">{it.a.subject || it.a.note || ''}</span>
      <span className="caldate">{fmtTime(it.a.createdAt)}</span>
    </div>
  )
}

// A Google Calendar event on the day panel. A Zoom/Meet link renders it as a
// "holocall" (Nima, 2026-07-21) with a join button, and any invite can be
// dropped onto the task list.
function InviteRow({ ev, onRefresh }) {
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState(false)
  async function addTask() {
    setBusy(true)
    try {
      const when = ev.start ? new Date(ev.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
      const bits = [when, ev.conferenceUrl ? `[Join ${ev.conferenceKind === 'zoom' ? 'Zoom' : 'call'}](${ev.conferenceUrl})` : null].filter(Boolean)
      await createManualTask({ subject: `${ev.holocall ? '📡 ' : '📅 '}${ev.title}`, snippet: bits.join(' · '), urgency: '' })
      setAdded(true)
      onRefresh?.()
    } finally { setBusy(false) }
  }
  return (
    <div className={'calRow' + (ev.holocall ? ' holocall' : '')}>
      <span className={'caltag ' + (ev.holocall ? 'holo' : 'sev-lo')}>{ev.holocall ? '📡 Holocall' : '📅 Invite'}</span>
      <span className="cust">{ev.title}</span>
      {!ev.allDay && ev.start && <span className="caldate">{fmtTime(ev.start)}</span>}
      {ev.conferenceUrl && <a className="linkBtn" href={ev.conferenceUrl} target="_blank" rel="noreferrer">Join ↗</a>}
      {ev.htmlLink && <a className="linkBtn" href={ev.htmlLink} target="_blank" rel="noreferrer">open ↗</a>}
      <button className="linkBtn" disabled={busy || added} onClick={addTask}>{added ? '✓ tasked' : '＋ task'}</button>
    </div>
  )
}

function ledgerKind(e) {
  switch (e.eventType) {
    case 'CUSTODY_OUT': return '⬆ out to warehouse'
    case 'CUSTODY_IN': return '⬇ back in hands'
    case 'CUSTODY_CLEARED': return 'custody closed'
    case 'REACHED_APPROVED': return 'cleared to ship'
    case 'SHIPPED_VALUE': return 'value logged'
    default: return e.eventType.toLowerCase().replace(/_/g, ' ')
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
function startOfWeek(ms) { const d = startOfDay(ms); return d - new Date(d).getDay() * DAY }
function startOfMonth(ms) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
function addMonths(ms, n) { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + n, 1) }
function fmtLong(ms) { return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }
function fmtTime(x) { return new Date(x).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
