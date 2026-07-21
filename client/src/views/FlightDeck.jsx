import { useEffect, useRef, useState } from 'react'
import { fetchLaunchBay, fetchCustodyRegister, fetchEdiReview, fetchCredits, fetchAffection, fetchQuestEmails, importCsv } from '../api.js'
import { computeEdiWork } from '../../../src/model/ediWork.js'
import { computeRoute, DEFAULT_DURATIONS_MIN } from '../../../src/model/routePlan.js'
import { channelKey } from '../../../src/model/channels.js'
import { imagesFor } from '../data/characterImages.js'
import consoleStrip from '../assets/flightdeck/console-strip.png'

// Flight Deck v6 (Nima, 2026-07-21) — the settled composition:
// - VIEWPORT: the drawn SVG canopy (hub + arch band + three big panes) as pure
//   glass over the hyperspace canvas. Only flight things live on the glass:
//   the hyperspace-route waypoints, the crew band, and the Ops Core in the hub.
// - CONSOLE: the 3D-rendered Falcon console (cropped from the round-1 plate)
//   returns as the physical dash, carrying the working buttons (hyperdrive,
//   CSV import, sync, per-monitor power), two inset screens (EDI relay +
//   system status) and the route computer.
// - MONITORS: the data lives on side-wall monitor screens — slightly angled
//   toward the pilot (nothing tilted much), never overlapping the viewport,
//   scrollable when content runs long. Comms (port) and Tasks (starboard) are
//   the big ones; custody and partner scan sit beneath them. Every
//   transmission/task row shows its character.
// The panel board below the stage is unchanged.
//
// Geometry: everything lives in one 2000x900 "scene" that scales uniformly
// (cover, anchored bottom-center) so all parts stay registered at any window
// size. Hub center: (1000, 520).

