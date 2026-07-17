import { useEffect, useState } from 'react'
import { fetchShipDepartures } from '../api.js'
import { SourceBadge, LabelButtons } from '../lib.jsx'

// Nima's framing (2026-07-16) for each IF-Packed-Status bucket, in priority
// order — "Approved to Ship" can leave TODAY, so it goes first; anything not
// in this list (a status this view hasn't been told about yet) still shows,
// appended at the end, rather than silently dropped.
const BUCKETS = [
  { key: 'Approved to Ship', label: 'Approved to Ship', hint: 'Can depart today' },
  { key: 'FOB Order Awaiting Shipment', label: 'FOB Awaiting Shipment', hint: 'Mid-process, not yet cleared to ship' },
  { key: 'Waiting On Payment', label: 'Waiting on Payment', hint: 'Stuck at the dock for a credit transfer' },
  { key: 'Pending Invoice', label: 'Pending Invoice', hint: '' },
]

export default function ShipDepartures() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    fetchShipDepartures().then(setRows).catch((e) => setErr(e.message))
  }, [])

  if (err) return <div className="banner error">⚠ Couldn’t load ship departures: {err}</div>
  if (!rows) return <div className="banner">Loading ship departures…</div>

  const known = new Set(BUCKETS.map((b) => b.key))
  const extraKeys = [...new Set(rows.map((r) => r.packedStatus).filter((k) => !known.has(k)))]
  const cols = [...BUCKETS, ...extraKeys.map((key) => ({ key, label: key, hint: '' }))]
    .map((b) => ({ ...b, items: rows.filter((r) => r.packedStatus === b.key) }))
    .filter((c) => c.items.length)

  return (
    <div className="kanban">
      {cols.map(({ key, label, hint, items }) => (
        <div className="col" key={key}>
          <div className="colHead">
            {label} <span className="count">{items.length}</span>
          </div>
          {hint && <p className="hint" style={{ marginTop: -4 }}>{hint}</p>}
          {items.map((r) => (
            <div key={r.ifNumber} className="kcard">
              <div className="krow">
                <span className="so">{r.ifNumber}</span>
                <SourceBadge source={r.source} />
              </div>
              <div className="cust">{r.customer}{r.poNumber ? ` · PO ${r.poNumber}` : ''}</div>
              <div className="ifs">
                {r.soNumber}
                {r.invoiceNumber && ` · ${r.invoiceNumber}`}
                {r.daysPending != null && <span className="docdate"> · {r.daysPending}d pending</span>}
                <LabelButtons info={r} />
              </div>
            </div>
          ))}
        </div>
      ))}
      {!cols.length && <div className="empty">Nothing waiting on departure right now 🎉</div>}
    </div>
  )
}
