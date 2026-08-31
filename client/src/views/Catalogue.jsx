import { useEffect, useState } from 'react'
import { fetchCatalogueGaps, catalogueAddFileUrl, fetchHangTags, printHangTags, hangTagPdf } from '../api.js'

// Catalogue (Nima, 2026-07-27) — tracks which open-PO SKUs are uploaded to the
// product catalogue vs not. Import the catalogue export (GTIN/UPC master) and
// every open PO line to a tracked partner (Nordstrom for now) gets flagged
// uploaded ✓ / not uploaded ✗. The "not uploaded" set downloads as a prefilled
// add-file (catalogue columns + everything we have; you fill UPC + description).
export default function Catalogue() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { fetchCatalogueGaps().then(setData).catch((e) => setErr(e.message)) }, [])

  if (err) return <div className="banner error">⚠ {err}</div>
  if (!data) return <div className="banner">Loading catalogue status…</div>

  const pct = data.totalSkus ? Math.round((data.uploaded / data.totalSkus) * 100) : 0
  return (
    <div className="catalogue">
      <HangTags />
      <div className="rt-head">
        <div>
          <h2>Catalogue <span className="muted">· uploaded vs not</span></h2>
          <div className="muted rt-sub">
            Open PO SKUs for {data.partners.join(', ')} checked against the uploaded catalogue master.
            Matched on ProductID + color (= UPC granularity).
          </div>
        </div>
        {data.missingCount > 0 && (
          <a className="btn" href={catalogueAddFileUrl()}>⤓ Download add-file ({data.missingCount})</a>
        )}
      </div>

      {data.catalogueCount === 0 ? (
        <div className="rt-empty">
          No catalogue imported yet. Use <b>⤓ Import CSV</b> on the <b>Health</b> page to load the catalogue export
          (GTIN/UPC master) — then this shows which open PO SKUs still need uploading.
        </div>
      ) : (
        <>
          <div className="cat-stats">
            <Stat n={data.catalogueCount} label="SKUs in catalogue" />
            <Stat n={data.totalSkus} label="on open POs" />
            <Stat n={data.uploaded} label="uploaded" cls="ok" />
            <Stat n={data.missingCount} label="NOT uploaded" cls={data.missingCount ? 'bad' : 'ok'} />
            <Stat n={pct + '%'} label="coverage" />
          </div>
          {data.lastImport && (
            <div className="muted cat-imported">Catalogue last imported {new Date(data.lastImport).toLocaleDateString()}</div>
          )}

          {data.missingCount === 0 ? (
            <div className="banner ok">✓ Every open PO SKU for {data.partners.join(', ')} is in the catalogue.</div>
          ) : (
            <table className="cat-table">
              <thead>
                <tr><th>SKU</th><th>Color</th><th>Color code</th><th>Open PO(s)</th><th className="num">Qty</th></tr>
              </thead>
              <tbody>
                {data.missing.map((m) => (
                  <tr key={m.item}>
                    <td className="mono">{m.item}</td>
                    <td>{m.color}</td>
                    <td>{m.colorCode || <span className="muted">— (fill)</span>}</td>
                    <td className="mono">{m.pos.join(', ')}</td>
                    <td className="num">{m.qty}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ n, label, cls }) {
  return (
    <div className={'cat-stat ' + (cls || '')}>
      <div className="cat-statN">{n}</div>
      <div className="cat-statL muted">{label}</div>
    </div>
  )
}

// ── Hang tags ───────────────────────────────────────────────────────────────
//
// ⚠️ TRANSCRIBED FROM A PHOTOGRAPH, not designed. Nima sent a picture of a real Naghedi
// tag and every field on it was already in the database — product name, style, colour,
// UPC and the Retail Price. src/model/hangTag.js holds the field sources and the refusal
// rules; this is only the picker.
//
// ⚠️ THEY PRINT ON THE SAME 2.25x1.25 ROLL AS THE QR CARGO TAGS. Nima, 2026-08-31: "we
// need it to fit on the label pritner per what we have for qr codeds that was a picture
// to show you information on the tags." My first cut had invented a square stock from the
// shape of the tag in the photo.
//
// ⚠️ PDF BEFORE PRINT, deliberately. A physical label is worth looking at before it goes
// to a roll, and the two are separate endpoints so neither can be mistaken for the other.
function HangTags() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [q, setQ] = useState('')
  const [qty, setQty] = useState({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [showBlocked, setShowBlocked] = useState(false)

  useEffect(() => { fetchHangTags().then(setData).catch((e) => setErr(e.message)) }, [])

  if (err) return <div className="banner error">⚠ Couldn’t load hang tags: {err}</div>
  if (!data) return null

  const term = q.trim().toLowerCase()
  const shown = term
    ? data.tags.filter((t) => `${t.style} ${t.color} ${t.name} ${t.upc}`.toLowerCase().includes(term))
    : data.tags
  const picked = Object.entries(qty).filter(([, n]) => Number(n) > 0)
  const items = picked.map(([skuKey, n]) => ({ skuKey, qty: Number(n) }))
  const totalLabels = items.reduce((a, b) => a + b.qty, 0)

  const run = async (kind) => {
    setBusy(true); setMsg(null)
    try {
      if (kind === 'pdf') {
        const blob = await hangTagPdf(items)
        // ⚠️ Opened, not auto-downloaded — the point is to LOOK at it.
        window.open(URL.createObjectURL(blob), '_blank')
        setMsg(`${totalLabels} tag${totalLabels === 1 ? '' : 's'} rendered.`)
      } else {
        const r = await printHangTags(items)
        setMsg(`✓ sent ${r.printed} label${r.printed === 1 ? '' : 's'} to ${r.queue}.`)
        setQty({})
      }
    } catch (e) { setMsg('✗ ' + e.message) } finally { setBusy(false) }
  }

  return (
    <div className="cat-hangtags">
      <div className="rt-head">
        <div>
          <h2>Hang tags <span className="muted">· UPC · 2.25×1.25</span></h2>
          <div className="muted rt-sub">
            Name, style, colour, UPC-A and the Retail Price — the same roll as the QR cargo tags.
            {' '}{data.tags.length} of {data.total} SKUs can be tagged.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input className="qtyInput" type="search" placeholder="style · colour · UPC" value={q}
                 onChange={(e) => setQ(e.target.value)} />
          <button className="btnGhost" disabled={busy || !items.length} onClick={() => run('pdf')}>
            ⤓ PDF{totalLabels ? ` (${totalLabels})` : ''}
          </button>
          <button className="btn" disabled={busy || !items.length} onClick={() => run('print')}>
            {busy ? 'Working…' : `🖨 Print${totalLabels ? ` ${totalLabels}` : ''}`}
          </button>
        </div>
      </div>
      {msg && <div className={'banner' + (msg.startsWith('✗') ? ' error' : ' ok')}>{msg}</div>}

      {/* ⚠️ THE BLOCKED SKUs ARE SHOWN, not silently absent. 5 of 77 have no Retail Price,
          and a list that quietly holds 72 is how a bag reaches a shelf untagged. */}
      {data.blocked.length > 0 && (
        <div className="muted cat-imported">
          {data.blocked.length} SKU{data.blocked.length === 1 ? '' : 's'} cannot be tagged.{' '}
          <button className="linkBtn" onClick={() => setShowBlocked((v) => !v)}>
            {showBlocked ? 'hide' : 'show why'}
          </button>
          {showBlocked && (
            <ul style={{ margin: '4px 0 0 16px' }}>
              {data.blocked.map((b) => (
                <li key={b.skuKey}>{b.skuKey} — {b.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <table className="cat-table">
        <thead>
          <tr><th>Style</th><th>Colour</th><th>Name</th><th>UPC</th><th className="num">Retail</th><th className="num">Copies</th></tr>
        </thead>
        <tbody>
          {shown.map((t) => (
            <tr key={t.skuKey}>
              <td><b>{t.style}</b></td>
              <td>{t.color}</td>
              <td className="muted">{t.name}</td>
              <td className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>{t.upc}</td>
              <td className="num">{t.price}</td>
              <td className="num">
                <input className="qtyInput" type="number" min="0" max="50" style={{ width: 56 }}
                       value={qty[t.skuKey] ?? ''} placeholder="0"
                       onChange={(e) => setQty((s) => ({ ...s, [t.skuKey]: e.target.value }))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!shown.length && <div className="rt-empty">Nothing matches “{q}”.</div>}
    </div>
  )
}
