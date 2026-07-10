import { useEffect, useState } from 'react'
import { fetchOcPoReview, commitOcPo, undoOcPoLink, dismissOcPo } from '../api.js'

const keyOf = (...parts) => parts.join('|')

// The OC↔PO "open task" queue. Matching stays entirely manual (Nima,
// 2026-07-09): this view only ever shows suggestions and lets a person commit
// or dismiss ONE row at a time — nothing here auto-writes anything. Every open
// OC/PO line ends up in exactly one section below, so nothing goes missing.
export default function Allocations() {
  const [review, setReview] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const [qty, setQty] = useState({})
  const [poPick, setPoPick] = useState({})

  function load() {
    fetchOcPoReview().then(setReview).catch((e) => setErr(e.message))
  }
  useEffect(load, [])

  async function run(rowKey, fn) {
    setBusy(rowKey)
    setErr(null)
    try {
      setReview(await fn())
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(null)
    }
  }

  const commitSuggested = (m) =>
    run(keyOf('sugg', m.ocNumber, m.poNumber, m.item), () =>
      commitOcPo({ ...m, note: 'confirmed suggestion' }),
    )

  const commitCandidate = (oc, po, item, rowKey) => {
    const q = Number(qty[rowKey] ?? Math.min(oc.remaining, po.remaining))
    if (!(q > 0)) return setErr('Enter a quantity greater than 0')
    return run(rowKey, () =>
      commitOcPo({ ocNumber: oc.ocNumber, poNumber: po.poNumber, item, allocatedQty: q, note: 'manual: resolved contention/shortage' }),
    )
  }

  const closeOc = (o) => {
    const note = window.prompt(`Mark ${o.ocNumber} / ${o.item} to be closed — why? (optional)`)
    if (note === null) return
    run(keyOf('closeoc', o.ocNumber, o.item), () => dismissOcPo({ type: 'oc', ocNumber: o.ocNumber, item: o.item, note }))
  }

  const closePo = (p) => {
    const note = window.prompt(`Mark ${p.poNumber} / ${p.item} to be closed — why? (optional)`)
    if (note === null) return
    run(keyOf('closepo', p.poNumber, p.item), () => dismissOcPo({ type: 'po', poNumber: p.poNumber, item: p.item, note }))
  }

  const undo = (link) => {
    if (!window.confirm(`Undo ${link.ocNumber} → ${link.poNumber} (${link.item}, qty ${link.allocatedQty})?`)) return
    run(keyOf('undo', link.id), () => undoOcPoLink(link.id))
  }

  if (err && !review) return <div className="banner error">⚠ Couldn’t load OC↔PO review: {err}</div>
  if (!review) return <div className="banner">Loading OC↔PO review…</div>

  const { suggestedMatches, candidates, unmatchedOcs, unmatchedPos, links } = review

  return (
    <div className="allocWrap">
      {err && <div className="banner error">⚠ {err}</div>}

      <div className="allocStats">
        <span className="pill">{suggestedMatches.length} suggested</span>
        <span className="pill danger">{candidates.length} need a decision</span>
        <span className="pill warn">{unmatchedOcs.length} OC / {unmatchedPos.length} PO unmatched</span>
        <span className="pill">{links.length} committed</span>
      </div>

      <section>
        <h2>Suggested matches <span className="count">{suggestedMatches.length}</span></h2>
        <p className="hint">Unambiguous 1:1 — one open OC, one open PO, fully covered. Nothing here is committed until you click.</p>
        {!suggestedMatches.length && <div className="empty">Nothing unambiguous right now.</div>}
        {!!suggestedMatches.length && (
          <table className="grid">
            <thead><tr><th>OC#</th><th>PO#</th><th>Item</th><th className="num">Qty</th><th></th></tr></thead>
            <tbody>
              {suggestedMatches.map((m) => {
                const rowKey = keyOf('sugg', m.ocNumber, m.poNumber, m.item)
                return (
                  <tr key={rowKey}>
                    <td className="mono">{m.ocNumber}</td>
                    <td className="mono">{m.poNumber}</td>
                    <td>{m.item}</td>
                    <td className="num">{m.allocatedQty}</td>
                    <td>
                      <button className="btn" disabled={busy === rowKey} onClick={() => commitSuggested(m)}>
                        {busy === rowKey ? '…' : 'Commit'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Needs a decision <span className="count">{candidates.length}</span></h2>
        <p className="hint">More than one OC or PO shares this item + location — pick which OC gets which PO's supply.</p>
        {!candidates.length && <div className="empty">Nothing contested right now.</div>}
        {candidates.map((c, i) => (
          <div className="card allocCard" key={i}>
            <div className="cardTop">
              <b>{c.item}</b>
              <span className="cust">
                {c.location} · <span className={'flag ' + (c.reason === 'SHORTAGE' ? 'sev-mid' : 'sev-hi')}>{c.reason}</span>
              </span>
            </div>
            <div className="allocPos">Available POs: {c.pos.map((p) => `${p.poNumber} (${p.remaining})`).join(', ')}</div>
            <table className="grid">
              <thead><tr><th>OC#</th><th className="num">Remaining</th><th>Assign to PO</th><th>Qty</th><th></th></tr></thead>
              <tbody>
                {c.ocs.map((oc) => {
                  const pickKey = keyOf('pick', oc.ocNumber, oc.item)
                  const chosenPoNumber = poPick[pickKey] || c.pos[0]?.poNumber
                  const po = c.pos.find((p) => p.poNumber === chosenPoNumber)
                  const rowKey = keyOf('cand', oc.ocNumber, chosenPoNumber, oc.item)
                  const defaultQty = po ? Math.min(oc.remaining, po.remaining) : ''
                  return (
                    <tr key={pickKey}>
                      <td className="mono">{oc.ocNumber}</td>
                      <td className="num">{oc.remaining}</td>
                      <td>
                        <select value={chosenPoNumber} onChange={(e) => setPoPick((s) => ({ ...s, [pickKey]: e.target.value }))}>
                          {c.pos.map((p) => (
                            <option key={p.poNumber} value={p.poNumber}>{p.poNumber} ({p.remaining})</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          className="qtyInput" type="number" min="1"
                          value={qty[rowKey] ?? defaultQty}
                          onChange={(e) => setQty((s) => ({ ...s, [rowKey]: e.target.value }))}
                        />
                      </td>
                      <td>
                        <button className="btn" disabled={!po || busy === rowKey} onClick={() => commitCandidate(oc, po, oc.item, rowKey)}>
                          {busy === rowKey ? '…' : 'Commit'}
                        </button>
                        <button className="btnGhost" onClick={() => closeOc(oc)}>Close OC</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h2>Unmatched — no candidate yet</h2>
        <p className="hint">Open demand or supply with nothing on the other side yet. Wait for new data, or mark it to close if it's no longer relevant.</p>
        <div className="allocTwoCol">
          <div>
            <h3>Order Confirmations <span className="count">{unmatchedOcs.length}</span></h3>
            {!unmatchedOcs.length && <div className="empty">None.</div>}
            {unmatchedOcs.map((o) => (
              <div className="kcard" key={keyOf(o.ocNumber, o.item)}>
                <div className="so">{o.ocNumber} <span className="cust">{o.location}</span></div>
                <div>{o.item} · qty {o.remaining}</div>
                <button className="btnGhost" disabled={busy === keyOf('closeoc', o.ocNumber, o.item)} onClick={() => closeOc(o)}>
                  Mark to close
                </button>
              </div>
            ))}
          </div>
          <div>
            <h3>Purchase Orders <span className="count">{unmatchedPos.length}</span></h3>
            {!unmatchedPos.length && <div className="empty">None.</div>}
            {unmatchedPos.map((p) => (
              <div className="kcard" key={keyOf(p.poNumber, p.item)}>
                <div className="so">{p.poNumber} <span className="cust">{p.destination}</span></div>
                <div>{p.item} · qty {p.remaining}</div>
                <button className="btnGhost" disabled={busy === keyOf('closepo', p.poNumber, p.item)} onClick={() => closePo(p)}>
                  Mark to close
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <h2>Committed <span className="count">{links.length}</span></h2>
        {!links.length && <div className="empty">Nothing committed yet.</div>}
        {!!links.length && (
          <table className="grid">
            <thead><tr><th>OC#</th><th>PO#</th><th>Item</th><th className="num">Qty</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{l.ocNumber}</td>
                  <td className="mono">{l.poNumber}</td>
                  <td>{l.item}</td>
                  <td className="num">{l.allocatedQty}</td>
                  <td className="cust">{l.note}</td>
                  <td>
                    <button className="btnGhost" disabled={busy === keyOf('undo', l.id)} onClick={() => undo(l)}>Undo</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