const PANELS = [
  { key: 'comms', label: 'Comms' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'route', label: 'Route' },
  { key: 'scan', label: 'Scan' },
  { key: 'cust', label: 'Custody' },
  { key: 'crew', label: 'Crew' },
  { key: 'core', label: 'Core' },
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

// ── scene geometry (SVG canopy frame) ────────────────────────────────────────
const CX = 1000, CY = 520
const rad = (d) => (d * Math.PI) / 180
const px = (r, a) => CX + r * Math.cos(rad(a))
const py = (r, a) => CY - r * Math.sin(rad(a))
const pt = (r, a) => `${px(r, a).toFixed(1)},${py(r, a).toFixed(1)}`
function sector(r0, r1, a0, a1) {
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  return `M${pt(r0, a0)} L${pt(r1, a0)} A${r1},${r1} 0 ${large} 0 ${pt(r1, a1)} L${pt(r0, a1)} A${r0},${r0} 0 ${large} 1 ${pt(r0, a0)} Z`
}

const OUTER_A = [150, 105, 75, 30]                 // three big panes
const INNER_A = [160, 135, 110, 90, 70, 45, 20]    // arch-band spokes
const R_HUB = 140, R_BAND0 = 180, R_BAND1 = 280, R_OUT0 = 320, R_OUT1 = 860

function CockpitFrame() {
  const outerPanes = OUTER_A.slice(0, -1).map((a, i) => sector(R_OUT0, R_OUT1, OUTER_A[i + 1], a))
  const bandPanes = INNER_A.slice(0, -1).map((a, i) => sector(R_BAND0, R_BAND1, INNER_A[i + 1], a))
  return (
    <svg className="fdSvg" viewBox="0 0 2000 900" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <radialGradient id="fdHubGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="rgba(92,216,255,0.10)" /><stop offset="1" stopColor="transparent" />
        </radialGradient>
      </defs>

      {/* glass panes — a light polarized tint; the top pane hosts the route HUD */}
      {outerPanes.map((d, i) => (
        <path key={'o' + i} d={d} fill={i === 1 ? 'rgba(2,8,16,0.42)' : 'rgba(3,10,20,0.18)'} />
      ))}
      {bandPanes.map((d, i) => <path key={'b' + i} d={d} fill="rgba(2,8,16,0.42)" />)}
      <circle cx={CX} cy={CY} r={R_HUB} fill="rgba(2,8,16,0.55)" />
      <circle cx={CX} cy={CY} r={R_HUB} fill="url(#fdHubGlow)" />

      {/* glass glare streaks */}
      <polygon points="480,120 600,95 900,420 800,460" fill="rgba(210,235,255,0.035)" />
      <polygon points="1420,90 1530,120 1250,430 1160,395" fill="rgba(210,235,255,0.028)" />

      {/* frame */}
      <circle cx={CX} cy={CY} r={R_HUB} fill="none" stroke="#141b25" strokeWidth="40" />
      <circle cx={CX} cy={CY} r={R_HUB} fill="none" stroke="#39485c" strokeWidth="3" />
      <circle cx={CX} cy={CY} r={R_BAND0} fill="none" stroke="#161e29" strokeWidth="28" />
      <circle cx={CX} cy={CY} r={R_BAND0} fill="none" stroke="#334052" strokeWidth="2.5" />
      <circle cx={CX} cy={CY} r={R_BAND1} fill="none" stroke="#161e29" strokeWidth="34" />
      <circle cx={CX} cy={CY} r={R_BAND1 + 6} fill="none" stroke="#334052" strokeWidth="2.5" />
      <path d={sector(R_BAND1 + 13, R_OUT0, OUTER_A[OUTER_A.length - 1], OUTER_A[0])} fill="#161e29" />
      <path d={sector(R_OUT0 - 4, R_OUT0, OUTER_A[OUTER_A.length - 1], OUTER_A[0])} fill="#2c3949" />
      {INNER_A.map((a) => (
        <line key={'is' + a} x1={px(R_BAND0, a)} y1={py(R_BAND0, a)} x2={px(R_BAND1, a)} y2={py(R_BAND1, a)}
              stroke="#161e29" strokeWidth="22" />
      ))}
      {OUTER_A.map((a) => (
        <g key={'os' + a}>
          <line x1={px(R_OUT0, a)} y1={py(R_OUT0, a)} x2={px(R_OUT1, a)} y2={py(R_OUT1, a)} stroke="#141b25" strokeWidth="52" />
          <line x1={px(R_OUT0, a)} y1={py(R_OUT0, a)} x2={px(R_OUT1, a)} y2={py(R_OUT1, a)} stroke="#323f50" strokeWidth="4" />
        </g>
      ))}
      {[105, 75].map((a) => (
        <line key={'hs' + a} x1={px(R_HUB, a)} y1={py(R_HUB, a)} x2={px(R_BAND0, a)} y2={py(R_BAND0, a)}
              stroke="#161e29" strokeWidth="18" />
      ))}

      {/* hull beyond the canopy rim */}
      <path d={`M0,0 H2000 V900 H0 Z M${pt(R_OUT1, 0)} A${R_OUT1},${R_OUT1} 0 1 0 ${pt(R_OUT1, 180)} A${R_OUT1},${R_OUT1} 0 1 0 ${pt(R_OUT1, 0)} Z`}
            fill="#070b11" fillRule="evenodd" />
      <circle cx={CX} cy={CY} r={R_OUT1} fill="none" stroke="#101722" strokeWidth="64" />
      <circle cx={CX} cy={CY} r={R_OUT1 - 24} fill="none" stroke="#2c3949" strokeWidth="3" />
    </svg>
  )
}

// ── the space outside ─────────────────────────────────────────────────────────
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
      // vanishing point = canopy hub (scene 1000,520 of 2000x900, cover-scaled
      // bottom-anchored — same math as .fdScene)
      const k = Math.max(r.width / 2000, r.height / 900)
      cx = W / 2
      cy = (r.height - 380 * k) * dpr
    }
    function reset(s) {
      s.a = Math.random() * Math.PI * 2
      s.r = Math.random() * 40 * dpr
      s.sp = (Math.random() * 2.4 + 1.6) * dpr
      s.dx = (Math.random() - 0.5) * 0.16 * dpr
      s.x = Math.random() * W; s.y = Math.random() * H
      s.tw = Math.random() * Math.PI * 2
    }
    function init() {
      stars = []
      const n = Math.min(420, Math.floor(W / 3))
      for (let i = 0; i < n; i++) {
        const s = {}; reset(s); s.r = Math.random() * Math.max(W, H)
        stars.push(s)
      }
    }
    function glow() {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.55)
      g.addColorStop(0, 'rgba(60,110,255,0.32)')
      g.addColorStop(0.45, 'rgba(40,80,220,0.12)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
    }
    function frame() {
      if (hyperRef.current) {
        ctx.fillStyle = 'rgba(2,4,12,0.32)'; ctx.fillRect(0, 0, W, H)
        glow()
        for (const s of stars) {
          const x = cx + Math.cos(s.a) * s.r, y = cy + Math.sin(s.a) * s.r
          s.r += s.sp; s.sp *= 1.05
          const ln = s.sp * 1.9
          const x2 = cx + Math.cos(s.a) * (s.r - ln), y2 = cy + Math.sin(s.a) * (s.r - ln)
          const e = Math.min(1, s.r / (Math.max(W, H) * 0.6))
          ctx.strokeStyle = `rgba(${140 + e * 115 | 0},${205 + e * 50 | 0},255,${Math.min(1, 0.30 + e)})`
          ctx.lineWidth = Math.max(0.7, e * 3.2) * dpr
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

function Starbird() {
  return (
    <svg className="fdInsignia" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 8 L58 34 A22 22 0 0 1 72 62 L88 84 A46 46 0 0 0 62 32 L50 8 L38 32 A46 46 0 0 0 12 84 L28 62 A22 22 0 0 1 42 34 Z" />
      <circle cx="50" cy="58" r="12" fill="none" strokeWidth="3" />
    </svg>
  )
}

function FdClock({ withDate }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <>
      <b>{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</b>
      {withDate && <span>{now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>}
    </>
  )
}

function Face({ characterId, size = 24 }) {
  const img = imagesFor(characterId || '')[0]
  return img
    ? <img className="fdFace" style={{ width: size, height: size }} src={img} alt="" />
    : <span className="fdFace fdFaceGlyph" style={{ width: size, height: size, fontSize: size * 0.5 }}>◈</span>
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const ageOf = (iso) => {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  return `${Math.floor(m / 1440)}d`
}

// ── route planning: the demo script's deadline rules on live data ────────────
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

  for (const t of tasks.filter((t) => t.status === 'open')) {
    const kind = taskKind(t)
    items.push({
      id: 'task-' + t.id, taskId: t.id, label: (t.subject || 'task').slice(0, 46), kind,
      deadline: t.urgency === 'hi' ? THREE : null,
      durationMin: dur(kind), priority: t.urgency === 'hi' ? 0 : t.urgency === 'mid' ? 2 : 4,
    })
  }

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

// consecutive same-group waypoints collapse into one leg ("Nordstrom routing ×26")
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

// crew chips along the inner arch band (scene px)
const CREW_ANGLES = [142, 118, 97, 83, 62, 38]
const CREW_R = 230

// a side-wall monitor: bezeled screen, powered by the console buttons,
// scrollable body when content runs long
function Monitor({ on, className, head, headAccent, count, bodyHeight, children }) {
  return (
    <div className={`fdMon ${className}${on ? '' : ' mOff'}`}>
      <div className="monHead">◤ {head} <span className="b">{headAccent}</span>
        {count != null && <span className="n">{count}</span>}
      </div>
      {on
        ? <div className="monBody" style={bodyHeight ? { maxHeight: bodyHeight } : undefined}>{children}</div>
        : <div className="monOffline">— display offline —</div>}
    </div>
  )
}

// ── the deck ──────────────────────────────────────────────────────────────────
export default function FlightDeck({ orders, tasks = [], views = [], onNavigate = () => {}, onRefresh }) {
  const stageRef = useRef(null)
  const [k, setK] = useState(1)
  const [bay, setBay] = useState(null)
  const [custody, setCustody] = useState(null)
  const [edi, setEdi] = useState(null)
  const [credits, setCredits] = useState(null)
  const [crew, setCrew] = useState([])
  const [emails, setEmails] = useState([])
  const [panels, setPanels] = useState(loadPanels)
  const [hyper, setHyper] = useState(() => localStorage.getItem(HYPER_STORE) !== '0')
  const [plan, setPlan] = useState(null)
  const [busyCsv, setBusyCsv] = useState(false)

  function loadAll() {
    fetchLaunchBay().then(setBay).catch(() => setBay([]))
    fetchCustodyRegister().then(setCustody).catch(() => setCustody([]))
    fetchEdiReview().then(setEdi).catch(() => setEdi(null))
    fetchCredits().then(setCredits).catch(() => {})
    fetchAffection().then(setCrew).catch(() => {})
    fetchQuestEmails().then((r) => setEmails(r.emails || [])).catch(() => {})
  }
  useEffect(loadAll, [])

  // uniform cover scale for the 2000x900 scene, anchored bottom-center
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setK(Math.max(r.width / 2000, r.height / 900))
    })
    ro.observe(el)
    return () => ro.disconnect()
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
  function syncAll() { loadAll(); onRefresh?.() }
  async function onCsvPick(e) {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    setBusyCsv(true)
    try { await importCsv(files); syncAll() } finally { setBusyCsv(false) }
  }

  const ediWork = edi ? computeEdiWork(edi.orders || [], edi.resolutions || []) : null
  const partnerScan = ediWork
    ? ediWork.partners
        .map((p) => ({ ...p, health: p.missed > 0 || p.cancelDanger > 0 ? 'red' : p.issues > 0 ? 'amber' : 'green' }))
        .sort((a, b) => (b.health === 'red') - (a.health === 'red') || b.open - a.open)
    : null
  const openTasks = tasks.filter((t) => t.status === 'open')
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const attention = orders.filter((o) => o.severity > 0).length + openTasks.length
  const bayStats = bay && { cleared: bay.filter((s) => s.floating).length, delayed: bay.filter((s) => s.delayed).length }
  const unread = emails.filter((e) => e.isUnread).length
  const inbox = emails.filter((e) => !e.dismissed).sort((a, b) => (b.isUnread - a.isUnread)).slice(0, 14)
  const topCrew = [...crew].sort((a, b) => (b.affection || 0) - (a.affection || 0)).slice(0, CREW_ANGLES.length)

  function planRoute() {
    setPlan(computeRoute(buildRouteItems(orders, openTasks, ediWork), { now: Date.now() }))
  }

  const taskRows = plan
    ? plan.route
    : [...openTasks]
        .sort((a, b) => (b.urgency === 'hi') - (a.urgency === 'hi') || (b.urgency === 'mid') - (a.urgency === 'mid'))
        .map((t) => ({ id: 'task-' + t.id, taskId: t.id, label: (t.subject || 'task').slice(0, 46), atRisk: t.urgency === 'hi' }))

  return (
    <div className="flightDeck">
      <div className="fdStage" ref={stageRef}>
        <HyperspaceCanvas hyper={hyper} />

        <div className="fdScene" style={{ transform: `translateX(-50%) scale(${k})` }}>
          <CockpitFrame />

          {/* ── on the glass: only flight things ── */}
          <div className={'fdHud fd-route' + (panels.route ? '' : ' off')}>
            <div className="fdHudHead">◤ Hyperspace <span className="b">route</span></div>
            {!plan && <div className="fdDim">no route plotted — hit ◈ PLAN on the console</div>}
            {plan && routeLegs(plan.route).slice(0, 5).map((r, i) => (
              <div key={r.id} className={'fdWp' + (i === 0 ? ' now' : '') + (r.atRisk ? ' risk' : '')}>
                <i /><span>{i === 0 ? '▶ ' : ''}{r.label}{r.n > 1 ? ` ×${r.n}` : ''}</span>
                <em>{r.deadline ? `by ${hhmm(r.deadline)}` : hhmm(r.start)}</em>
              </div>
            ))}
            {plan && routeLegs(plan.route).length > 5 && <div className="fdDim">+ {routeLegs(plan.route).length - 5} more legs</div>}
          </div>

          {panels.crew && topCrew.map((c, i) => {
            const a = CREW_ANGLES[i]
            return (
              <button key={c.characterId} className="fdCrewChip"
                      style={{ left: px(CREW_R, a), top: py(CREW_R, a) }}
                      onClick={() => onNavigate('crew')}
                      title={`${c.character?.name || ''} · ${c.level?.name || ''}`}>
                <Face characterId={c.characterId} size={42} />
                <b>{c.character?.name?.split(' ')[0] || ''}</b>
              </button>
            )
          })}

          <div className={'fdCore' + (panels.core ? '' : ' off')}>
            <div className="fdRing r1" /><div className="fdRing r2" /><div className="fdRing r3" />
            <Starbird />
            <div className="fdCoreMid">
              <span className="fdCoreClock"><FdClock /></span>
              <span className="fdCoreNum">{orders.length}</span>
              <span className="fdCoreSub">orders in pipeline</span>
              <button className="fdCoreInc" onClick={() => onNavigate('transmissions')}>{unread} incoming ▸</button>
            </div>
          </div>

          {/* ── the 3D console (round-1 render) with its working controls ── */}
          <div className="fdConsole">
            <img src={consoleStrip} alt="" draggable="false" />
            <div className="fdConsoleFade" />
          </div>

          <div className="fdBtns left">
            <button className={'fdCBtn' + (hyper ? ' lit' : '')} onClick={toggleHyper}>
              <i /><span>Hyper</span>
            </button>
            <label className={'fdCBtn' + (busyCsv ? ' lit blink' : '')} title="Import NetSuite saved-search CSVs">
              <input type="file" accept=".csv" multiple onChange={onCsvPick} />
              <i /><span>{busyCsv ? '…' : 'CSV'}</span>
            </label>
            <button className="fdCBtn" onClick={syncAll} title="Re-sync all feeds">
              <i /><span>Sync</span>
            </button>
          </div>

          <div className="fdBtns right">
            {PANELS.map((p) => (
              <button key={p.key} className={'fdCBtn sm' + (panels[p.key] ? ' lit' : '')}
                      onClick={() => togglePanel(p.key)} title={`Power the ${p.label} display`}>
                <i /><span>{p.label}</span>
              </button>
            ))}
          </div>

          <div className="fdScreen left">
            <div className="scrHead">◤ EDI RELAY {ediWork && <span className="n">{ediWork.totals.open + ediWork.totals.closed}</span>}</div>
            {ediWork ? (
              <>
                <div className="scrStats">
                  <span className="e-open">{ediWork.totals.open} open</span>
                  <span className="e-closed">{ediWork.totals.closed} closed</span>
                  {ediWork.totals.missed > 0 && <span className="e-miss">{ediWork.totals.missed} missed?</span>}
                </div>
                {ediWork.partners.slice(0, 2).map((p) => (
                  <button key={p.tradingPartner} className="scrRow" onClick={() => onNavigate('edi')}>
                    <b>{p.tradingPartner.replace(/\s*\(.*$/, '')}</b>
                    <span>{p.open} open · {p.closed} closed</span>
                  </button>
                ))}
              </>
            ) : <div className="fdDim">reading…</div>}
          </div>

          <div className="fdScreen right">
            <div className="scrHead">◤ SYSTEM STATUS <span className="scrClock"><FdClock withDate /></span></div>
            <div className="scrGrid">
              <span className={attention ? 'bad' : ''}><b>{attention}</b> attention</span>
              {bayStats && <span className="ok"><b>{bayStats.cleared}</b> cleared</span>}
              {bayStats?.delayed > 0 && <span className="bad"><b>{bayStats.delayed}</b> delayed</span>}
              <span><b>{custody?.length ?? '—'}</b> custody</span>
              {credits && <span className="amber"><b>{Math.round(credits.waiting).toLocaleString()}</b> CR wait</span>}
              <span><b>{unread}</b> unread comms</span>
            </div>
          </div>

          <div className="fdPedestal">
            <button className="fdPlanBtn" onClick={planRoute}>◈ Plan route</button>
            {plan && (
              <div className="fdPlanSum">
                fin {hhmm(plan.summary.finishesAt)}
                {plan.summary.atRisk > 0 ? <b className="crit"> · {plan.summary.atRisk} risk</b> : <b className="good"> · clear</b>}
              </div>
            )}
          </div>

          {/* ── side-wall monitors: the data lives here, slightly angled ── */}
          <div className="fdWall left">
            <Monitor className="big" on={!!panels.comms} head="Comm" headAccent="relay"
                     count={unread ? `${unread} unread` : emails.length} bodyHeight={352}>
              {inbox.map((e) => (
                <button key={e.id} className="fdTx" onClick={() => onNavigate('transmissions')}>
                  <Face characterId={e.characterId} size={34} />
                  <span className="txBody">
                    <span className="top">
                      <span className="who">{e.character?.name || e.fromName || 'Unknown'}</span>
                      <span className="age">{ageOf(e.receivedAt)}</span>
                    </span>
                    <span className="sub">{e.subject}</span>
                  </span>
                </button>
              ))}
              {!inbox.length && <div className="fdDim">relay silent</div>}
            </Monitor>
            <Monitor on={!!panels.cust} head="Custody" headAccent="register" count={custody?.length} bodyHeight={128}>
              {custody?.map((c) => (
                <button key={c.ifNumber} className="fdCrow" onClick={() => onNavigate('custody')}>
                  <b>{c.ifNumber}</b>
                  <span>{c.customer || 'unknown'}</span>
                  <span className={'st ' + (c.stale ? 'stale' : c.state === 'with_warehouse' ? 'ware' : 'hand')}>
                    {c.stale ? `STALE ${c.ageDays}d` : c.state === 'with_warehouse' ? 'AT WHSE' : 'IN HAND'}
                  </span>
                </button>
              ))}
              {custody?.length === 0 && <div className="fdDim">register clear</div>}
            </Monitor>
          </div>

          <div className="fdWall right">
            <Monitor className="big" on={!!panels.tasks} head="Task" headAccent="command"
                     count={openTasks.length} bodyHeight={352}>
              {taskRows.map((r) => {
                const t = r.taskId ? taskById.get(r.taskId) : null
                return (
                  <div key={r.id} className={'fdTask' + (r.seq === 1 ? ' now' : '') + (r.atRisk ? ' risk' : '')}>
                    {t ? <Face characterId={t.characterId} size={24} /> : <span className="fdFace fdFaceGlyph" style={{ width: 24, height: 24, fontSize: 12 }}>⬡</span>}
                    <span className="seq">{r.seq ? hhmm(r.start) : ''}</span>
                    <span className="lab">{r.label}</span>
                    <span className="slack">
                      {r.slackMin != null ? (r.slackMin >= 0 ? `+${r.slackMin}m` : `${r.slackMin}m`) : r.atRisk ? '!' : ''}
                    </span>
                  </div>
                )
              })}
              {!taskRows.length && <div className="fdDim">no open tasks — crew idle</div>}
            </Monitor>
            <Monitor on={!!panels.scan} head="Partner" headAccent="scan" bodyHeight={128}>
              {partnerScan?.map((p) => (
                <button key={p.tradingPartner} className={'fdSrow h-' + p.health} onClick={() => onNavigate('edi')}>
                  <span>{p.tradingPartner.replace(/\s*\(.*$/, '')}</span>
                  <b>{p.open} open{p.health === 'red' ? ' · CRIT' : ''}</b>
                </button>
              ))}
              {!partnerScan && <div className="fdDim">scanning…</div>}
            </Monitor>
          </div>
        </div>
      </div>

      {/* ── panel board (unchanged) ── */}
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
                <label key={p.key} className="fdSw" title={`Power the ${p.label} display`}>
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
            <button className="fdGuard" title="Re-sync all feeds" onClick={syncAll}><i /></button>
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
