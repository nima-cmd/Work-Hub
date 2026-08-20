import { useEffect, useRef, useState } from 'react'
import { fetchPulse, fetchOrders, fetchQuestTasks, fetchQuestEmails, fetchQuestActivity, fetchOrderEvents, fetchCredits, fetchEdiArrivals, dismissEdiArrival, fetchLabelGaps, fetchEdiDeliveryGaps, fetchAsnCartons, refreshNetsuite, netsuiteRefreshStatus, fetchCustodyRegister, fetchLaunchBay, fetchSyncHealth, fetchUnfiledPaper, fetchInboundContainers , recordViewVisit } from './api.js'
import { CourtStrip } from './ShipDesk.jsx'
import { syncHealthLine } from '../../src/model/syncHealth.js'
import { pulseChanged, PULSE_INTERVAL_MS } from '../../src/model/pulse.js'
import CommandCenter from './views/CommandCenter.jsx'
import FlightDeck from './views/FlightDeck.jsx'
import FlightPlan from './views/FlightPlan.jsx'
import Kanban from './views/Kanban.jsx'
import TableView from './views/TableView.jsx'
import Calendar from './views/Calendar.jsx'
import Allocations from './views/Allocations.jsx'
import EdiOrders from './views/EdiOrders.jsx'
import Routing from './views/Routing.jsx'
import Catalogue from './views/Catalogue.jsx'
import Weaver from './views/Weaver.jsx'
import Tasks from './views/Tasks.jsx'
import Transmissions from './views/Transmissions.jsx'
import Crew from './views/Crew.jsx'
import Datapad from './views/Datapad.jsx'
import { TraceDrawerProvider } from './TraceDrawer.jsx'
import Ledger from './views/Ledger.jsx'
import Health from './views/Health.jsx'
import ShipDepartures from './views/ShipDepartures.jsx'
import ScanBay from './views/ScanBay.jsx'
import CustodyRegister from './views/CustodyRegister.jsx'
import LaunchBay3D from './views/LaunchBay3D.jsx'

// The per-source CSV freshness panel used to live here, in the header, on every
// page. It moved to Health as a backup indicator (Nima, 2026-08-11) — see
// views/CsvBackup.jsx for why a permanent red pill about a retired path was
// worse than no pill at all.
//
// This one stays app-wide, because it is the opposite case. Freshness answered
// "how old is the source data" for a feed nobody pulls any more; this answers
// "did the LIVE sync actually run", which is a
// different failure and an invisible one — a dead sync looks exactly like a
// quiet day. Both of this repo's silent-drift incidents were this shape: PR
// #16's sync had no caller for a week, and the scheduled check returns 200 while
// the NetSuite pull inside it does nothing when creds are missing on the deploy.
// Renders nothing when healthy — no permanent "all good" bar.
function SyncAlarm({ health }) {
  if (!health || health.ok) return null
  const line = syncHealthLine(health)
  if (!line) return null
  return (
    <div className={'syncAlarm ' + health.status} title={health.syncs
      .map((s) => `${s.label}: ${s.lastAt ? new Date(s.lastAt).toLocaleString() : 'never'}`).join('\n')}>
      <span className="syncAlarmMark">{health.status === 'stale' || health.status === 'never' ? '⛔' : '⚠'}</span>
      {line}
    </div>
  )
}

// How old the data is, from an ABSOLUTE timestamp plus a local clock tick —
// never from a cached ageHours, which freezes on screen the moment it is
// fetched and then quietly under-reports for as long as the tab stays open.
function ageLabel(lastAt, now) {
  if (!lastAt) return 'never synced'
  const mins = Math.floor((now - new Date(lastAt).getTime()) / 60000)
  if (mins < 0) return 'just now'
  if (mins < 1) return 'synced just now'
  if (mins < 60) return `synced ${mins}m ago`
  const h = Math.floor(mins / 60)
  if (h < 24) return `synced ${h}h ago`
  return `synced ${Math.floor(h / 24)}d ago`
}

