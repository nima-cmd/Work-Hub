import { useState } from 'react'
import { SourceBadge } from '../lib.jsx'

const DAY = 86400000

// Agenda of upcoming deadlines (Ship dates and Cancel dates — cancel dates
// are "ship by or lose it", doubly important for EDI chargebacks), plus a
// month/week grid of orders that have actually shipped (a real IF-shipped
// event date, distinct from the target ship date the agenda watches) — and
// the quest-task activity journal (Nima, 2026-07-15: "we would also like
// these to show up in our calendar as well"), plotted on the day they happened.
export default function Calendar({ orders, activity = [] }) {
  return (
    <div className="calendar">
      <Agenda orders={orders} />
      <ShipGrid orders={orders} activity={activity} />
    </div>
  )
}

function Agenda({ orders }) {
  const today = startOfDay(Date.now())
  const weekEnd = today + 7 * DAY

  const events = []
  for (const o of orders) {
    if (o.shipDate) events.push(evt(o, o.shipDate, 'Ship'))
    if (o.cancelDate) events.push(evt(o, o.cancelDate, 'Cancel'))
  }
  events.sort((a, b) => a.t - b.t)

  const groups = { Overdue: [], Today: [], 'Next 7 days': [], Later: [] }
  for (const e of events) {
    if (e.day < today) groups.Overdue.push(e)
    else if (e.day === today) groups.Today.push(e)
    else if (e.day <= weekEnd) groups['Next 7 days'].push(e)
    else groups.Later.push(e)
  }

  const headClass = { Overdue: 'sev-hi', Today: 'sev-mid' }

  return (
    <>
      {Object.entries(groups).map(([label, list]) =>
        list.length ? (
          <section key={label} className="calGroup">
            <h3 className={'calHead ' + (headClass[label] || '')}>
              {label} <span className="count">{list.length}</span>
            </h3>
            {list.map((e, i) => (
              <div key={i} className={'calRow ' + (e.kind === 'Cancel' ? 'cancel' : '')}>
                <span className="caldate">{fmt(e.t)}</span>
                <span className={'caltag ' + (e.kind === 'Cancel' ? 'sev-hi' : 'sev-lo')}>
                  {e.kind}
                </span>
                <span className="so">{e.o.soNumber}</span>
                <span className="cust">{e.o.customer}</span>
                <SourceBadge source={e.o.source} />
              </div>
            ))}
          </section>
        ) : null,
      )}
    </>
  )
}

// Month/week grid of actual shipped-on dates, pulled from each order's
// fulfillments (only Shipped IFs carry an actualShipDate) — plus the
// quest-task activity journal, plotted on the day each entry happened.
function ShipGrid({ orders, activity = [] }) {
  const [mode, setMode] = useState('month') // 'month' | 'week'
  const [cursor, setCursor] = useState(() => startOfDay(Date.now()))
  const today = startOfDay(Date.now())

  const shipped = new Map() // day (ms) -> [{o, f}]
  for (const o of orders) {
    for (const f of o.fulfillments || []) {
      if (!f.actualShipDate) continue
      const day = startOfDay(f.actualShipDate)
      if (!shipped.has(day)) shipped.set(day, [])
      shipped.get(day).push({ o, f })
    }
  }

  const activityByDay = new Map() // day (ms) -> [activity entry]
  for (const a of activity) {
    const day = startOfDay(a.createdAt)
    if (!activityByDay.has(day)) activityByDay.set(day, [])
    activityByDay.get(day).push(a)
  }

  const gridStart =
    mode === 'week' ? startOfWeek(cursor) : startOfWeek(startOfMonth(cursor))
  const cellCount = mode === 'week' ? 7 : 42
  const days = Array.from({ length: cellCount }, (_, i) => gridStart + i * DAY)
  const curMonth = new Date(cursor).getMonth()

  const step = mode === 'week' ? 7 : null
  function go(dir) {
    setCursor((c) =>
      mode === 'week' ? c + dir * step * DAY : addMonths(c, dir).getTime(),
    )
  }

  return (
    <section className="shipCal">
      <div className="calNav">
        <button className="calNavBtn" onClick={() => go(-1)}>‹</button>
        <h3 className="calTitle">{label(mode, cursor)}</h3>
        <button className="calNavBtn" onClick={() => go(1)}>›</button>
        <button className="calToday" onClick={() => setCursor(today)}>Today</button>
        <div className="calModeToggle">
          <button className={mode === 'month' ? 'active' : ''} onClick={() => setMode('month')}>
            Month
          </button>
          <button className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>
            Week
          </button>
        </div>
      </div>
      <div className={'calGrid ' + (mode === 'week' ? 'calGridWeek' : '')}>
        {WEEKDAYS.map((w) => (
          <div key={w} className="calWeekday">{w}</div>
        ))}
        {days.map((day) => {
          const evts = shipped.get(day) || []
          const acts = activityByDay.get(day) || []
          const inMonth = mode === 'week' || new Date(day).getMonth() === curMonth
          return (
            <div
              key={day}
              className={
                'calCell' +
                (inMonth ? '' : ' calCell-dim') +
                (day === today ? ' calCell-today' : '')
              }
            >
              <div className="calDayNum">{new Date(day).getDate()}</div>
              {evts.slice(0, 3).map(({ o, f }, i) => (
                <div key={i} className="calEvt">
                  <span className="so">{o.soNumber}</span> {o.customer}
                  <SourceBadge source={o.source} />
                </div>
              ))}
              {evts.length > 3 && <div className="calEvtMore">+{evts.length - 3} more</div>}
              {acts.slice(0, 3).map((a) => (
                <div key={a.id} className="calEvt">
                  <span className="badge transmission">{a.kind.replace('_', ' ')}</span> {a.subject}
                </div>
              ))}
              {acts.length > 3 && <div className="calEvtMore">+{acts.length - 3} more</div>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function label(mode, cursor) {
  if (mode === 'week') {
    const start = startOfWeek(cursor)
    const end = start + 6 * DAY
    const sameMonth = new Date(start).getMonth() === new Date(end).getMonth()
    const fmtOpts = { month: 'short', day: 'numeric' }
    const startStr = new Date(start).toLocaleDateString(undefined, fmtOpts)
    const endStr = new Date(end).toLocaleDateString(
      undefined,
      sameMonth ? { day: 'numeric' } : fmtOpts,
    )
    return `${startStr} – ${endStr}, ${new Date(end).getFullYear()}`
  }
  return new Date(cursor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function evt(o, dateStr, kind) {
  const t = new Date(dateStr).getTime()
  return { o, kind, t, day: startOfDay(t) }
}
function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function startOfWeek(ms) {
  const d = startOfDay(ms)
  return d - new Date(d).getDay() * DAY
}
function startOfMonth(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}
function addMonths(ms, n) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}
function fmt(ms) {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}
