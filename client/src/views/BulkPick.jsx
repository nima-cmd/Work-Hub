import { useState, useEffect, useRef } from 'react'
import { fetchBulkPick, bulkPickPdfUrl } from '../api.js'
import { RULE_DESCRIPTIONS, SELECTABLE_RULES } from '../../../src/model/allocationPlan.js'

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
  // The shortage plan, if one has been asked for. ⚠️ TWO PAIRS, NOT ONE. `rule`/`pool`
  // are what the selects hold; `plan` is what the ticket on screen was actually built
  // with. Printing from the selects would hand someone a sheet for a rule they had
  // started choosing and not applied — the same disagreement `built` exists to prevent.
  const [rule, setRule] = useState('')
  const [pool, setPool] = useState('')
  const [plan, setPlan] = useState(null)

  const build = async (text, opts = null) => {
    setBusy(true); setErr(null)
    try {
      setT(await fetchBulkPick(text, opts || {}))
      setBuilt(text); setPlan(opts)
    } catch (x) { setErr(x.message); setT(null); setBuilt(''); setPlan(null) } finally { setBusy(false) }
  }
  // ⚠️ BUILDING A PLAIN TICKET CLEARS THE PLAN. New POs mean a different pool of demand,
  // and leaving last run's cuts on screen beside them would attribute one PO's shortage
  // to another's orders.
  const run = (e) => { e?.preventDefault(); setRule(''); setPool(''); return build(pos, null) }
  const planRun = (e) => { e?.preventDefault(); return build(built, { rule, pool }) }

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
            <a className="btnGhost" href={bulkPickPdfUrl(built, plan || {})} target="_blank" rel="noreferrer">
              🖨 Print ticket
            </a>
          )}
        </div>
      </form>

      {err && <div className="banner error">⚠ {err}</div>}
      {t && <Ticket t={t} />}
      {t && <Planner t={t} rule={rule} setRule={setRule} pool={pool} setPool={setPool}
                     onPlan={planRun} busy={busy} plan={plan} />}
      {t?.allocation && <Allocation a={t.allocation} />}
    </div>
  )
}

