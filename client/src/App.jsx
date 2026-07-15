import { useEffect, useRef, useState } from 'react'
import { fetchOrders, fetchFreshness, importCsv } from './api.js'
import { fmtAge } from './lib.jsx'
import Dashboard from './views/Dashboard.jsx'
import Kanban from './views/Kanban.jsx'
import TableView from './views/TableView.jsx'
import Calendar from './views/Calendar.jsx'
import Allocations from './views/Allocations.jsx'
import EdiOrders from './views/EdiOrders.jsx'

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
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

const VIEWS = [
  { key: 'dashboard', label: 'Dashboard', C: Dashboard },
  { key: 'kanban', label: 'Kanban', C: Kanban },
  { key: 'table', label: 'Table', C: TableView },
  { key: 'calendar', label: 'Calendar', C: Calendar },
  { key: 'allocations', label: 'OC↔PO', C: Allocations },
  { key: 'edi', label: 'EDI', C: EdiOrders },
]

export default function App() {
  const [orders, setOrders] = useState(null)
  const [err, setErr] = useState(null)
  const [view, setView] = useState('dashboard')
  const [fresh, setFresh] = useState(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null)
  const fileRef = useRef(null)

  function refresh() {
    fetchOrders().then(setOrders).catch((e) => setErr(e.message))
    fetchFreshness().then(setFresh).catch(() => {})
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
  const attention = orders ? orders.filter((o) => o.severity > 0).length : 0

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
          {orders && (
            <>
              <span className="pill danger">{attention} need attention</span>
              <span className="pill">{orders.length} orders</span>
            </>
          )}
        </div>
      </header>

      <main>
        {notice && <div className={'banner ' + (notice.ok ? 'ok' : 'error')}>{notice.msg}</div>}
        {err && <div className="banner error">⚠ Couldn’t load orders: {err}</div>}
        {!orders && !err && <div className="banner">Loading orders…</div>}
        {orders && <Active orders={orders} />}
      </main>
    </div>
  )
}
