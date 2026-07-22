import { useEffect, useRef, useState } from 'react'
import { fetchOrders, fetchFreshness, importCsv, fetchQuestTasks, fetchQuestActivity, fetchOrderEvents, fetchCredits } from './api.js'
import { fmtAge } from './lib.jsx'
import CommandCenter from './views/CommandCenter.jsx'
import FlightDeck from './views/FlightDeck.jsx'
import Kanban from './views/Kanban.jsx'
import TableView from './views/TableView.jsx'
import Calendar from './views/Calendar.jsx'
import Allocations from './views/Allocations.jsx'
import EdiOrders from './views/EdiOrders.jsx'
import Routing from './views/Routing.jsx'
import Tasks from './views/Tasks.jsx'
import Transmissions from './views/Transmissions.jsx'
import Crew from './views/Crew.jsx'
import Datapad from './views/Datapad.jsx'
import ShipDepartures from './views/ShipDepartures.jsx'
import ScanBay from './views/ScanBay.jsx'
import CustodyRegister from './views/CustodyRegister.jsx'
import LaunchBay3D from './views/LaunchBay3D.jsx'

const FRESH_LABEL = { fresh: 'current', warn: 'aging', stale: 'stale', missing: 'not uploaded', unknown: 'unknown' }

// Per-source freshness panel. The header pill shows the WORST source; clicking
// it lists every required export with its own age, so you know exactly which
// one to re-pull — a stale IF/Invoice export silently misclassifies orders
// (they sit at an earlier stage than they really are).
function FreshnessPanel({ fresh }) {
  const [open, setOpen] = useState(false)
  if (!fresh) return null
  const bad = fresh.sources.filter((s) => s.status === 'stale' || s.status === 'missing').length
  const summary =
    bad > 0
      ? `${bad} ${bad === 1 ? 'export' : 'exports'} need re-upload`
      : fresh.status === 'fresh'
        ? 'data current'
        : 'data aging'

  return (
    <span className="freshWrap">
      <button className={'pill ' + fresh.status} onClick={() => setOpen((o) => !o)}>
        {summary} ▾
      </button>
      {open && (
        <div className="freshPanel">
          <div className="freshHead">Saved-search exports</div>
          {fresh.sources.map((s) => (
            <div key={s.key} className="freshRow">
              <span className={'dot ' + s.status} />
              <span className="fname">{s.label}</span>
              <span className={'fage ' + s.status}>
                {s.status === 'missing' ? 'not uploaded' : fmtAge(s.ageHours)}
                {(s.status === 'stale' || s.status === 'missing') && ' · re-upload'}
              </span>
              {s.url && (
                <a href={s.url} target="_blank" rel="noreferrer" className="linkBtn" style={{ marginLeft: 4 }}>↗</a>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
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
  // Second, switchable HUD (Nima, 2026-07-21) — the Falcon-cockpit hub.
  // Command stays untouched; the two coexist as separate tabs.
  { key: 'flight', label: 'Flight Deck', C: FlightDeck },
  { key: 'kanban', label: 'Mission Quests', C: Kanban },
  { key: 'table', label: 'Table', C: TableView },
  { key: 'calendar', label: 'Calendar', C: Calendar },
  { key: 'allocations', label: 'OC↔PO', C: Allocations },
  { key: 'edi', label: 'EDI', C: EdiOrders },
  { key: 'routing', label: 'Routing', C: Routing },
  // Dedicated task list (Nima, 2026-07-21) — a peer to Transmissions/EDI; the
  // single home task clicks jump to and where SO/EDI "task exists" links land.
  { key: 'tasks', label: 'Tasks', C: Tasks },
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
  const [activity, setActivity] = useState([])
  const [events, setEvents] = useState([])
  const [err, setErr] = useState(null)
  const [view, setView] = useState('command')
  const [fresh, setFresh] = useState(null)
  const [credits, setCredits] = useState(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null)
  const fileRef = useRef(null)

  function refresh() {
    fetchOrders().then(setOrders).catch((e) => setErr(e.message))
    fetchFreshness().then(setFresh).catch(() => {})
    fetchCredits().then(setCredits).catch(() => {})
    // Open quest_tasks merge into Dashboard/Kanban's attention view, and the
    // activity journal folds into Calendar (Nima, 2026-07-15) — both
    // best-effort: the app still works if either fails to load.
    fetchQuestTasks().then(setTasks).catch(() => {})
    fetchQuestActivity().then(setActivity).catch(() => {})
    // Order-events ledger (custody scans) — folds into Calendar's day grid.
    fetchOrderEvents().then(setEvents).catch(() => {})
  }
  useEffect(refresh, [])

  async function onFiles(e) {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    setImporting(true)
    setNotice(null)
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, text: await f.text(), lastModified: f.lastModified })),
      )
      const r = await importCsv(payload)
      const unrec = r.files.filter((f) => !f.recognized)
      setNotice({
        ok: true,
        msg:
          `Imported ${r.files.length - unrec.length} file(s): ${r.orders} orders · ${r.fulfillments} fulfillments · ${r.invoices} invoices` +
          (unrec.length ? ` — not recognized: ${unrec.map((u) => u.name).join(', ')}` : ''),
      })
      refresh()
    } catch (e2) {
      setNotice({ ok: false, msg: 'Import failed: ' + e2.message })
    } finally {
      setImporting(false)
    }
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
          <button className="importBtn" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? 'Importing…' : '⤓ Import CSV'}
          </button>
          <input ref={fileRef} type="file" accept=".csv" multiple hidden onChange={onFiles} />
          <FreshnessPanel fresh={fresh} />
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
        {importing && (
          <div className="banner">
            Importing CSV(s)…
            <div className="progressBar"><div /></div>
          </div>
        )}
        {notice && <div className={'banner ' + (notice.ok ? 'ok' : 'error')}>{notice.msg}</div>}
        {err && <div className="banner error">⚠ Couldn’t load orders: {err}</div>}
        {!orders && !err && <div className="banner">Loading orders…</div>}
        {orders && <Active orders={orders} tasks={tasks} activity={activity} events={events} views={VIEWS} onNavigate={setView} onRefresh={refresh} />}
      </main>
    </div>
  )
}