// Refresh NetSuite, with the age of the data and the progress of a running pull
// both ON the button (Nima, 2026-08-11: "if refresh netsuite button can have
// time stamp on the last update letting us know how old the data is … as well as
// a load bar when updating. All this can be on the button so we can save space").
//
// The bar is filled from real step reporting (src/model/netsuiteRefreshSteps.js
// → the server's poll payload), not from a timer, and it fills to the steps
// CONFIRMED FINISHED while the label names the one still in flight. The steps
// are not equal in length, so it deliberately reads "4 of 11" rather than
// implying time remaining.
function NetsuiteRefreshButton({ sync, syncHealth, onRefresh }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const ns = syncHealth?.syncs?.find((s) => s.key === 'netsuiteLive')
  const running = sync.state === 'running'
  const p = sync.step
  const pct = running ? (p ? p.percent : 0) : 0

  return (
    <button
      className={'importBtn nsBtn' + (running ? ' running' : '')}
      onClick={onRefresh}
      disabled={running}
      title={
        running
          ? 'Each tick is a query that has come back. The steps are not equal in length, so this counts work done, not time left.'
          : 'Pull orders, fulfilments and invoices straight from NetSuite now. There is no daily call limit — the only constraint is concurrency, which Celigo has priority on, so this will tell you if it has to wait.' +
            (ns?.lastAt ? `\n\nLast completed sync: ${new Date(ns.lastAt).toLocaleString()}` : '')
      }
    >
      {running && <span className="nsFill" style={{ width: pct + '%' }} />}
      {running && <span className="nsPct">{pct}%</span>}
      <span className="nsMain">{running ? (p ? p.phase + '…' : 'Starting…') : '↻ Refresh NetSuite'}</span>
      <span className="nsSub">
        {running
          ? p
            ? `${p.label} · ${p.done + 1}/${p.total}`
            : 'contacting NetSuite'
          : ageLabel(ns?.lastAt, now)}
      </span>
    </button>
  )
}

// Shipment credits — "galactic credits", but the number is real dollars.
// Shipped-this-month + still-waiting-to-leave, themed as a bay readout.
const fmtCredits = (n) =>
  Math.round(n).toLocaleString('en-US')
function CreditsCounter({ credits }) {
  return (
    <span className="credits" title={`Shipped in ${credits.month} · still waiting to leave`}>
      <span className="creditGlyph">◈</span>
      <span className="creditShipped">{fmtCredits(credits.shippedThisMonth)}</span>
      <span className="creditUnit">CR shipped</span>
      <span className="creditSep">·</span>
      <span className="creditWaiting">{fmtCredits(credits.waiting)}</span>
      <span className="creditUnit">waiting</span>
    </span>
  )
}

const VIEWS = [
  { key: 'command', label: 'Command', C: CommandCenter },
  // The daily "flight route" (Nima, 2026-07-28) — the top need: everything to
  // do today laid across the day with times, ordered by deadline, so nothing
  // gets ignored. Sits front-and-centre right after Command.
  { key: 'plan', label: "Today's Plan", C: FlightPlan },
  // Second, switchable HUD (Nima, 2026-07-21) — the Falcon-cockpit hub.
  // Command stays untouched; the two coexist as separate tabs.
  { key: 'flight', label: 'Flight Deck', C: FlightDeck },
  { key: 'kanban', label: 'Mission Quests', C: Kanban },
  { key: 'table', label: 'Table', C: TableView },
  { key: 'calendar', label: 'Calendar', C: Calendar },
  { key: 'allocations', label: 'Inbound', C: Allocations },
  { key: 'edi', label: 'EDI', C: EdiOrders },
  { key: 'routing', label: 'Routing', C: Routing },
  { key: 'catalogue', label: 'Catalogue', C: Catalogue },
  { key: 'weaver', label: 'Weaver', C: Weaver },
  // Dedicated task list (Nima, 2026-07-21) — a peer to Transmissions/EDI; the
  // single home task clicks jump to and where SO/EDI "task exists" links land.
  { key: 'tasks', label: 'Tasks', C: Tasks },
  // Chronicle of completed work — done tasks by completion day (Nima, 2026-07-28).
  { key: 'ledger', label: 'Ledger', C: Ledger },
  { key: 'health', label: 'Health', C: Health },
  { key: 'transmissions', label: 'Transmissions', C: Transmissions },
  { key: 'crew', label: 'Crew', C: Crew },
  { key: 'datapad', label: 'Datapad', C: Datapad },
  // The 3D holotable IS the Launch Bay now (Nima, 2026-07-18). The 2D view
  // (views/LaunchBay.jsx) stays on disk if it's ever wanted back.
  { key: 'launch', label: 'Launch Bay', C: LaunchBay3D },
  { key: 'ship', label: 'Ship Departures', C: ShipDepartures },
  { key: 'scan', label: 'Scan Bay', C: ScanBay },
  { key: 'custody', label: 'Custody', C: CustodyRegister },
]

