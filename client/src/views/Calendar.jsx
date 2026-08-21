import { useEffect, useMemo, useState } from 'react'
import { NsLink } from '../lib.jsx'
import { useTraceDrawer } from '../traceDrawerContext.js'
import { fetchAgenda, fetchCalendarEvents, fetchLedgerDaily } from '../api.js'
import {
  AGENDA_META, byDay, weekDays, monthDays, isoDay, agendaSummary,
} from '../../../src/model/calendarAgenda.js'
import './calendar.css'

// Calendar — WHAT IS COMING, and what already happened (rebuilt 2026-08-21).
//
// Nima: "the dots mean nothing to me really and not working and i was hoping for the
// calendar to give me more of a view of what is upcoming in terms of work that we need
// to do. right now the view is just a calendar with dots and a date." And on shape:
// "two tabbed version perhaps one looking forward one to review the past" — plus month,
// week AND day, "so we have more room to put more than the dots".
//
// ⚠️ HE WAS RIGHT AND IT WAS NOT A DESIGN PROBLEM. The old grid plotted
// `orders.ship_date` and `orders.cancel_date`: cancel_date is NULL on all 121 unshipped
// orders and ALL 121 ship_dates are the NetSuite trandate+28 default. The dots meant
// nothing because they were nothing. Everything here comes from /api/agenda, which
// reads the columns that are actually populated and says so on the response.
//
// The rules — what counts, how it groups, forward vs review — are in
// src/model/calendarAgenda.js, tested. This file is the drawing.

const VIEWS = [
  { key: 'month', label: 'Month' },
  { key: 'week', label: 'Week' },
  { key: 'day', label: 'Day' },
]

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const fmtMonth = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
const dayNum = (iso) => Number(iso.slice(8, 10))

function shiftMonth(iso, by) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + by)
  return isoDay(d)
}
function shiftDays(iso, by) {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return isoDay(d)
}

// One agenda entry. The count leads, because a count is the thing he asked for — "the
// number of boutiques about to close" — and the documents ride underneath so any one of
// them opens its data packet, which he called the most important version of any
// information.
function Entry({ e, open, onToggle, drawer }) {
  const meta = AGENDA_META[e.kind] || {}
  return (
    <div className={`calEntry tone-${e.tone}${e.overdue ? ' calOverdue' : ''}`}>
      <button className="calEntryTop" onClick={onToggle}>
        <span className="calEntryCount">{e.count}</span>
        <span className="calEntryBody">
          <span className="calEntryLabel">{meta.label || e.kind}</span>
          <span className="calEntryHead">{e.headline}</span>
        </span>
        {e.overdue && <span className="calLate">{-e.inDays}d late</span>}
      </button>
      {open && !!e.items?.length && (
        <div className="calItems">
          {e.items.slice(0, 24).map((it) => (
            <span key={`${it.docType}:${it.docNumber}`} className="calItem">
              {/* THEIR_PO and PO are not traceable subjects, so NsLink degrades to the
                  NetSuite link or plain text rather than offering a dead hop. */}
              <NsLink doc={it.docNumber} />
              {it.label && <span className="calItemLabel">{it.label}</span>}
            </span>
          ))}
          {e.items.length > 24 && <span className="calItemLabel">+{e.items.length - 24} more</span>}
        </div>
      )}
    </div>
  )
}

