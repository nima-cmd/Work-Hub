import { useEffect, useState } from 'react'
import { fetchCatalogueGaps, catalogueAddFileUrl } from '../api.js'

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
          No catalogue imported yet. Use <b>⤓ Import CSV</b> to load the catalogue export
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
