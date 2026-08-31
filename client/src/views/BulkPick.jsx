import { useState } from 'react'
import { fetchBulkPick } from '../api.js'

// Bulk pick ticket — replaces the NetSuite "Bulk Pick & Ship Manifest" Suitelet.
//
// Nima, 2026-08-31: "we use it to make a bulk pull for our PO in netsuite mainly for when
// its multiple stores… just to know the number of units total for a po no dc or store
// breakdown." So this is the one tab he actually uses — total units per SKU across the
// POs entered — and deliberately not the store matrix or the inbound comparison.
//
// ⚠️ IT READS NETSUITE LIVE. Everything else in this app is ingest-then-serve, which is
// right for a board you read. A pick ticket is ACTED ON: someone walks the floor pulling
// what it says. An hourly mirror would have them pick a line cancelled twenty minutes
// ago with no way to know. So this is slower than the rest of the app, and it fails
// loudly when NetSuite is unreachable rather than printing yesterday's numbers.
export default function BulkPick() {
  const [pos, setPos] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [t, setT] = useState(null)

  const run = async (e) => {
    e?.preventDefault()
    setBusy(true); setErr(null)
    try { setT(await fetchBulkPick(pos)) } catch (x) { setErr(x.message); setT(null) } finally { setBusy(false) }
  }

  return (
    <div className="catalogue">
      <div className="rt-head">
        <div>
          <h2>Bulk pick <span className="muted">· total units per SKU</span></h2>
          <div className="muted rt-sub">
            Paste the PO numbers for a run. Read live from NetSuite, so it is never stale —
            and closed lines are left out, because cancelled units are not picked.
          </div>
        </div>
      </div>

      <form className="questComposer" onSubmit={run} style={{ alignItems: 'flex-end' }}>
        <label className="composerField" style={{ flex: 1, minWidth: 280 }}>PO numbers
          <input className="qtyInput" value={pos} onChange={(e) => setPos(e.target.value)}
                 placeholder="7242978, 7242989" />
        </label>
        <div className="composerActions">
          <button className="btn" disabled={busy || !pos.trim()}>{busy ? 'Asking NetSuite…' : 'Build ticket'}</button>
          {t && <button type="button" className="btnGhost" onClick={() => window.print()}>🖨 Print</button>}
        </div>
      </form>

      {err && <div className="banner error">⚠ {err}</div>}
      {t && <Ticket t={t} />}
    </div>
  )
}

function Ticket({ t }) {
  // ⚠️ EVERY PO IS ACCOUNTED FOR, including the ones that contributed nothing, and the
  // three ways of contributing nothing are named apart. A PO that silently vanishes from
  // the sheet is how someone picks a run short and finds out on the dock.
  const trouble = t.pos.filter((p) => p.verdict !== 'ok')
  return (
    <>
      <div className="cat-stats">
        <Stat n={t.totalUnits} label="units to pull" />
        <Stat n={t.skuCount} label="SKUs" />
        <Stat n={t.salesOrders} label="sales orders" />
        <Stat n={t.stores} label="stores" />
      </div>

      {trouble.map((p) => (
        <div key={p.po} className={'banner' + (p.verdict === 'missing' ? ' error' : '')}>
          {p.verdict === 'missing' && <>⚠ PO <b>{p.po}</b> — no sales order in NetSuite carries this number. Check the digits.</>}
          {/* ⚠️ Nima's call: a fully-cancelled PO reports ZERO AND SAYS WHY. A blank sheet
              and "this PO is cancelled" look identical on paper. */}
          {p.verdict === 'allClosed' && <>⚠ PO <b>{p.po}</b> — {p.salesOrders} sales order{p.salesOrders === 1 ? '' : 's'}, all closed. <b>{p.cancelledUnits}</b> units of cancelled demand, nothing to pick.{p.statuses.length ? ` (${p.statuses.join(', ')})` : ''}</>}
          {p.verdict === 'empty' && <>⚠ PO <b>{p.po}</b> — {p.salesOrders} open sales order{p.salesOrders === 1 ? '' : 's'}, but no goods lines on them.</>}
        </div>
      ))}

      {t.skus.length === 0 ? (
        <div className="rt-empty">Nothing to pick for {t.asked.join(', ')}.</div>
      ) : (
        <table className="cat-table">
          <thead>
            <tr>
              <th>SKU</th>
              {/* One column per PO, but only when there is more than one — a single-PO
                  ticket does not need its total printed twice. */}
              {t.poColumns.length > 1 && t.poColumns.map((po) => <th key={po} className="num">PO {po}</th>)}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {t.skus.map((s) => (
              <tr key={s.sku}>
                <td><b>{s.sku}</b></td>
                {t.poColumns.length > 1 && t.poColumns.map((po) => (
                  <td key={po} className="num">{s.byPo[po] || ''}</td>
                ))}
                <td className="num"><b>{s.total}</b></td>
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td>
              {t.poColumns.length > 1 && t.poColumns.map((po) => (
                <td key={po} className="num"><b>{t.pos.find((p) => p.po === po)?.units || 0}</b></td>
              ))}
              <td className="num"><b>{t.totalUnits}</b></td>
            </tr>
          </tbody>
        </table>
      )}
      {/* When it was asked, because "live" is a claim and a printed sheet outlives it. */}
      <div className="muted cat-imported">Read from NetSuite {new Date(t.fetchedAt).toLocaleString()}</div>
    </>
  )
}

function Stat({ n, label }) {
  return <div className="cat-stat"><div className="cat-stat-n">{n}</div><div className="cat-stat-l">{label}</div></div>
}
