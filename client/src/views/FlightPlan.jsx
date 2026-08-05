import { useEffect, useMemo, useState } from 'react'
import { fetchEdiReview, fetchDayPlan, reorderDayPlan, resetDayPlan, setPlanItemDone, setTaskSchedule, completeQuestTask, setTaskChecklistItem } from '../api.js'
import { computeEdiWork } from '../../../src/model/ediWork.js'
import { computeRoute } from '../../../src/model/routePlan.js'
import { buildRouteItems, applyDayPlan } from '../../../src/model/routeItems.js'
import FirstHour from './FirstHour.jsx'
import CatchUp from './CatchUp.jsx'
import { buildCatchUp } from '../../../src/model/catchUp.js'

// Daily Flight Plan (Nima, 2026-07-28) — the "flight route" for the day. The
// route engine (src/model/routePlan.js) and the live-data adapter
// (src/model/routeItems.js) both existed already; this promotes them out of the
// ephemeral Flight-Deck HUD into a real, front-and-centre schedule:
//   • every open task, EDI routing action and shippable order laid across the
//     9–5 day with projected clock times, ordered earliest-deadline-first;
//   • each leg flagged when it can't make its cutoff (at-risk);
//   • reorder by hand (↑/↓) → the day flips to MANUAL mode (order preserved,
//     times + at-risk recomputed so you see the cost); "auto" resets to EDF;
//   • check legs off (tasks complete the quest_task; EDI/ship legs are marked
//     done for the day in day_plan_item);
//   • nudge a task's estimate or set a real due-time inline.
// Persistence lives server-side (day_plan_item + quest_tasks.due_at/duration_min)
// so the plan is the same on the desktop and the phone PWA.