// ── Choosing the plan ───────────────────────────────────────────────────────
//
// ⚠️ NEITHER SELECT HAS A DEFAULT, AND THAT IS THE POINT OF THE SCREEN. The pool
// decides which stock may be used — "what we have in the warehouse for bloomingdaels
// is all we can use" — and the rule decides which customer is disappointed. The model
// refuses to guess either; a screen that pre-selected the first option would make both
// decisions silently and then show the answer as though someone had chosen it.
//
// ⚠️ AND THE RULES ARE SHOWN WITH WHAT THEY COST, not as five slugs. A list of names
// with no consequence gets the first one picked, which is a default with extra steps.
function Planner({ t, rule, setRule, pool, setPool, onPlan, busy, plan }) {
  const pools = t.stockColumns || []
  // ⚠️ UNKNOWN STOCK CANNOT BE ALLOCATED. If the on-hand read failed the pools are all
  // "?" — planning against them would allocate zero to everyone and call it a decision.
  if (t.stockKnown === false) {
    return (
      <div className="banner error">
        ⚠ No shortage plan while on-hand is unknown — allocating against a column that
        could not be read would cut every order to nothing and present it as a decision.
        Rebuild the ticket once NetSuite answers.
      </div>
    )
  }
  if (!pools.length) return null
  const d = rule ? RULE_DESCRIPTIONS[rule] : null
  return (
    <form className="questComposer" onSubmit={onPlan} style={{ alignItems: 'flex-end', marginTop: 16 }}>
      <label className="composerField" style={{ minWidth: 220 }}>Stock pool
        <select className="qtyInput" style={{ width: '100%' }}
                value={pool} onChange={(e) => setPool(e.target.value)}>
          <option value="">— choose a pool —</option>
          {pools.map((c) => (
            <option key={c.id} value={c.name}>
              {c.name}{c.isOrderLocation ? " (this order's own location)" : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="composerField" style={{ minWidth: 260 }}>Allocation rule
        <select className="qtyInput" style={{ width: '100%' }}
                value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">— choose a rule —</option>
          {SELECTABLE_RULES.map((r) => (
            <option key={r} value={r}>{RULE_DESCRIPTIONS[r].label}</option>
          ))}
        </select>
      </label>
      <div className="composerActions">
        <button className="btn" disabled={busy || !rule || !pool}>
          {busy ? 'Asking NetSuite…' : plan ? 'Re-plan' : 'Plan the shortage'}
        </button>
      </div>
      {d && (
        <div className="muted rt-sub" style={{ flexBasis: '100%' }}>
          <b>{d.label}</b> — {d.does} <b>Costs:</b> {d.costs}
        </div>
      )}
      {/* The rules that exist but cannot be armed from here, named rather than hidden —
          a rule that silently disappears looks like one that does not exist. */}
      {Object.entries(RULE_DESCRIPTIONS).filter(([, x]) => x.needs).map(([k, x]) => (
        <div key={k} className="muted rt-sub" style={{ flexBasis: '100%' }}>
          <i>{x.label}</i> is not offered here — it needs {x.needs}.
        </div>
      ))}
    </form>
  )
}

// ── The shortage, the cuts, and what is left in the building ────────────────
function Allocation({ a }) {
  const r = a.ready
  return (
    <>
      <h3 style={{ marginTop: 24 }}>
        Shortage plan <span className="muted">· {RULE_DESCRIPTIONS[a.rule]?.label || a.rule} · from {a.pool}</span>
      </h3>

      {/* ⚠️ THE VERDICT FIRST, AND A BLOCK IS NOT A WARNING. `blocks` means the
          paperwork is incoherent — over-committed against on-hand — and fulfilling on
          it makes a real mess in NetSuite. `warnings` are things to know while doing it. */}
      <div className={'banner' + (r.ready ? '' : ' error')}>
        <b>{r.verdict}</b> — {r.shipping} units shipping across {r.ordersShipping} order{r.ordersShipping === 1 ? '' : 's'},
        {' '}{r.cut} cut across {r.ordersAdjusted}.
        <div className="muted" style={{ marginTop: 4 }}>{r.note}</div>
      </div>
      {r.blocks.map((b, i) => <div key={i} className="banner error">⛔ {b}</div>)}
      {r.warnings.map((w, i) => <div key={i} className="banner">⚠ {w}</div>)}

      {/* ⚠️ STRANDED UNITS ARE REPORTED, NOT HIDDEN. Whole-line rules leave a remainder
          smaller than any unfilled line. A pick of 67 against 72 on hand otherwise
          reads as a counting error to whoever is holding the ticket. */}
      {a.strandedUnits > 0 && (
        <div className="banner">
          ⚠ <b>{a.strandedUnits}</b> unit{a.strandedUnits === 1 ? '' : 's'} left in the building —{' '}
          {Object.entries(a.stranded).map(([sku, n]) => `${sku}: ${n}`).join(' · ')}. That is the
          cost of shipping whole lines, not a miscount.
        </div>
      )}

      {/* ⚠️ "SHORT" NOW MEANS TWO DIFFERENT THINGS ON ONE SCREEN, AND IT HAS TO SAY SO.
          The ticket above computes short against EVERY location it read; this table
          computes it against the ONE pool that was chosen. Live on POs 1236143+1236132
          that is 62 up there and 65 down here for the same SKU — 3 units sitting in
          Warehouse that the Bloomingdale's pool may not draw on. Two numbers under the
          same word with nothing between them is precisely the counter shape this repo
          keeps finding: it counts something other than its label. */}
      <h4>Demand against the pool</h4>
      <div className="muted rt-sub">
        ⚠ <b>Short here is short against <i>{a.pool}</i> alone</b>, which is why it can
        exceed the ticket's own Short column above — that one counts stock in every
        location, including ones this pool may not use.
      </div>
      <table className="cat-table">
        <thead><tr>
          <th>SKU</th><th className="num">Wanted</th><th className="num">In pool</th>
          <th className="num">Short</th><th className="num">Spare</th>
        </tr></thead>
        <tbody>
          {a.shortfall.rows.map((row) => (
            <tr key={row.sku} className={row.short > 0 ? 'rowShort' : undefined}>
              <td><b>{row.sku}</b></td>
              <td className="num">{row.demand}</td>
              <td className="num">{row.available}</td>
              <td className="num">{row.short > 0 ? <b className="shortQty">{row.short}</b> : ''}</td>
              <td className="num">{row.spare || ''}</td>
            </tr>
          ))}
          <tr>
            <td><b>Total</b></td>
            <td className="num"><b>{a.shortfall.totalDemand}</b></td>
            <td className="num" />
            <td className="num"><b>{a.shortfall.totalShort || ''}</b></td>
            <td className="num" />
          </tr>
        </tbody>
      </table>
      {/* ⚠️ SPARE IS NOT A SUBSTITUTION OFFER. Every partner guide here says do not
          substitute; it is shown so it is visible, never as a way to close a shortage. */}
      {!!a.shortfall.spareSkus.length && (
        <div className="muted cat-imported">
          Spare stock is shown because it is there, <b>not</b> as something to substitute —
          every partner routing guide here forbids it.
        </div>
      )}

      {/* ── What to cut, per order, keyed to the fulfilment ──────────────── */}
      <h4 style={{ marginTop: 20 }}>
        Cut list <span className="muted">· what to adjust on the invoice</span>
      </h4>
      {a.invoiceAdjustments.length === 0 ? (
        <div className="rt-empty">Nothing is cut — every order ships complete from this pool.</div>
      ) : (
        <table className="cat-table">
          <thead><tr>
            <th>Order</th><th>Fulfilment</th><th>PO</th><th>Store</th>
            <th>Cut</th><th className="num">Ordered</th><th className="num">Shipping</th><th className="num">Cut</th>
          </tr></thead>
          <tbody>
            {a.invoiceAdjustments.map((o) => (
              <tr key={o.order} className={o.shipsNothing ? 'rowShort' : undefined}>
                <td><b>{o.order}</b></td>
                {/* ⚠️ THE IF NUMBER, BECAUSE THE INVOICE AND THE ASN ARE RAISED AGAINST
                    THE FULFILMENT. A short list keyed only on sales orders makes
                    whoever is invoicing look every one of them up. */}
                <td>{o.iff || <span className="muted">not fulfilled yet</span>}</td>
                <td>{o.po}</td>
                <td>{o.store}</td>
                <td>{o.lines.map((l) => `${l.sku} −${l.cut}`).join(' · ')}</td>
                <td className="num">{o.ordered}</td>
                <td className="num">{o.shipping}</td>
                <td className="num"><b className="shortQty">{o.cut}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a.invoiceAdjustments.some((o) => o.shipsNothing) && (
        <div className="banner error">
          ⚠ Highlighted orders ship <b>nothing</b> — cancel them rather than raising an
          empty fulfilment and an invoice against it.
        </div>
      )}

      {/* ── The whole-order cuts that cover the shortage exactly ─────────── */}
      {Object.entries(a.options || {}).map(([sku, o]) => (
        <div key={sku} style={{ marginTop: 16 }}>
          <h4>Whole orders totalling exactly {o.target} of {sku}</h4>
          {/* ⚠️ AN ALTERNATIVE TO THE CUT LIST ABOVE, NOT AN ADDITION TO IT. These sets
              cover the shortage EXACTLY, so they strand nothing — which the rule above
              cannot always manage. Read as extra cuts they would double the damage. */}
          <div className="muted rt-sub">
            Each is a <b>replacement</b> for the cut list above, not an addition — cutting
            these whole orders covers the shortage exactly and strands nothing.
          </div>
          {/* ⚠️ "NO EXACT SET" IS AN ANSWER, NOT AN EMPTY LIST. It means a partial cut
              or stranded units are unavoidable for this SKU, which is worth saying. */}
          {!o.exact ? (
            <div className="rt-empty">{o.note}</div>
          ) : (
            <ul className="muted">
              {o.options.map((opt, i) => (
                <li key={i}>
                  <b>{opt.count} order{opt.count === 1 ? '' : 's'}</b>:{' '}
                  {opt.orders.map((x) => `${x.order} ${x.store ?? ''} (${x.qty})`).join(' + ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
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
