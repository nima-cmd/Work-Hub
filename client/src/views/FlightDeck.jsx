import { useEffect, useRef, useState } from 'react'
import { fetchLaunchBay, fetchCustodyRegister, fetchEdiReview, fetchCredits, fetchAffection, fetchQuestEmails } from '../api.js'
import { computeEdiWork } from '../../../src/model/ediWork.js'
import { computeRoute, DEFAULT_DURATIONS_MIN } from '../../../src/model/routePlan.js'
import { channelKey } from '../../../src/model/channels.js'
import { imagesFor } from '../data/characterImages.js'
import cockpitPlate from '../assets/flightdeck/cockpit-plate.png'

// Flight Deck (Nima, 2026-07-21) — the Falcon-cockpit command hub, v4 design.
// A second, switchable HUD: the classic Command tab is untouched. Composition:
// live hyperspace canvas BEHIND a 4K cockpit plate whose window panes were
// rendered as alpha cutouts (scripts/render-cockpit-plate.py), translucent
// glass panels floating ON the windscreen, the Ops Core ring dead center, and
// a working panel board below — the hyperdrive lever swaps hyperspace/sublight
// and the Viewport Systems switches power individual panels (both persist).

const PANELS = [
  { key: 'comms', label: 'Comms' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'route', label: 'Route' },
  { key: 'scan', label: 'Scan' },
  { key: 'cust', label: 'Custody' },
  { key: 'crew', label: 'Crew' },
  { key: 'edi', label: 'EDI' },
]
const PANEL_STORE = 'fd.panels'
const HYPER_STORE = 'fd.hyper'

function loadPanels() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_STORE))
    if (saved && typeof saved === 'object') return { ...Object.fromEntries(PANELS.map((p) => [p.key, true])), ...saved }
  } catch { /* fall through */ }
  return Object.fromEntries(PANELS.map((p) => [p.key, true]))
}

// ── the space outside: hyperspace streaks or sublight drift ──────────────────
function HyperspaceCanvas({ hyper }) {
  const ref = useRef(null)
  const hyperRef = useRef(hyper)
  hyperRef.current = hyper

  useEffect(() => {
    const c = ref.current
    const ctx = c.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let W, H, cx, cy, stars = [], raf = 0

    function size() {
      const r = c.getBoundingClientRect()
      W = c.width = Math.max(1, r.width * dpr)
      H = c.height = Math.max(1, r.height * dpr)
      // vanishing point sits on the canopy hub of the plate render
      cx = W * 0.47; cy = H * 0.44
    }
    function reset(s) {
      s.a = Math.random() * Math.PI * 2
      s.r = Math.random() * 40 * dpr
      s.sp = (Math.random() * 2.2 + 1.4) * dpr
      s.dx = (Math.random() - 0.5) * 0.16 * dpr
      s.x = Math.random() * W; s.y = Math.random() * H
      s.tw = Math.random() * Math.PI * 2
    }
    function init() {
      stars = []
      const n = Math.min(320, Math.floor(W / 4))
      for (let i = 0; i < n; i++) {
        const s = {}; reset(s); s.r = Math.random() * Math.max(W, H)
        stars.push(s)
      }
    }
    function frame() {
      if (hyperRef.current) {
        ctx.fillStyle = 'rgba(2,4,10,0.30)'; ctx.fillRect(0, 0, W, H)
        for (const s of stars) {
          const x = cx + Math.cos(s.a) * s.r, y = cy + Math.sin(s.a) * s.r
          s.r += s.sp; s.sp *= 1.05
          const ln = s.sp * 1.8
          const x2 = cx + Math.cos(s.a) * (s.r - ln), y2 = cy + Math.sin(s.a) * (s.r - ln)
          const e = Math.min(1, s.r / (Math.max(W, H) * 0.6))
          ctx.strokeStyle = `rgba(${110 + e * 145 | 0},${200 + e * 55 | 0},255,${Math.min(1, 0.22 + e)})`
          ctx.lineWidth = Math.max(0.6, e * 2.6) * dpr
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke()
          if (x < -30 || x > W + 30 || y < -30 || y > H + 30) { reset(s); s.r = Math.random() * 30 * dpr }
        }
      } else {
        ctx.fillStyle = '#02040a'; ctx.fillRect(0, 0, W, H)
        for (const s of stars) {
          s.x += s.dx; if (s.x < 0) s.x = W; if (s.x > W) s.x = 0
          s.tw += 0.02
          ctx.fillStyle = `rgba(190,222,255,${0.35 + 0.45 * Math.abs(Math.sin(s.tw))})`
          ctx.fillRect(s.x, s.y, 1.4 * dpr, 1.4 * dpr)
        }
      }
      raf = requestAnimationFrame(frame)
    }
    function still() {
      ctx.fillStyle = '#02040a'; ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = 'rgba(180,220,255,.7)'
      for (const s of stars) ctx.fillRect(s.x, s.y, 1.5 * dpr, 1.5 * dpr)
    }
    function onResize() { size(); init(); if (reduce) still() }

    size(); init()
    if (reduce) still(); else raf = requestAnimationFrame(frame)
    window.addEventListener('resize', onResize)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize) }
  }, [])

  return <canvas ref={ref} className="fdSpace" />
}