const KIND_GLYPH = {
  edi_route: '⇄', invoice: '$', ship: '➤', pack: '▣',
  // ⌖ matches the Ship Desk's "NEEDS A LABEL" lane — same work, same mark.
  label: '⌖', chase: '⧗', mark_packed: '▣', handoff: '⇥',
  weaver_sync: '⟲', csv_upload: '⬆', email_reply: '✉', planning: '◇', default: '◆',
}
const glyph = (k) => KIND_GLYPH[k] || KIND_GLYPH.default

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// combine today's date with an 'HH:MM' string → an ISO instant (local)
const timeToIso = (hhmmStr) => {
  if (!hhmmStr) return null
  const [h, m] = hhmmStr.split(':').map(Number)
  const d = new Date(); d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const isoToTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function FlightPlan({ orders = [], tasks = [], emails = [], labelGaps = null, onNavigate = () => {}, onRefresh }) {
  const [edi, setEdi] = useState(null)
  const [planRows, setPlanRows] = useState([])
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(null)
  const [busy, setBusy] = useState(false)
  const date = todayStr()

  const loadPlanRows = () => fetchDayPlan(date).then(setPlanRows).catch(() => setPlanRows([]))
  useEffect(() => {
    fetchEdiReview().then(setEdi).catch(() => setEdi(null))
    loadPlanRows()
  }, [])
  // keep clock times honest as the day moves (recompute each minute)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  const ediWork = useMemo(() => (edi ? computeEdiWork(edi.orders || [], edi.resolutions || []) : null), [edi])

  const { plan, doneItems, manualMode } = useMemo(() => {
    const items = buildRouteItems(orders, tasks, ediWork, { now, labelGaps })
    const { items: merged, manualMode } = applyDayPlan(items, planRows)
    const open = merged.filter((i) => !i.done)
    const done = merged.filter((i) => i.done)
    const plan = computeRoute(open, { now, preserveOrder: manualMode })
    return { plan, doneItems: done, manualMode }
  }, [orders, tasks, ediWork, labelGaps, planRows, now])

  const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

  async function move(index, dir) {
    const route = plan.route
    const j = index + dir
    if (j < 0 || j >= route.length) return
    const ids = route.map((r) => r.id)
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    setBusy(true)
    try { setPlanRows(await reorderDayPlan(date, ids)) } finally { setBusy(false) }
  }
  async function toAuto() {
    setBusy(true)
    try { setPlanRows(await resetDayPlan(date)) } finally { setBusy(false) }
  }
  async function check(item) {
    setBusy(true)
    try {
      if (item.taskId) { await completeQuestTask(item.taskId, true); onRefresh?.() }
      else { setPlanRows(await setPlanItemDone(date, item.id, true, item.label)) }
    } finally { setBusy(false) }
  }
  async function uncheck(item) {
    setBusy(true)
    try { setPlanRows(await setPlanItemDone(date, item.id, false, item.label)) }
    finally { setBusy(false) }
  }
  async function saveSchedule(taskId, patch) {
    setBusy(true)
    try { await setTaskSchedule(taskId, patch); onRefresh?.() } finally { setBusy(false) }
  }

  // The band's own data. Rhythms are lifted OUT of `plan` (routeItems.js), so
  // these two surfaces partition the work rather than double-counting it.
  const catchUp = useMemo(() => buildCatchUp(emails, tasks, { now }), [emails, tasks, now])

  async function completeRhythm(r) {
    setBusy(true)
    try { await completeQuestTask(r.id); onRefresh?.() } finally { setBusy(false) }
  }
  async function toggleRhythmStep(r, step, done) {
    setBusy(true)
    try { await setTaskChecklistItem(r.id, step.key, done); onRefresh?.() } finally { setBusy(false) }
  }

  const s = plan.summary
  const firstOpenIdx = plan.route.findIndex((r) => r.end > now)

  return (
    <div className="fpView">
      {/* Above the plan, never a gate on it: the unread inbox + today's
          rhythms, which the route deliberately doesn't carry (catchUp.js). */}
      <CatchUp
        catchUp={catchUp} onNavigate={onNavigate} busy={busy}
        onCompleteRhythm={completeRhythm} onToggleStep={toggleRhythmStep}
      />

      {/* One thing, then a few, then a count. Fed from the SAME route as the
          timeline below so the two can never disagree — see FirstHour.jsx. */}
      <FirstHour
        route={plan.route} summary={plan.summary} now={now}
        onNavigate={onNavigate} onCheck={check} busy={busy}
      />

      <header className="fpHead">
        <div className="fpTitle">
          <h2>◈ Today's Flight Plan</h2>
          <span className="fpDate">{new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
        </div>
        <div className="fpSummary">
          <span className="fpStat"><b>{s.count}</b> legs</span>
          <span className="fpStat"><b>{Math.round(s.totalMin / 6) / 10}h</b> of work</span>
          <span className="fpStat">finishes <b>{s.count ? hhmm(s.finishesAt) : '—'}</b></span>
          {s.atRisk > 0
            ? <span className="fpStat risk"><b>{s.atRisk}</b> won't make cutoff</span>
            : <span className="fpStat good">all on time</span>}
          <span className={'fpMode ' + (manualMode ? 'manual' : 'auto')} title={manualMode ? 'Hand-ordered — times recomputed against your sequence' : 'Auto: earliest deadline first'}>
            {manualMode ? '✋ manual order' : '⚡ auto (EDF)'}
          </span>
          {manualMode && <button className="fpBtnGhost" onClick={toAuto} disabled={busy}>reset to auto</button>}
        </div>
      </header>

      {!plan.route.length && (
        <div className="fpEmpty">
          {edi === null ? 'Plotting the route…' : 'Nothing on the route — the day is clear. ✦'}
        </div>
      )}

      <ol className="fpTimeline">
        {plan.route.map((r, i) => {
          const t = r.taskId ? taskById.get(r.taskId) : null
          const isNow = i === firstOpenIdx
          const open = expanded === r.id
          return (
            <li key={r.id} className={'fpLeg' + (r.atRisk ? ' risk' : '') + (isNow ? ' now' : '') + (r.end <= now ? ' past' : '')}>
              <div className="fpTime">
                <b>{hhmm(r.start)}</b>
                <span>{hhmm(r.end)}</span>
              </div>
              <button className="fpCheck" onClick={() => check(r)} disabled={busy} title="Mark done">○</button>
              <div className="fpBody" onClick={() => t && setExpanded(open ? null : r.id)}>
                <span className="fpGlyph" title={r.kind}>{glyph(r.kind)}</span>
                <span className="fpLabel">
                  {isNow ? '▶ ' : ''}{r.label}
                  {r.scheduled && <span className="fpPin" title="Has a set due-time">⏱</span>}
                  {/* Whose court: a leg we can't finish alone reads as theirs, so
                      an unmoved one isn't mistaken for a missed keystroke. */}
                  {r.courtTheirs && (
                    <span className="fpTheirs" title="Waiting on the warehouse — chasing is our part">their court</span>
                  )}
                </span>
                <span className="fpDeadline">
                  {r.deadline != null && <em className={r.atRisk ? 'risk' : ''}>by {hhmm(r.deadline)}</em>}
                  {r.slackMin != null && (
                    <span className={'fpSlack ' + (r.slackMin >= 0 ? 'ok' : 'bad')}>
                      {r.slackMin >= 0 ? `+${r.slackMin}m` : `${r.slackMin}m`}
                    </span>
                  )}
                </span>
              </div>
              <div className="fpReorder">
                <button onClick={() => move(i, -1)} disabled={busy || i === 0} title="Earlier">↑</button>
                <button onClick={() => move(i, 1)} disabled={busy || i === plan.route.length - 1} title="Later">↓</button>
              </div>
              {r.nav && !t && (
                <button className="fpGo" onClick={() => onNavigate(r.nav)} title="Open in its view">↗</button>
              )}

              {open && t && (
                <div className="fpExpand">
                  {t.snippet && <p className="fpSnippet">{t.snippet}</p>}
                  <div className="fpEditRow">
                    <label>Est. minutes
                      <input type="number" min="1" max="480" defaultValue={r.durationMin}
                             onBlur={(e) => { const v = Number(e.target.value); if (v && v !== r.durationMin) saveSchedule(t.id, { durationMin: v }) }} />
                    </label>
                    <label>Due today at
                      <input type="time" defaultValue={isoToTime(t.dueAt)}
                             onChange={(e) => saveSchedule(t.id, { dueAt: e.target.value ? timeToIso(e.target.value) : null })} />
                    </label>
                    <button className="fpBtnGhost" onClick={() => onNavigate('tasks')}>open in Tasks ↗</button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {doneItems.length > 0 && (
        <div className="fpDone">
          <div className="fpDoneHead">✓ done today <span>{doneItems.length}</span></div>
          {doneItems.map((d) => (
            <div key={d.id} className="fpDoneRow">
              <button className="fpCheck done" onClick={() => uncheck(d)} disabled={busy} title="Undo">✓</button>
              <span className="fpGlyph">{glyph(d.kind)}</span>
              <span className="fpLabel">{d.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
