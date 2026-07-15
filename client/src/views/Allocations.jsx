import { useEffect, useState } from 'react'
import { fetchOcPoReview, commitOcPo, undoOcPoLink, dismissOcPo } from '../api.js'

const keyOf = (...parts) => parts.join('|')

const STATUS_FLAG = {
  SHORTAGE: 'sev-hi',
  CONTENTION: 'sev-mid',
  READY: 'sev-lo',
  FULL: '',
  NO_DEMAND: '',
}
const STATUS_LABEL = {
  SHORTAGE: 'shortage',
  CONTENTION: 'needs a decision',
  READY: 'ready to commit',
  FULL: 'fully allocated',
  NO_DEMAND: 'no demand yet',
}

function toCsv(links) {
  const header = ['OC#', 'PO#', 'Item', 'Qty', 'Note', 'Committed at']
  const rows = links.map((l) => [l.ocNumber, l.poNumber, l.item, l.allocatedQty, l.note || '', l.createdAt])
  return [header, ...rows].map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
}

function downloadCsv(links) {
  const blob = new Blob([toCsv(links)], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `oc-po-links-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// The OC↔PO "open task" queue, location-first (Nima, 2026-07-10): pick a final
// destination, then drill into its PO "containers" and see how full each one
// is, item by item, against the OCs contending for it. Matching stays entirely
// manual — this only ever previews a split locally; nothing writes until you
// click Commit on a specific row. Undo is available afterward (see Committed).
export default function Allocations() {
  const [review, setReview] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(null)
  const [selectedLocation, setSelectedLocation] = useState(null)
  const [expanded, setExpanded] = useState(() => new Set())
  const [draftQty, setDraftQty] = useState({})

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

  if (err && !review) return <div className="banner error">⚠ Couldn’t load OC↔PO review: {err}</div>
  if (!review) return <div className="banner">Loading OC↔PO review…</div>

  const { locations, containers, unassignedOcs, links } = review

  const totalOpenOc = locations.reduce((s, l) => s + l.openOcCount, 0)
  const totalOpenPo = locations.reduce((s, l) => s + l.openPoCount, 0)
  const totalShort = locations.reduce((s, l) => s + l.shortItemCount, 0)

  const toggleContainer = (po) =>
    setExpanded((s) => {
      const next = new Set(s)
      next.has(po) ? next.delete(po) : next.add(po)
      return next
    })

  const setDraft = (k, v) => setDraftQty((s) => ({ ...s, [k]: v }))

  const commitRow = (containerPo, item, oc, draftKey, fallbackQty) => {
    // The input can show a pre-filled default (e.g. the unambiguous 1:1 case)
    // without the user ever having typed into it, so draftQty won't have an
    // entry yet — fall back to what's actually displayed, not just what's typed.
    const q = Number(draftQty[draftKey] ?? fallbackQty)
    if (!(q > 0)) return setErr('Enter a quantity greater than 0')
    run(draftKey, async () => {
      const fresh = await commitOcPo({ ocNumber: oc.ocNumber, poNumber: containerPo, item, allocatedQty: q, note: 'manual: container view' })
      setDraftQty((s) => { const n = { ...s }; delete n[draftKey]; return n })
      return fresh
    })
  }

  const closePoLine = (containerPo, item) => {
    const note = window.prompt(`Mark ${containerPo} / ${item} to be closed — why? (optional)`)
    if (note === null) return
    run(keyOf('closepo', containerPo, item), () => dismissOcPo({ type: 'po', poNumber: containerPo, item, note }))
  }

  const closeOc = (o) => {
    const note = window.prompt(`Mark ${o.ocNumber} / ${o.item} to be closed — why? (optional)`)
    if (note === null) return
    run(keyOf('closeoc', o.ocNumber, o.item), () => dismissOcPo({ type: 'oc', ocNumber: o.ocNumber, item: o.item, note }))
  }

  const undo = (link) => {
    if (!window.confirm(`Undo ${link.ocNumber} → ${link.poNumber} (${link.item}, qty ${link.allocatedQty})?`)) return
    run(keyOf('undo', link.id), () => undoOcPoLink(link.id))
  }

  const locationContainers = selectedLocation ? containers.filter((c) => c.destination === selectedLocation) : []
  const locationUnassignedOcs = selectedLocation ? unassignedOcs.filter((o) => o.location === selectedLocation) : []

  return (
    <div className="allocWrap">
      {err && <div className="banner error">⚠ {err}</div>}

      <div className="allocStats">
        <span className="pill">{totalOpenOc} open OC lines</span>
        <span className="pill">{totalOpenPo} open PO lines</span>
        <span className="pill danger">{totalShort} shortage items</span>
        <span className="pill">{links.length} committed</span>
      </div>

      <section>
        <h2>Locations</h2>
        <p className="hint">Pick a final destination to see its POs as containers and how full each one is.</p>
        <div className="locHub">
          {locations.map((l) => (
            <div
              key={l.location}
              className={'locTile' + (selectedLocation === l.location ? ' active' : '')}
              onClick={() => setSelectedLocation(l.location === selectedLocation ? null : l.location)}
            >
              <h3>{l.location}</h3>
              <div className="locStat">{l.openOcCount} open OC &middot; {l.openOcUnits} units</div>
              <div className="locStat">{l.containerCount} containers &middot; {l.openPoUnits} units open</div>
              {l.shortItemCount > 0
                ? <span className="flag sev-hi">{l.shortItemCount} short</span>
                : <span className="flag sev-lo">covered</span>}
              {l.unassignedOcCount > 0 && <span className="flag sev-mid" style={{ marginLeft: 6 }}>{l.unassignedOcCount} OC, no PO yet</span>}
            </div>
          ))}
        </div>
      </section>

      {selectedLocation && (
        <section>
          <h2>{selectedLocation} <span className="count">{locationContainers.length} containers</span></h2>
          {!locationContainers.length && <div className="empty">No open POs at this location.</div>}
          {locationContainers.map((c) => {
            const isOpen = expanded.has(c.poNumber)
            return (
              <div className="container" key={c.poNumber}>
                <div className="containerHead" onClick={() => toggleContainer(c.poNumber)}>
                  <div>
                    <b>{c.poNumber}</b>{' '}
                    <span className="cust">{c.vendor}</span>
                    {c.shortItemCount > 0 && <span className="flag sev-hi" style={{ marginLeft: 8 }}>{c.shortItemCount} short</span>}
                  </div>
                  <span className="cust">{c.totalAllocated} / {c.totalCapacity} units &middot; {c.fillPct}% full</span>
                </div>
                <div className="fillBar"><div style={{ width: `${Math.min(100, c.fillPct)}%` }} /></div>

                {isOpen && (
                  <table className="grid" style={{ marginTop: 10 }}>
                    <thead>
                      <tr><th>Item</th><th className="num">Open qty</th><th>Status</th><th>Assign</th><th></th></tr>
                    </thead>
                    <tbody>
                      {c.items.map((it) => {
                        // Live preview: subtract every draft entry for this item (typed, or
                        // the pre-filled default for an unambiguous single-OC row) from its
                        // open qty, so the balance moves before anyone commits.
                        const defaultFor = (o) => (it.contendingOcs.length === 1 ? Math.min(o.remaining, it.openQty) : 0)
                        const draftedSum = it.contendingOcs.reduce((s, o) => {
                          const k = keyOf('row', c.poNumber, it.item, o.ocNumber)
                          return s + (Number(draftQty[k] ?? defaultFor(o)) || 0)
                        }, 0)
                        const liveOpen = it.openQty - draftedSum
                        return (
                          <tr key={it.item}>
                            <td>{it.item}<div className="cust">{it.originalQty} total &middot; {it.allocated} allocated</div></td>
                            <td className="num" style={{ color: liveOpen < 0 ? 'var(--hi)' : undefined }}>{liveOpen}</td>
                            <td><span className={'flag ' + STATUS_FLAG[it.status]}>{STATUS_LABEL[it.status]}</span></td>
                            <td colSpan={it.contendingOcs.length ? 1 : 2}>
                              {!it.contendingOcs.length && it.status === 'NO_DEMAND' && (
                                <button className="btnGhost" onClick={() => closePoLine(c.poNumber, it.item)}>Mark to close</button>
                              )}
                              {!!it.contendingOcs.length && (
                                <table className="grid">
                                  <tbody>
                                    {it.contendingOcs.map((o) => {
                                      const draftKey = keyOf('row', c.poNumber, it.item, o.ocNumber)
                                      const defaultQty = defaultFor(o) || ''
                                      const val = draftQty[draftKey] ?? defaultQty
                                      return (
                                        <tr key={draftKey}>
                                          <td className="mono">{o.ocNumber}</td>
                                          <td className="cust">{o.customer}</td>
                                          <td className="num">needs {o.remaining}</td>
                                          <td>
                                            <input
                                              className="qtyInput" type="number" min="1"
                                              value={val}
                                              onChange={(e) => setDraft(draftKey, e.target.value)}
                                            />
                                          </td>
                                          <td>
                                            <button
                                              className="btn" disabled={busy === draftKey}
                                              onClick={() => commitRow(c.poNumber, it.item, o, draftKey, defaultQty)}
                                            >
                                              {busy === draftKey ? '…' : 'Commit'}
                                            </button>
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}

          {!!locationUnassignedOcs.length && (
            <div style={{ marginTop: 20 }}>
              <h2>Open demand, no PO yet <span className="count">{locationUnassignedOcs.length}</span></h2>
              {locationUnassignedOcs.map((o) => (
                <div className="kcard" key={keyOf(o.ocNumber, o.item)}>
                  <div className="so">{o.ocNumber} <span className="cust">{o.customer}</span></div>
                  <div>{o.item} &middot; qty {o.remaining}</div>
                  <button className="btnGhost" disabled={busy === keyOf('closeoc', o.ocNumber, o.item)} onClick={() => closeOc(o)}>
                    Mark to close
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h2>Committed <span className="count">{links.length}</span></h2>
        {!links.length && <div className="empty">Nothing committed yet.</div>}
        {!!links.length && (
          <>
            <button className="btnGhost" style={{ marginBottom: 10 }} onClick={() => downloadCsv(links)}>
              Export CSV — to update in NetSuite
            </button>
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
          </>
        )}
      </section>
    </div>
  )
}
