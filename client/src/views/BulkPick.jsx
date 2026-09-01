import { useState, useEffect, useRef } from 'react'
import { fetchBulkPick, bulkPickPdfUrl } from '../api.js'

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
export default function BulkPick({ handoffPo, onHandoffPoTaken }) {
  const [pos, setPos] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [t, setT] = useState(null)
  // What the CURRENT ticket was built from. ⚠️ Not `pos` — the box is editable, and
  // printing what someone has half-typed instead of what is on screen is the same
  // disagreement the PDF route exists to prevent.
  const [built, setBuilt] = useState('')

  const build = async (text) => {
    setBusy(true); setErr(null)
    try {
      setT(await fetchBulkPick(text))
      setBuilt(text)
    } catch (x) { setErr(x.message); setT(null); setBuilt('') } finally { setBusy(false) }
  }
  const run = (e) => { e?.preventDefault(); return build(pos) }

  // Arriving from a Kanban card: the PO is filled in AND the ticket is built, because
  // clicking a PO to come here IS the request for its ticket — landing on a filled box
  // with a button still to press would be a second click for no decision.
  const took = useRef(null)
  useEffect(() => {
    if (!handoffPo || took.current === handoffPo) return
    took.current = handoffPo
    setPos(handoffPo)
    build(handoffPo)
    onHandoffPoTaken?.()
  }, [handoffPo, onHandoffPoTaken])

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
          {/* ⚠️ A LINK TO A PDF, NOT window.print(). The old button called window.print()
              against an app with no print stylesheet, so it sent the dark UI — top bar,
              banners and all — to the printer and produced nothing usable. The ticket is
              a document; the server renders it (server/pickTicketPdf.js). */}
          {t && (
            <a className="btnGhost" href={bulkPickPdfUrl(built)} target="_blank" rel="noreferrer">
              🖨 Print ticket
            </a>
          )}
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

      {/* ⚠️ UNKNOWN IS NOT ZERO. If the stock lookup failed the ticket still shows — it is
          the whole deliverable — but it must not read as "you have none of anything". */}
      {t.stockKnown === false && (
        <div className="banner error">
          ⚠ Stock could not be read from NetSuite{t.stockError ? ` (${t.stockError})` : ''} — the on-hand
          columns are <b>unknown</b>, not zero, and nothing below is called short.
        </div>
      )}
      {!!t.shortSkus?.length && (
        <div className="banner error">
          ⚠ <b>{t.shortSkus.length}</b> SKU{t.shortSkus.length === 1 ? '' : 's'} short on hand:{' '}
          {t.shortSkus.map((s) => `${s.sku} — need ${s.need}, have ${s.have}`).join(' · ')}
        </div>
      )}

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
              <th className="num">Pick</th>
              {/* On-hand per location. ⚠️ The order's own location is named and marked,
                  because it is a partner bucket that is routinely EMPTY — stock is
                  transferred into it at pick time — and a column of zeros with no
                  explanation reads as a catastrophe rather than as normal. */}
              {(t.stockColumns || []).map((c) => (
                <th key={c.id} className="num" title={c.name + (c.isOrderLocation ? " — this order's own location" : '')}>
                  {c.name}{c.isOrderLocation ? ' *' : ''}
                </th>
              ))}
              {!!(t.stockColumns || []).length && <th className="num">Short</th>}
            </tr>
          </thead>
          <tbody>
            {t.skus.map((s) => (
              <tr key={s.sku} className={s.short > 0 ? 'rowShort' : undefined}>
                <td><b>{s.sku}</b></td>
                {t.poColumns.length > 1 && t.poColumns.map((po) => (
                  <td key={po} className="num">{s.byPo[po] || ''}</td>
                ))}
                <td className="num"><b>{s.total}</b></td>
                {(t.stockColumns || []).map((c) => (
                  <td key={c.id} className="num">{t.stockKnown ? (s.onHand?.[c.id] ?? 0) : '?'}</td>
                ))}
                {!!(t.stockColumns || []).length && (
                  <td className="num">{t.stockKnown && s.short > 0 ? <b className="shortQty">{s.short}</b> : ''}</td>
                )}
              </tr>
            ))}
            <tr>
              <td><b>Total</b></td>
              {t.poColumns.length > 1 && t.poColumns.map((po) => (
                <td key={po} className="num"><b>{t.pos.find((p) => p.po === po)?.units || 0}</b></td>
              ))}
              <td className="num"><b>{t.totalUnits}</b></td>
              {/* ⚠️ NO TOTAL UNDER THE STOCK COLUMNS. Summing on-hand across every SKU
                  produces a number that means nothing — 126 units of chocolate plus 4 of
                  lavender does not tell you anything about either — and a figure printed
                  under a column is read as that column's total. Left blank on purpose. */}
              {(t.stockColumns || []).map((c) => <td key={c.id} className="num" />)}
              {!!(t.stockColumns || []).length && <td className="num" />}
            </tr>
          </tbody>
        </table>
      )}
      {/* When it was asked, because "live" is a claim and a printed sheet outlives it. */}
      <div className="muted cat-imported">
        Read from NetSuite {new Date(t.fetchedAt).toLocaleString()}
        {(t.stockColumns || []).some((c) => c.isOrderLocation) && (
          <> · <b>*</b> is this order's own location</>
        )}
        {' · '}quantities are <b>on hand</b>, not availability — the orders being picked have
        already been deducted from available.
      </div>
    </>
  )
}

function Stat({ n, label }) {
  return <div className="cat-stat"><div className="cat-stat-n">{n}</div><div className="cat-stat-l">{label}</div></div>
}
