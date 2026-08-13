import { useEffect, useState } from 'react'
import { fetchShipDepartures } from '../api.js'
import { SourceBadge, LabelButtons, NoteWidget, ChannelTag, CustomerName, DocLinks, NsLink } from '../lib.jsx'

// Nima's framing (2026-07-16) is unchanged — what can leave TODAY goes first —
// but the buckets now key on the bay's DERIVED state rather than on the
// hand-keyed IF-Packed-Status string.
//
// ⚠️ Those strings were the bug. The field is null on every IF still at the dock,
// so this board grouped 8 already-departed shipments under "Can depart today"
// (they left 6–29 days ago) and showed none of the 70 actually here. See
// getShipDepartures in server/queries.js. An unrecognised state still gets its own
// column, appended, rather than being silently dropped.
const BUCKETS = [
  { key: 'approved', label: 'Approved to Ship', hint: 'Cleared — can depart today' },
  { key: 'scanned_in', label: 'Back in Our Hands', hint: 'Scanned back in — label it and get it out' },
  { key: 'payment', label: 'Waiting on Payment', hint: 'Held at the dock until the balance clears' },
  { key: 'invoice', label: 'Pending Invoice', hint: 'Needs an invoice before it can move' },
  { key: 'other', label: 'Other', hint: 'No invoice or billing signal yet' },
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
  const extraKeys = [...new Set(rows.map((r) => r.state).filter((k) => k && !known.has(k)))]
  const cols = [...BUCKETS, ...extraKeys.map((key) => ({ key, label: key, hint: '' }))]
    .map((b) => ({ ...b, items: rows.filter((r) => r.state === b.key) }))
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
                <span className="so"><NsLink doc={r.ifNumber} /></span>
                <SourceBadge source={r.source} />
              </div>
              <div className="cust"><ChannelTag order={r} /> <CustomerName order={r} />{r.poNumber ? ` · PO ${r.poNumber}` : ''}</div>
              <div className="ifs">
                <NsLink doc={r.soNumber} />
                {r.invoiceNumber && <> · <NsLink doc={r.invoiceNumber} /></>}
                {r.daysPending != null && <span className="docdate"> · {r.daysPending}d pending</span>}
                <LabelButtons info={r} />
              </div>
              <NoteWidget docType={r.ifNumber ? 'IF' : 'SO'} docNumber={r.ifNumber || r.soNumber} />
              <DocLinks docType={r.ifNumber ? 'IF' : 'SO'} docNumber={r.ifNumber || r.soNumber} selfLabel={r.customer} />
            </div>
          ))}
        </div>
      ))}
      {!cols.length && <div className="empty">Nothing waiting on departure right now 🎉</div>}
    </div>
  )
}