export default function Calendar() {
  const [tab, setTab] = useState('forward')      // forward | review
  const [grain, setGrain] = useState('month')
  const [anchor, setAnchor] = useState(isoDay(new Date()))
  const [agenda, setAgenda] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [cal, setCal] = useState({ configured: false, events: [] })
  const [ledger, setLedger] = useState(new Map())
  const drawer = useTraceDrawer()

  useEffect(() => {
    fetchAgenda().then(setAgenda).catch(() => setAgenda({ forward: [], past: [], summary: null }))
    fetchCalendarEvents().then(setCal).catch(() => {})
    fetchLedgerDaily().then((rows) => setLedger(new Map(rows.map((r) => [r.day, r])))).catch(() => {})
  }, [])

  const entries = useMemo(
    () => (tab === 'forward' ? agenda?.forward : agenda?.past) || [],
    [agenda, tab],
  )
  const index = useMemo(() => byDay(entries), [entries])
  const summary = useMemo(() => agendaSummary(entries), [entries])

  const days = useMemo(() => {
    if (grain === 'day') return [anchor]
    if (grain === 'week') return weekDays(anchor)
    return monthDays(anchor)
  }, [grain, anchor])

  if (!agenda) return <div className="banner">Reading the agenda…</div>

  const todayIso = isoDay(new Date())
  const step = (by) => setAnchor(grain === 'month' ? shiftMonth(anchor, by) : shiftDays(anchor, grain === 'week' ? by * 7 : by))
  const title = grain === 'month' ? fmtMonth(anchor)
    : grain === 'week' ? `${fmtDay(days[0])} – ${fmtDay(days[6])}`
      : fmtDay(anchor)

  return (
    <div className="calWrap">
      <div className="calHead">
        <div className="calTabs">
          {/* His structure: one looking forward, one to review the past. */}
          <button className={'calTab' + (tab === 'forward' ? ' on' : '')} onClick={() => setTab('forward')}>
            What's coming <span className="calTabN">{agenda.forward.length}</span>
          </button>
          <button className={'calTab' + (tab === 'review' ? ' on' : '')} onClick={() => setTab('review')}>
            Review <span className="calTabN">{agenda.past.length}</span>
          </button>
        </div>
        <div className="calGrains">
          {VIEWS.map((v) => (
            <button key={v.key} className={'btnGhost' + (grain === v.key ? ' btnOn' : '')}
                    onClick={() => setGrain(v.key)}>{v.label}</button>
          ))}
        </div>
      </div>

      <div className="calBar">
        <button className="btnGhost" onClick={() => step(-1)}>←</button>
        <span className="calTitle">{title}</span>
        <button className="btnGhost" onClick={() => step(1)}>→</button>
        <button className="btnGhost" onClick={() => setAnchor(todayIso)}>Today</button>
        {tab === 'forward' && (
          <span className="calSummary">
            {summary.overdue > 0 && <b className="calLate">{summary.overdue} overdue</b>}
            {summary.today > 0 && <span> · {summary.today} today</span>}
            <span> · {summary.next7} in the next 7 days</span>
          </span>
        )}
      </div>

      {/* ── Month and week: a grid whose cells carry the work, not dots ─────── */}
      {grain !== 'day' && (
        <div className={`calGrid calGrid-${grain}`}>
          {WD.map((d) => <div key={d} className="calWd">{d}</div>)}
          {days.map((iso) => {
            const list = index.get(iso) || [];
            const outside = grain === 'month' && iso.slice(0, 7) !== anchor.slice(0, 7)
            return (
              <div key={iso}
                   className={'calCell' + (iso === todayIso ? ' calToday' : '') + (outside ? ' calOutside' : '')}
                   onDoubleClick={() => { setAnchor(iso); setGrain('day') }}>
                <div className="calCellTop">
                  <span className="calCellNum">{dayNum(iso)}</span>
                  {!!list.length && <span className="calCellN">{list.length}</span>}
                </div>
                {list.map((e) => (
                  <Entry key={e.id} e={e} drawer={drawer}
                         open={openId === e.id}
                         onToggle={() => setOpenId(openId === e.id ? null : e.id)} />
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Day: one date, everything on it ────────────────────────────────── */}
      {grain === 'day' && (
        <div className="calDay">
          <div className="calDayMain">
            {!(index.get(anchor) || []).length && (
              <div className="empty">
                Nothing dated on {fmtDay(anchor)}
                {tab === 'forward' ? ' — and that is the honest answer, not a loading state.' : '.'}
              </div>
            )}
            {(index.get(anchor) || []).map((e) => (
              <Entry key={e.id} e={e} drawer={drawer} open onToggle={() => {}} />
            ))}
          </div>
          <div className="calDaySide">
            {/* Invites, when Google is connected. Not work — context. */}
            {!!(cal.events || []).filter((ev) => isoDay(ev.start) === anchor).length && (
              <div className="calSideBlock">
                <div className="calSideTitle">Calendar invites</div>
                {(cal.events || []).filter((ev) => isoDay(ev.start) === anchor).map((ev) => (
                  <div key={ev.id || ev.summary} className="calInvite">{ev.summary}</div>
                ))}
              </div>
            )}
            {ledger.get(anchor) && (
              <div className="calSideBlock">
                <div className="calSideTitle">Ledger that day</div>
                <div className="calLedgerN">{ledger.get(anchor).total} events recorded</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ⚠️ Says where the numbers came from. The field this replaced was fabricated and
          nothing on screen admitted it. */}
      {agenda.sources && (
        <details className="calSources">
          <summary>Where these dates come from</summary>
          <ul>
            {Object.entries(agenda.sources).map(([k, v]) => (
              <li key={k}><b>{k}</b> — {v}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