// Original simplified starbird (same emblem as the Command core).
function Starbird() {
  return (
    <svg className="fdInsignia" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 8 L58 34 A22 22 0 0 1 72 62 L88 84 A46 46 0 0 0 62 32 L50 8 L38 32 A46 46 0 0 0 12 84 L28 62 A22 22 0 0 1 42 34 Z" />
      <circle cx="50" cy="58" r="12" fill="none" strokeWidth="3" />
    </svg>
  )
}

function FdClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="fdT">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ageOf = (iso) => {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

// ── route planning: the demo script's deadline rules, run on live data ───────
// (scripts/plan-route-demo.js is the reference; keep the rules in sync)
function taskKind(t) {
  const k = (t.recurringKey || '') + ' ' + (t.subject || '')
  if (/weaver/i.test(k)) return 'weaver_sync'
  if (/csv|upload/i.test(k)) return 'csv_upload'
  if (String(t.instanceKey || '').startsWith('edi:')) return 'edi_route'
  return 'email_reply'
}

function buildRouteItems(orders, tasks, ediWork) {
  const now = Date.now()
  const at = (h) => { const d = new Date(now); d.setHours(h, 0, 0, 0); return d.getTime() }
  const NOON = at(12), THREE = at(15)
  const dur = (k) => DEFAULT_DURATIONS_MIN[k] ?? DEFAULT_DURATIONS_MIN.default
  const items = []

  // open quest_tasks — urgent → 3pm cutoff; the rest fill the gaps
  for (const t of tasks.filter((t) => t.status === 'open')) {
    const kind = taskKind(t)
    items.push({
      id: 'task-' + t.id, taskId: t.id, label: (t.subject || 'task').slice(0, 46), kind,
      deadline: t.urgency === 'hi' ? THREE : null,
      durationMin: dur(kind), priority: t.urgency === 'hi' ? 0 : t.urgency === 'mid' ? 2 : 4,
    })
  }

  // open EDI POs with a hard deadline today: Nordstrom routing by noon,
  // cancel-date passed → now, cancel-date soon → 3pm
  for (const o of (ediWork?.orders || []).filter((o) => !o.work.closed)) {
    const partner = (o.tradingPartner || '').toLowerCase()
    const short = (o.tradingPartner || '').replace(/\s*\(.*$/, '')
    let deadline = null, priority = 3
    if (partner.includes('nordstrom') && o.stageRank < 3) { deadline = NOON; priority = 1 }
    else if (o.work.cancelState === 'passed') { deadline = now; priority = 0 }
    else if (o.work.cancelState === 'soon') { deadline = THREE; priority = 1 }
    else continue
    items.push({
      id: 'edi-' + o.businessNumber, label: `${short} routing · PO ${o.businessNumber}`.slice(0, 46),
      group: `${short} routing`,
      kind: 'edi_route', deadline, durationMin: dur('edi_route'), priority,
    })
  }

  // boutique orders needing an invoice → by noon (invoice→payment→ship chain)
  for (const o of orders) {
    const needsInvoice = o.stage && !['SHIPPED', 'INVOICED', 'APPROVED_FOR_SHIPPING'].includes(o.stage)
    if (channelKey(o) === 'boutique' && needsInvoice && o.severity > 0) {
      items.push({
        id: 'inv-' + o.soNumber, label: `Invoice ${o.customer} · ${o.soNumber}`.slice(0, 46),
        group: 'Boutique invoicing',
        kind: 'invoice', deadline: NOON, durationMin: dur('invoice'), priority: 2,
      })
    }
  }
  return items
}

// the route panel shows LEGS: consecutive same-group waypoints collapse into
// one line ("Nordstrom routing ×26") — the mock's grouped view; the task
// panel keeps the per-item schedule
function routeLegs(route) {
  const legs = []
  for (const r of route) {
    const last = legs[legs.length - 1]
    if (r.group && last && last.group === r.group) {
      last.n += 1; last.end = r.end
      last.atRisk = last.atRisk || r.atRisk
      if (r.deadline) last.deadline = r.deadline
    } else {
      legs.push({ id: r.id, group: r.group, label: r.group || r.label, n: 1, start: r.start, end: r.end, deadline: r.deadline, atRisk: r.atRisk })
    }
  }
  return legs
}

// ── glass panel shell ─────────────────────────────────────────────────────────
function Glass({ id, on, className, head, headAccent, count, children }) {
  return (
    <div className={`fdG ${className}${on ? '' : ' off'}`} id={id}>
      <div className="fdGHead">◤ {head} <span className="b">{headAccent}</span>
        {count != null && <span className="n">{count}</span>}
      </div>
      {children}
    </div>
  )
}

// ── the deck ──────────────────────────────────────────────────────────────────
export default function FlightDeck({ orders, tasks = [], views = [], onNavigate = () => {}, onRefresh }) {
  const [bay, setBay] = useState(null)
  const [custody, setCustody] = useState(null)
  const [edi, setEdi] = useState(null)
  const [credits, setCredits] = useState(null)
  const [crew, setCrew] = useState([])
  const [emails, setEmails] = useState([])
  const [panels, setPanels] = useState(loadPanels)
  const [hyper, setHyper] = useState(() => localStorage.getItem(HYPER_STORE) !== '0')
  const [plan, setPlan] = useState(null)

  useEffect(() => {
    fetchLaunchBay().then(setBay).catch(() => setBay([]))
    fetchCustodyRegister().then(setCustody).catch(() => setCustody([]))
    fetchEdiReview().then(setEdi).catch(() => setEdi(null))
    fetchCredits().then(setCredits).catch(() => {})
    fetchAffection().then(setCrew).catch(() => {})
    fetchQuestEmails().then((r) => setEmails(r.emails || [])).catch(() => {})
  }, [])

  function togglePanel(key) {
    setPanels((p) => {
      const next = { ...p, [key]: !p[key] }
      localStorage.setItem(PANEL_STORE, JSON.stringify(next))
      return next
    })
  }
  function toggleHyper() {
    setHyper((h) => {
      localStorage.setItem(HYPER_STORE, h ? '0' : '1')
      return !h
    })
  }

  const ediWork = edi ? computeEdiWork(edi.orders || [], edi.resolutions || []) : null
  const partnerScan = ediWork
    ? ediWork.partners
        .map((p) => ({ ...p, health: p.missed > 0 || p.cancelDanger > 0 ? 'red' : p.issues > 0 ? 'amber' : 'green' }))
        .sort((a, b) => (b.health === 'red') - (a.health === 'red') || b.open - a.open)
    : null
  const openTasks = tasks.filter((t) => t.status === 'open')
  const attention = orders.filter((o) => o.severity > 0).length + openTasks.length
  const bayStats = bay && { cleared: bay.filter((s) => s.floating).length, delayed: bay.filter((s) => s.delayed).length }
  const unread = emails.filter((e) => e.isUnread).length
  const inbox = emails.filter((e) => !e.dismissed).sort((a, b) => (b.isUnread - a.isUnread)).slice(0, 3)
  const topCrew = [...crew].sort((a, b) => (b.affection || 0) - (a.affection || 0)).slice(0, 7)

  function planRoute() {
    setPlan(computeRoute(buildRouteItems(orders, openTasks, ediWork), { now: Date.now() }))
  }

  // task panel rows: the planned route once plotted, else open tasks by urgency
  const taskRows = plan
    ? plan.route.slice(0, 7)
    : [...openTasks]
        .sort((a, b) => (b.urgency === 'hi') - (a.urgency === 'hi') || (b.urgency === 'mid') - (a.urgency === 'mid'))
        .slice(0, 7)
        .map((t) => ({ id: 'task-' + t.id, label: (t.subject || 'task').slice(0, 46), atRisk: t.urgency === 'hi' }))

  return (
    <div className="flightDeck">
      <div className="fdStage">
        <HyperspaceCanvas hyper={hyper} />
        <img className="fdPlate" src={cockpitPlate} alt="" draggable="false" />

        {/* ── glass panels on the windscreen ── */}
        <Glass className="crew" on={panels.crew} head="Crew" headAccent="bonds">
          <div className="fdCrewRow">
            {topCrew.map((c) => {
              const img = imagesFor(c.characterId)[0]
              return (
                <button key={c.characterId} className="fdCrewChip" onClick={() => onNavigate('crew')}>
                  {img ? <img src={img} alt="" /> : <i>◈</i>}
                  <b>{c.character?.name?.split(' ')[0] || ''}</b>
                </button>
              )
            })}
          </div>
        </Glass>

        <Glass className="scan" on={panels.scan} head="Partner" headAccent="scan">
          {!partnerScan && <div className="fdEmpty">scanning…</div>}
          {partnerScan?.slice(0, 4).map((p) => (
            <button key={p.tradingPartner} className={'fdSrow h-' + p.health} onClick={() => onNavigate('edi')}>
              <span>{p.tradingPartner.replace(/\s*\(.*$/, '')}</span>
              <b>{p.open} open{p.health === 'red' ? ' · CRIT' : ''}</b>
            </button>
          ))}
        </Glass>

        <Glass className="cust" on={panels.cust} head="Custody" headAccent="register" count={custody?.length}>
          {!custody && <div className="fdEmpty">checking…</div>}
          {custody?.slice(0, 4).map((c) => (
            <button key={c.ifNumber} className="fdCrow" onClick={() => onNavigate('custody')}>
              <b>{c.ifNumber}</b>
              <span>{c.customer || 'unknown'}</span>
              <span className={'st ' + (c.stale ? 'stale' : c.state === 'with_warehouse' ? 'ware' : 'hand')}>
                {c.stale ? `STALE ${c.ageDays}d` : c.state === 'with_warehouse' ? 'AT WHSE' : 'IN HAND'}
              </span>
            </button>
          ))}
          {custody?.length === 0 && <div className="fdEmpty">register clear</div>}
        </Glass>

        <Glass className="route" on={panels.route} head="Hyperspace" headAccent="route">
          {!plan && <div className="fdEmpty">no route plotted — throw ◈ PLAN</div>}
          {plan && routeLegs(plan.route).slice(0, 6).map((r, i, arr) => (
            <div key={r.id} className={'fdWp' + (i === 0 ? ' now' : '') + (r.atRisk ? ' risk' : '')}>
              <i /><span>{i === 0 ? '▶ ' : ''}{r.label}{r.n > 1 ? ` ×${r.n}` : ''}</span>
              <em>{r.deadline ? `by ${hhmm(r.deadline)}` : hhmm(r.start)}</em>
            </div>
          ))}
          {plan && routeLegs(plan.route).length > 6 && <div className="fdEmpty">+ {routeLegs(plan.route).length - 6} more legs</div>}
        </Glass>

        <Glass className="comms" on={panels.comms} head="Comm" headAccent="relay" count={unread ? `${unread} unread` : emails.length}>
          {inbox.map((e) => (
            <button key={e.id} className="fdTx" onClick={() => onNavigate('transmissions')}>
              <div className="top">
                <span className="who">{e.character?.name || e.fromName || 'Unknown'}</span>
                <span className="age">{ageOf(e.receivedAt)}</span>
              </div>
              <div className="sub">{e.subject}</div>
            </button>
          ))}
          {!inbox.length && <div className="fdEmpty">relay silent</div>}
        </Glass>

        <Glass className="tasks" on={panels.tasks} head="Task" headAccent="command" count={openTasks.length}>
          {taskRows.map((r) => (
            <div key={r.id} className={'fdTask' + (r.seq === 1 ? ' now' : '') + (r.atRisk ? ' risk' : '')}>
              <span className="seq">{r.seq ? (r.seq === 1 ? '▶ ' : '') + hhmm(r.start) : '·'}</span>
              <span className="lab">{r.label}</span>
              <span className="slack">
                {r.slackMin != null ? (r.slackMin >= 0 ? `+${r.slackMin}m` : `${r.slackMin}m`) : r.atRisk ? '!' : '—'}
              </span>
            </div>
          ))}
          {!taskRows.length && <div className="fdEmpty">no open tasks — crew idle</div>}
          <button className="fdPlanBtn" onClick={planRoute}>◈ Plan hyperspace route</button>
        </Glass>

        {/* ── Ops Core — dead center ── */}
        <div className="fdCore">
          <div className="fdCoreClock"><FdClock /><button className="inc" onClick={() => onNavigate('transmissions')}>{unread} INCOMING ▸</button></div>
          <div className="fdRingBox">
            <div className="fdRing r1" /><div className="fdRing r2" /><div className="fdRing r3" />
            <Starbird />
            <div className="fdCoreMid">
              <span className="fdCoreLab">Naghedi Ops Core</span>
              <span className="fdCoreNum">{orders.length}</span>
              <span className="fdCoreSub">orders in pipeline</span>
            </div>
          </div>
          <div className="fdVitals">
            <span><b className="cv-r">{attention}</b> attn</span>
            {bayStats && <span><b className="cv-g">{bayStats.cleared}</b> cleared</span>}
            {bayStats?.delayed > 0 && <span><b className="cv-a">{bayStats.delayed}</b> delayed</span>}
            <span><b>{custody?.length ?? '—'}</b> custody</span>
            {credits && <span><b className="cv-a">{Math.round(credits.waiting).toLocaleString()}</b> CR wait</span>}
          </div>
        </div>

        <Glass className="edi" on={panels.edi} head="EDI" headAccent="relay"
               count={ediWork ? ediWork.totals.open + ediWork.totals.closed : undefined}>
          {ediWork && (
            <>
              <div className="fdEStats">
                <span className="e-open">{ediWork.totals.open} open</span>
                <span className="e-closed">{ediWork.totals.closed} closed</span>
                {ediWork.totals.missed > 0 && <span className="e-miss">{ediWork.totals.missed} missed?</span>}
              </div>
              {ediWork.partners.slice(0, 3).map((p) => (
                <button key={p.tradingPartner} className="fdErow" onClick={() => onNavigate('edi')}>
                  <b>{p.tradingPartner.replace(/\s*\(.*$/, '')}</b>
                  <span>{p.open} open · {p.closed} closed</span>
                </button>
              ))}
            </>
          )}
          {!ediWork && <div className="fdEmpty">reading the relay…</div>}
        </Glass>
      </div>

      {/* ── panel board ── */}
      <div className="fdDash">
        <div className="fdTabrow">
          {views.map((v) => (
            <button key={v.key} className={'fdTab' + (v.key === 'flight' ? ' on' : '')} onClick={() => onNavigate(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="fdControls">
          <label className="fdLever fdCGroup" title="Hyperdrive — drop to sublight or punch it">
            <input type="checkbox" checked={hyper} onChange={toggleHyper} />
            <span className="slot"><span className="knobL" /></span>
            <span className="fdCLab">Hyperdrive</span>
          </label>
          <div className="fdCGroup">
            <div className="fdBank">
              {PANELS.map((p) => (
                <label key={p.key} className="fdSw" title={`Power the ${p.label} panel`}>
                  <input type="checkbox" checked={!!panels[p.key]} onChange={() => togglePanel(p.key)} />
                  <span className="paddle" />
                  <span className="fdSwLab">{p.label}</span>
                </label>
              ))}
            </div>
            <span className="fdCLab">Viewport systems</span>
          </div>
          <div className="fdCGroup">
            <div className="fdKnobRow"><span className="fdKnob" /><span className="fdKnob k2" /></div>
            <span className="fdCLab">Aux</span>
          </div>
          <div className="fdCGroup">
            <button className="fdGuard" title="Re-sync all feeds" onClick={onRefresh}><i /></button>
            <span className="fdCLab">Sync</span>
          </div>
        </div>
        <div className="fdTicker">
          {plan ? (
            <>
              <span>route finishes <b className={plan.summary.atRisk ? 'crit' : 'good'}>{hhmm(plan.summary.finishesAt)}</b></span>
              <span><b>{plan.summary.totalMin}m</b> of work</span>
              {plan.summary.atRisk > 0
                ? <span><b className="crit">{plan.summary.atRisk}</b> miss their cutoff</span>
                : <span><b className="good">all waypoints on time</b></span>}
            </>
          ) : (
            <>
              <span>Nordstrom routing <b className="warn">by 12:00</b></span>
              <span>boutique invoicing <b className="warn">by 12:00</b></span>
              <span>urgent work <b className="crit">by 15:00</b></span>
              <span><b>{attention}</b> need attention</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
