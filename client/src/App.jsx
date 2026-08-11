import { useEffect, useState } from 'react'
import { fetchOrders, fetchQuestTasks, fetchQuestEmails, fetchQuestActivity, fetchOrderEvents, fetchCredits, fetchEdiArrivals, dismissEdiArrival, fetchLabelGaps, fetchEdiDeliveryGaps, fetchAsnCartons, refreshNetsuite, netsuiteRefreshStatus, fetchCustodyRegister, fetchLaunchBay, fetchSyncHealth, fetchUnfiledPaper, fetchInboundContainers } from './api.js'
import { CourtStrip } from './ShipDesk.jsx'
import { syncHealthLine } from '../../src/model/syncHealth.js'
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
import Tasks from './views/Tasks.jsx'
import Transmissions from './views/Transmissions.jsx'
import Crew from './views/Crew.jsx'
import Datapad from './views/Datapad.jsx'
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
      setNsSync({ state: 'running', msg: 'Pulling from NetSuite… (about a minute and a half)' })
      let r = null
      for (let i = 0; i < 100; i++) {
        await new Promise((ok) => setTimeout(ok, 3000))
        const st = await netsuiteRefreshStatus().catch(() => null)
        if (st && !st.running) { r = st.result || {}; break }
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
          <button
            className="importBtn"
            onClick={onRefreshNetsuite}
            disabled={nsSync.state === 'running'}
            title="Pull orders, fulfilments and invoices straight from NetSuite now. There is no daily call limit — the only constraint is concurrency, which Celigo has priority on, so this will tell you if it has to wait."
          >
            {nsSync.state === 'running' ? 'Refreshing…' : '↻ Refresh NetSuite'}
          </button>
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
        <CourtStrip labelGaps={labelGaps} custody={custody} bay={bay} orders={orders || []} ediGaps={ediGaps} asnCartons={asnCartons} unfiled={unfiled} inbound={inbound} onNavigate={setView} />
        {err && <div className="banner error">⚠ Couldn’t load orders: {err}</div>}
        {!orders && !err && <div className="banner">Loading orders…</div>}
        {orders && <Active orders={orders} tasks={tasks} emails={emails} activity={activity} events={events} views={VIEWS}
                           labelGaps={labelGaps} custody={custody} bay={bay}
                           onNavigate={setView} onRefresh={refresh} />}
      </main>
    </div>
  )
}
