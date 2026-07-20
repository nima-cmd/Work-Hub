import { useEffect, useState } from 'react'
import { fetchCustodyRegister, recordFulfillmentBox } from '../api.js'
import { SourceBadge, LabelButtons } from '../lib.jsx'

// Custody Register (Nima, 2026-07-17) — every IF that entered the custody gap
// (scanned OUT/IN) and hasn't departed yet. This is the physical-cargo mirror
// of "nothing sits ignored": the two columns are where each IF sits RIGHT NOW.
//   • With the warehouse — scanned OUT for pick/pack, not yet back.
//   • Back in our hands — scanned IN, boxed, waiting to leave the dock.
// An IF drops off this board the moment it ships (clearDepartedCustody closes
// its custody chapter at ingest). Stale = 3+ days sitting with no scan movement.
// Boxes (weight + L×W×H) can be added right here, anytime — not just in the
// fleeting moment after an IN scan (Nima, 2026-07-17).
const COLS = [
  { state: 'with_warehouse', label: 'With the warehouse', hint: 'Out for pick / pack — not scanned back yet' },
  { state: 'returned', label: 'Back in our hands', hint: 'Scanned in — box it, then it’s ready to leave' },
]

const ago = (iso) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (d <= 0) return 'today'
  return d === 1 ? '1 day' : `${d} days`
}

const dims = (b) => [b.lengthIn, b.widthIn, b.heightIn].every((v) => v != null)
  ? `${b.lengthIn}×${b.widthIn}×${b.heightIn}` : null

// Per-IF box panel: lists the captured cartons and an inline add form so a box
// can be recorded from the custody log at any time.
function Boxes({ r, onSaved }) {
  const [open, setOpen] = useState(false)
  const [w, setW] = useState(''); const [l, setL] = useState(''); const [wd, setWd] = useState(''); const [h, setH] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null)

  async function save(e) {
    e.preventDefault()
    if (!w && !l && !wd && !h) { setErr('Enter a weight or a dimension.'); return }
    setBusy(true); setErr(null)
    try {
      await recordFulfillmentBox({ ifNumber: r.ifNumber, weightLb: w, lengthIn: l, widthIn: wd, heightIn: h })
      setW(''); setL(''); setWd(''); setH(''); setOpen(false)
      onSaved()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <div className="custodyBoxes">
      {r.boxList?.length > 0 && (
        <ul className="boxList">
          {r.boxList.map((b, i) => (
            <li key={b.id}>
              📦 {i + 1}: {b.weightLb != null ? `${b.weightLb} lb` : '— lb'}{dims(b) ? ` · ${dims(b)} in` : ''}
            </li>
          ))}
        </ul>
      )}
      {!open ? (
        <button className="linkBtn" onClick={() => setOpen(true)}>+ add box</button>
      ) : (
        <form className="boxFields custodyBoxForm" onSubmit={save}>
          <label>lb<input type="number" step="0.1" min="0" value={w} onChange={(e) => setW(e.target.value)} placeholder="wt" /></label>
          <span className="boxX">·</span>
          <label>L<input type="number" step="0.1" min="0" value={l} onChange={(e) => setL(e.target.value)} placeholder="in" /></label>
          <span className="boxX">×</span>
          <label>W<input type="number" step="0.1" min="0" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="in" /></label>
          <span className="boxX">×</span>
          <label>H<input type="number" step="0.1" min="0" value={h} onChange={(e) => setH(e.target.value)} placeholder="in" /></label>
          <button className="importBtn" disabled={busy}>{busy ? '…' : 'Save'}</button>
          <button type="button" className="linkBtn" onClick={() => { setOpen(false); setErr(null) }}>cancel</button>
          {err && <div className="boxNote bad">{err}</div>}
        </form>
      )}
    </div>
  )
}

export default function CustodyRegister() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)

  function refresh() {
    fetchCustodyRegister().then(setRows).catch((e) => setErr(e.message))
  }
  useEffect(refresh, [])

  if (err) return <div className="banner error">⚠ Couldn’t load the custody register: {err}</div>
  if (!rows) return <div className="banner">Loading custody register…</div>

  const staleCount = rows.filter((r) => r.stale).length

  return (
    <div className="custody">
      <div className="custodyIntro">
        <b>{rows.length}</b> in custody
        {staleCount > 0 && <span className="pill danger">{staleCount} sitting 3+ days</span>}
        <span className="hint">Cargo we’ve physically taken hold of that hasn’t shipped. Clears on departure.</span>
      </div>
      <div className="kanban">
        {COLS.map(({ state, label, hint }) => {
          const items = rows.filter((r) => r.state === state)
          return (
            <div className="col" key={state}>
              <div className="colHead">
                {label} <span className="count">{items.length}</span>
              </div>
              <p className="hint" style={{ marginTop: -4 }}>{hint}</p>
              {items.map((r) => (
                <div key={r.ifNumber} className={'kcard' + (r.stale ? ' stale' : '')}>
                  <div className="krow">
                    <span className="so">{r.ifNumber}</span>
                    {r.source && <SourceBadge source={r.source} />}
                  </div>
                  <div className="cust">
                    {r.inData
                      ? `${r.customer || 'unknown customer'}${r.poNumber ? ` · PO ${r.poNumber}` : ''}`
                      : 'Not in imported data yet'}
                  </div>
                  <div className="ifs">
                    {r.soNumber || '—'}
                    {r.packedStatus && <span className="docdate"> · {r.packedStatus}</span>}
                  </div>
                  <div className="custodyMeta">
                    <span className={'pill ' + (r.stale ? 'warn' : 'fresh')}>
                      {state === 'with_warehouse' ? 'out' : 'in'} {ago(r.lastScan)}
                    </span>
                    {r.boxes > 0 && <span className="boxTag">📦 {r.boxes} · {r.boxWeight} lb</span>}
                    <LabelButtons info={{ ifNumber: r.ifNumber, soNumber: r.soNumber, customer: r.customer, poNumber: r.poNumber }} />
                  </div>
                  <Boxes r={r} onSaved={refresh} />
                </div>
              ))}
              {!items.length && <div className="empty">Nothing here.</div>}
            </div>
          )
        })}
      </div>
      {!rows.length && <div className="empty">The custody register is empty — nothing’s been scanned into the bay.</div>}
    </div>
  )
}