export default function App() {
  const [orders, setOrders] = useState(null)
  const [tasks, setTasks] = useState([])
  // Unread transmissions. Lifted to App (2026-08-05) because the "catch up
  // first" band on the day plan needs the same list Transmissions renders —
  // one fetch, so the two can't disagree about how many are unread.
  const [emails, setEmails] = useState([])
  const [activity, setActivity] = useState([])
  const [events, setEvents] = useState([])
  const [syncHealth, setSyncHealth] = useState(null)
  const [err, setErr] = useState(null)
  const [view, setView] = useState('command')
  // A trace handed over from the drawer to the full Datapad page (its ⤢ button).
  // Held here rather than inside Datapad because a view is REMOUNTED on every tab
  // switch, so state that has to survive the switch cannot live in the view.
  const [handoffTrace, setHandoffTrace] = useState(null)
  // onNavigate everywhere: setView, plus an optional subject to hand over with it.
  const navigate = (key, subject = null) => { setView(key); if (subject) setHandoffTrace(subject) }

  // ── How much is each view actually used? (Nima, 2026-08-20) ───────────────
  //
  // Twenty views exist and he named five. Rather than consolidate on a guess about
  // the other fifteen, record it: one POST when you LEAVE a view, carrying how long
  // it was on screen. See src/model/viewUsage.js for why dwell is the honest signal
  // and why the landing view's opens are not a choice.
  //
  // ⚠️ Fires on the way OUT, not on arrival, because the dwell is only known then.
  // The effect's cleanup is the whole mechanism: it runs on every view change and on
  // unmount, so switching tabs and closing the tab both record.
  const enteredAt = useRef(Date.now())
  useEffect(() => {
    enteredAt.current = Date.now()
    const leaving = view
    const flush = () => {
      const ms = Date.now() - enteredAt.current
      // Reset first: without this a beforeunload firing after the cleanup would
      // record the same span twice.
      enteredAt.current = Date.now()
      recordViewVisit(leaving, ms)
    }
    // A closed tab never runs a React cleanup, so the last view of a session would
    // otherwise never be counted — and the last view is often the one being used most.
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [view])
  const [credits, setCredits] = useState(null)
  const [arrivals, setArrivals] = useState([])
  // Ship desk + the two other "whose court" feeds. These live here rather than
  // in CommandCenter because the court strip is app-wide now (Nima, 2026-07-31)
  // — and lifting them means the Command view no longer fetches them twice.
  const [labelGaps, setLabelGaps] = useState(null)
  const [ediGaps, setEdiGaps] = useState(null)
  const [asnCartons, setAsnCartons] = useState(null)
  const [unfiled, setUnfiled] = useState(null)
  const [inbound, setInbound] = useState(null)
  // Manual NetSuite refresh (Nima, 2026-07-31). `nsBusy` is NOT an error state:
  // it means Celigo is mid-run and holds the concurrency, which has priority.
  const [nsSync, setNsSync] = useState({ state: 'idle', msg: null })
  const [custody, setCustody] = useState(null)
  const [bay, setBay] = useState(null)

  function refresh() {
    fetchOrders().then(setOrders).catch((e) => setErr(e.message))
    fetchCredits().then(setCredits).catch(() => {})
    // New-850 arrival alerts (the cron pulls Orderful and flags fresh POs) —
    // best-effort; the banner just doesn't show if it can't load.
    fetchEdiArrivals().then(setArrivals).catch(() => {})
    // Open quest_tasks merge into Dashboard/Kanban's attention view, and the
    // activity journal folds into Calendar (Nima, 2026-07-15) — both
    // best-effort: the app still works if either fails to load.
    fetchQuestTasks().then(setTasks).catch(() => {})
    fetchQuestActivity().then(setActivity).catch(() => {})
    // /api/quest-emails answers { emails, characters } — the list is the half
    // the band needs.
    fetchQuestEmails().then((r) => setEmails(r?.emails || [])).catch(() => {})
    // Order-events ledger — folds into Calendar's day grid.
    //
    // TWO fetches on purpose. The plain feed is the latest 500 of the whole
    // ledger, which is what a scrollable history should be. But the Kanban reads
    // the same array to decide whether a carton is physically with the warehouse,
    // and custody is STATE — a carton scanned out in July is still out today. At
    // 3,129 events the window cut off mid-July and POs that had been scanned back
    // in silently reverted to "with us · not shipped" (Nima spotted it on the
    // Mission Quests board, 2026-08-02). Custody is pulled in full and merged.
    Promise.all([
      fetchOrderEvents().catch(() => []),
      fetchOrderEvents({ types: 'CUSTODY_OUT,CUSTODY_IN,CUSTODY_CLEARED' }).catch(() => []),
    ]).then(([feed, custody]) => {
      const byId = new Map()
      for (const e of [...feed, ...custody]) byId.set(e.id, e)
      setEvents([...byId.values()].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)))
    }).catch(() => {})
    // Is the live data still arriving at all? Best-effort like the rest.
    fetchSyncHealth().then(setSyncHealth).catch(() => setSyncHealth(null))
    // Ship desk / court strip. Best-effort like the rest: a failure just means
    // the strip doesn't render, it never blocks the app.
    fetchLabelGaps().then(setLabelGaps).catch(() => setLabelGaps(null))
    fetchEdiDeliveryGaps().then(setEdiGaps).catch(() => setEdiGaps(null))
    // Cartons that shipped with no delivered ASN. A Neon read of the last
    // scheduled run — never the run itself, which reads NetSuite and Orderful.
    fetchAsnCartons().then(setAsnCartons).catch(() => setAsnCartons(null))
    // Shipments that left with no signed paper filed (step 7).
    fetchUnfiledPaper().then(setUnfiled).catch(() => setUnfiled(null))
    // Inbound containers past their arrival date (open POs grouped by due date).
    fetchInboundContainers().then(setInbound).catch(() => setInbound(null))
    fetchCustodyRegister().then(setCustody).catch(() => setCustody([]))
    fetchLaunchBay().then(setBay).catch(() => setBay([]))
  }
  useEffect(refresh, [])

  // ── Keep the board live (Nima, 2026-08-19) ────────────────────────────────
  //
  // "the information doesn't refresh unless we manual refresh the page … Whitworth
  // getting scanned needed me to refresh to show it as in our possession."
  //
  // ⚠️ THIS DOES NOT POLL THE BOARD. refresh() is 16 requests, ~1.5 MB and ~400
  // database queries; at 15s that would be ~96k queries an hour from one tab against a
  // single vCPU. It polls /api/pulse — four MAX() lookups — and only calls refresh()
  // when the answer actually changes. See src/model/pulse.js.
  //
  // Also refreshes on tab focus, which is the case Nima actually hits: scan something,
  // come back to the board, expect it to be current.
  const pulseRef = useRef(null)
  useEffect(() => {
    let stopped = false
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const { version } = await fetchPulse()
        if (version == null) return                 // a failed pulse means "no change"
        if (pulseChanged(pulseRef.current, version)) refresh()
        pulseRef.current = version
      } catch { /* never let the poller break the app */ }
    }
    check()
    const id = setInterval(check, PULSE_INTERVAL_MS)
    // Coming back to the tab is the strongest signal that something happened while away.
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pull straight from NetSuite on demand. Sequential and never retried — see
  // refreshFromNetsuite in server/queries.js for why retrying would be the one
  // thing that actually harms Celigo.
  async function onRefreshNetsuite() {
    setNsSync({ state: 'running', msg: 'Pulling from NetSuite…' })
    try {
      const started = await refreshNetsuite()
      if (started.busy) {
        const r = started
        const wait = r.retryAfter ? ` Try again in ~${r.retryAfter}s.` : ' Give it a moment and press again.'
        setNsSync({
          state: 'busy',
          msg: r.reason === 'in_flight'
            ? 'A refresh is already running — hang on.'
            : `NetSuite is busy — Celigo is mid-run and gets priority.${wait}` +
              (r.partial ? ` (${r.partial})` : ''),
        })
        return
      }
      // The pull is detached server-side, so wait on it here. ~93s for a full
      // one; the 3s cadence keeps the pill honest without hammering.
      setNsSync({ state: 'running', msg: null, step: null })
      let r = null
      for (let i = 0; i < 100; i++) {
        await new Promise((ok) => setTimeout(ok, 3000))
        const st = await netsuiteRefreshStatus().catch(() => null)
        if (st && !st.running) { r = st.result || {}; break }
        // The step drives the bar on the button. A poll that fails keeps the
        // last known step rather than snapping the bar back to zero — the pull
        // is still running server-side either way.
        if (st?.step) setNsSync((s) => (s.state === 'running' ? { ...s, step: st.step } : s))
      }
      if (!r) { setNsSync({ state: 'error', msg: 'Still running after 5 minutes — check the server log.' }); return }
      if (r.busy) {
        setNsSync({ state: 'busy', msg: `NetSuite got busy mid-pull — Celigo has priority.${r.partial ? ` (${r.partial})` : ''}` })
        refresh()
        return
      }
      if (r.error) { setNsSync({ state: 'error', msg: r.error }); return }
      const c = r.counts || {}
      setNsSync({
        state: 'done',
        msg: `Synced ${c.orders ?? 0} orders · ${c.fulfillments ?? 0} fulfilments · ${c.invoices ?? 0} invoices` +
          (r.cartons ? ` · cartons ${r.cartons.loaded}` : '') +
          (r.dcWarning ? ' (the IF→DC backfill was skipped)' : ''),
      })
      refresh()
    } catch (e) {
      setNsSync({ state: 'error', msg: e.message })
    }
  }

  async function onDismissArrivals() {
    const prev = arrivals
    setArrivals([]) // optimistic
    try { await dismissEdiArrival() } catch { setArrivals(prev) }
  }

  const Active = VIEWS.find((v) => v.key === view).C
  const openTaskCount = tasks.filter((t) => t.status === 'open').length
  const attention = (orders ? orders.filter((o) => o.severity > 0).length : 0) + openTaskCount

  return (
    // Every view sits inside the drawer's provider, because NsLink prints document
    // numbers on nearly all of them and the drawer has to be openable from any.
    <TraceDrawerProvider onNavigate={navigate}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">◆</span> NAGHEDI
          <span className="sub">Warehouse Tracker</span>
        </div>
        <nav className="tabs">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={v.key === view ? 'tab active' : 'tab'}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
        <div className="topmeta">
          <NetsuiteRefreshButton sync={nsSync} syncHealth={syncHealth} onRefresh={onRefreshNetsuite} />
          {nsSync.msg && (
            <span
              className={'pill' + (nsSync.state === 'busy' ? ' warn' : nsSync.state === 'error' ? ' danger' : '')}
              onClick={() => setNsSync({ state: 'idle', msg: null })}
              style={{ cursor: 'pointer' }}
              title="click to dismiss"
            >
              {nsSync.state === 'busy' ? '⏳ ' : nsSync.state === 'error' ? '⚠ ' : ''}{nsSync.msg}
            </span>
          )}
          {credits && <CreditsCounter credits={credits} />}
          {orders && (
            <>
              <span className="pill danger">{attention} need attention</span>
              <span className="pill">{orders.length} orders</span>
            </>
          )}
        </div>
      </header>

      <main>
        {arrivals.length > 0 && (
          <div className="banner arrival">
            <span className="arrivalGlyph">🆕</span>
            <span className="arrivalMsg">
              {arrivals.length} new EDI PO{arrivals.length === 1 ? '' : 's'} arrived:{' '}
              {arrivals.slice(0, 4).map((a, i) => (
                <span key={a.transactionId}>
                  {i > 0 && ', '}
                  <strong>{a.businessNumber || a.transactionId}</strong>
                  {a.tradingPartner ? ` (${a.tradingPartner.trim()})` : ''}
                </span>
              ))}
              {arrivals.length > 4 && ` +${arrivals.length - 4} more`}
              {' — each has a task; enter into NetSuite.'}
            </span>
            <button className="arrivalGo" onClick={() => setView('edi')}>Open EDI →</button>
            <button className="arrivalX" onClick={onDismissArrivals} title="Dismiss (keeps the tasks)">✕</button>
          </div>
        )}
        {/* Whose-court strip — app-wide on purpose (Nima, 2026-07-31): the
            label gaps were invisible precisely because you had to go looking
            for them. It renders on every view and hides itself when clear. */}
        <SyncAlarm health={syncHealth} />
        <CourtStrip labelGaps={labelGaps} custody={custody} bay={bay} orders={orders || []} ediGaps={ediGaps} asnCartons={asnCartons} unfiled={unfiled} inbound={inbound} onNavigate={navigate} />
        {err && <div className="banner error">⚠ Couldn’t load orders: {err}</div>}
        {!orders && !err && <div className="banner">Loading orders…</div>}
        {orders && <Active orders={orders} tasks={tasks} emails={emails} activity={activity} events={events} views={VIEWS}
                           labelGaps={labelGaps} custody={custody} bay={bay}
                           handoffTrace={handoffTrace} onHandoffTaken={() => setHandoffTrace(null)}
                           onNavigate={navigate} onRefresh={refresh} />}
      </main>
    </div>
    </TraceDrawerProvider>
  )
}
