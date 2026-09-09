// client/src/views/PackingSlipImport.jsx — drop a factory slip, look at it, then
// generate the two NetSuite CSVs.
//
// Nima, 2026-09-09, on moving this out of Naghedi-Warehouse: "the big thing im
// seeing is i have to go to that app just to translate the packing slip into a
// version i can bring into netsuite ... also with this in the app we can check if we
// over-received if the import did anything weird or if it didn't do what we
// expected."
//
// ⚠️ SO THE CHECKS ARE THE SCREEN, NOT A FOOTNOTE. The app it replaces was a
// download button: pick a file, get two CSVs, no idea whether they were right. Every
// guard in src/model/itemReceiptCsv.js was paid for by a failed import, and each one
// gets its own visible block here — including the ones that are merely worth knowing.
//
// ⚠️ AND THE DOWNLOAD IS WITHHELD WHEN `blocked`. An over-receive or a duplicate SKU
// puts units on a PO line that cannot hold them, and NetSuite accepts it silently
// until a count disagrees weeks later. A greyed button with the reason beside it is
// the whole point of doing this here instead of there.

import { useEffect, useMemo, useState } from 'react'
import { previewPackingSlip, commitPackingSlip, fetchPackingSlips } from '../api.js'

const n = (v) => Number(v || 0).toLocaleString()

function download(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const toBase64 = (bytes) => {
  // Chunked because String.fromCharCode(...a 2 MB array) blows the argument limit.
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * One findings block.
 *
 * ⚠️ AN EMPTY LIST RENDERS NOTHING, and a non-empty one can never be collapsed away.
 * The failure mode this screen exists to prevent is a real finding sitting behind a
 * disclosure triangle nobody opened.
 */
function Findings({ title, tone, rows, render, note }) {
  if (!rows?.length) return null
  return (
    <div className={`slip-findings ${tone}`}>
      <h4>{title} <span className="slip-count">{rows.length}</span></h4>
      {note && <p className="slip-note">{note}</p>}
      <ul>{rows.map((r, i) => <li key={i}>{render(r)}</li>)}</ul>
    </div>
  )
}

export default function PackingSlipImport() {
  const [file, setFile] = useState(null)          // { name, base64 | text }
  const [num, setNum] = useState('')
  const [date, setDate] = useState('')
  const [preview, setPreview] = useState(null)
  const [phase, setPhase] = useState('idle')      // idle | reading | previewing | ready | committing
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(null)
  const [stored, setStored] = useState([])
  const [showCartons, setShowCartons] = useState(false)

  const loadStored = () => fetchPackingSlips().then(setStored).catch(() => {})
  useEffect(() => { loadStored() }, [])

  // ⚠️ Composed HERE ONLY FOR DISPLAY. The authority is containerLabel() on the
  // server; duplicating the rule in two languages is how the two drift apart. This
  // is shown so nobody discovers the label for the first time inside NetSuite.
  const label = useMemo(() => {
    if (!num) return ''
    return date ? `${num} carton ${date}` : `${num} carton`
  }, [num, date])

  async function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setPreview(null); setSaved(null); setPhase('reading')
    try {
      const isCsv = /\.csv$/i.test(f.name)
      const payload = isCsv
        ? { name: f.name, text: await f.text() }
        : { name: f.name, base64: toBase64(new Uint8Array(await f.arrayBuffer())) }
      setFile(payload)
      // Send with no container fields so the server's filename guess comes back;
      // the fields are then editable and a re-run uses what is in them.
      const p = await previewPackingSlip({ filename: payload.name, base64: payload.base64, text: payload.text })
      setNum(p.containerNum || '')
      setDate(p.containerDate || '')
      setPreview(p)
      setPhase('ready')
    } catch (err) {
      setError(err.message); setPhase('idle')
    }
  }

  async function reparse() {
    if (!file) return
    setError(null); setSaved(null); setPhase('previewing')
    try {
      const p = await previewPackingSlip({
        filename: file.name, base64: file.base64, text: file.text,
        containerNum: num, containerDate: date || null,
      })
      setPreview(p); setPhase('ready')
    } catch (err) {
      setError(err.message); setPhase('ready')
    }
  }

  async function commit() {
    setPhase('committing'); setError(null)
    try {
      const r = await commitPackingSlip({
        filename: file.name, base64: file.base64, text: file.text,
        containerNum: num, containerDate: date || null,
      })
      setSaved(r)
      await loadStored()
      setPhase('ready')
    } catch (err) {
      setError(err.message); setPhase('ready')
    }
  }

  const ir = preview?.itemReceipt
  const tr = preview?.transfer
  const cartonPos = Object.entries(preview?.cartons || {})

  return (
    <section className="slip-import">
      <h2>Packing slip → NetSuite</h2>
      <p className="slip-intro">
        The factory slip becomes an Item Receipt and an Inventory Transfer, and the
        carton breakdown is kept so “which box did this arrive in?” stays answerable.
        Nothing is stored until you commit.
      </p>

      <label className="slip-drop">
        <input type="file" accept=".xlsx,.xls,.csv" onChange={onFile}
               disabled={phase === 'reading' || phase === 'committing'} hidden />
        <span>{file ? file.name : 'Choose a packing slip (.xlsx or .csv)'}</span>
      </label>

      {phase === 'reading' && <p className="slip-note">Reading…</p>}
      {error && <p className="slip-error">{error}</p>}

      {preview && (
        <>
          <div className="slip-ident">
            <label>
              Container number
              <input value={num} onChange={(e) => setNum(e.target.value)} placeholder="55" />
            </label>
            <label>
              Date as printed
              <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="2026.9.7" />
            </label>
            <button onClick={reparse} disabled={phase === 'previewing' || !num}>Re-check</button>
          </div>
          {/* ⚠️ THE LABEL IS SHOWN BECAUSE IT IS LOAD-BEARING. It is the identity of
              the stored container and it is embedded in every External ID, so a wrong
              one imports cleanly and then cannot be paired with its own transfer.
              The bare number is what belongs in the field — not the filename. */}
          <p className="slip-label">
            NetSuite will hold <code>{label}</code> — so <code>EXT-IR-{label}&lt;po&gt;</code> and <code>EXT-{label}&lt;po&gt;</code>.
          </p>

          <div className="slip-totals">
            <span><b>{n(preview.unitCount)}</b> units</span>
            <span><b>{preview.cartonCount == null ? '—' : n(preview.cartonCount)}</b> cartons</span>
            <span><b>{preview.poNumbers?.length || 0}</b> POs · {preview.poNumbers?.join(', ')}</span>
            <span className="slip-format">{preview.format === 'master' ? 'master packing list' : 'factory slip'}</span>
          </div>
          {/* ⚠️ A master list CANNOT carry cartons — it is a different document, not a
              slip with the boxes left out. Saying "0 cartons" would assert that the
              shipment had no boxes. */}
          {preview.cartonCount == null && (
            <p className="slip-note">
              A master packing list carries no carton breakdown at all, so the box
              lookup will have nothing to say about this container. The CSVs are
              unaffected — neither one uses cartons.
            </p>
          )}

          {preview.revision?.changed && (
            <div className="slip-findings warn">
              <h4>This container is already stored, with different numbers</h4>
              <ul>{preview.revision.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
              <p className="slip-note">
                Committing replaces the lines and cartons and records this change.
                If an Item Receipt already went to NetSuite, it went on the old numbers.
              </p>
            </div>
          )}
          {preview.revision && !preview.revision.isNew && !preview.revision.changed && (
            <p className="slip-note">Already stored, and identical — committing changes nothing.</p>
          )}

          {/* ── the guards ───────────────────────────────────────────────── */}
          <Findings
            title="Over-receive — this BLOCKS the files" tone="bad" rows={ir.overReceives}
            note="More units shipped than the PO line has left. Compared against remaining, not gross ordered, so a partially-received PO cannot hide a second shipment of the same units."
            render={(r) => `${r.poNumber} ${r.sku}: ${n(r.shipped)} shipped, ${n(r.remaining)} remaining (${n(r.ordered)} ordered − ${n(r.received)} received) — ${n(r.excess)} too many`}
          />
          <Findings
            title="One SKU on two PO lines — this BLOCKS the files" tone="bad" rows={ir.duplicateSkus}
            note="The receipt cannot target one of two identical lines, and guessing would receive against the wrong one. Handle these by hand in NetSuite."
            render={(r) => `${r.poNumber}: ${r.skus.join(', ')}`}
          />
          <Findings
            title="PO not open in NetSuite" tone="warn" rows={ir.unknownPOs}
            note="No order lines to build against — almost always already fully received or closed. Left off the RECEIPT. Its units still TRANSFER, because they are in China and they are moving."
            render={(r) => `${r.poNumber}: ${r.skuCount} SKUs, ${n(r.units)} units`}
          />
          <Findings
            title="Shipped, but no open line on that PO" tone="warn" rows={ir.unmatchedLines}
            note="Already received, the wrong PO, or a size never ordered. Off both files — these units were never received, so there is nothing to move. Worth a physical look."
            render={(r) => `${r.poNumber} ${r.sku}: ${n(r.qty)} units`}
          />
          <Findings
            title="Transferring to a guessed destination" tone="warn" rows={tr.missingDestinations}
            note="The PO has no Final Naghedi Destination, so the transfer falls back to the receiving location. This is what physically moves the stock in the books — fill the field in NetSuite before importing."
            render={(r) => `${r.poNumber}: ${n(r.units)} units → ${r.fallbackLocation} (fallback)`}
          />
          <Findings
            title="Not inventory — left off both files" tone="info" rows={ir.excluded}
            note="Stickers and hangtags are real carton contents but are not tracked items, so they are kept in the box map and never reach a receipt."
            render={(r) => `${r.poNumber} ${r.sku}: ${n(r.units)}`}
          />
          <Findings
            title="Rows the parser could not read" tone="warn" rows={preview.skipped}
            note="Surfaced rather than dropped silently — a quantity with no style is either packing material or a column that shifted."
            render={(r) => typeof r === 'string' ? r : JSON.stringify(r)}
          />

          {/* ── the files ────────────────────────────────────────────────── */}
          <div className="slip-files">
            <div>
              <h4>1 · {ir.filename}</h4>
              <p className="slip-note">{n(ir.rows)} rows across {ir.poCount} POs — Receive = T for what shipped, F for every other still-open line.</p>
              <button onClick={() => download(ir.csv, ir.filename)} disabled={preview.blocked}>Download</button>
            </div>
            <div>
              <h4>2 · {tr.filename}</h4>
              <p className="slip-note">{n(tr.rows)} rows across {tr.poCount} POs — China → each PO’s destination.</p>
              <button onClick={() => download(tr.csv, tr.filename)} disabled={preview.blocked}>Download</button>
            </div>
          </div>
          {/* ⚠️ ORDER IS NOT A PREFERENCE. You cannot transfer units NetSuite does not
              yet believe it has, so a transfer imported first fails or moves nothing. */}
          <p className="slip-note">
            <b>Import the receipt first.</b> The transfer moves units NetSuite has to
            already believe it owns.
          </p>
          {preview.blocked && (
            <p className="slip-error">
              Downloads are withheld until the blocking findings above are resolved.
              Both put units on a PO line that cannot hold them, and NetSuite would
              accept the file without complaint.
            </p>
          )}

          {/* ── the half neither file carries ───────────────────────────── */}
          {cartonPos.length > 0 && (
            <div className="slip-cartons">
              <h4>
                What is in which box
                <button className="slip-linkish" onClick={() => setShowCartons(!showCartons)}>
                  {showCartons ? 'hide' : `show ${cartonPos.reduce((a, [, b]) => a + b.length, 0)} boxes`}
                </button>
              </h4>
              <p className="slip-note">
                Neither CSV uses this. It is stored so an item can be traced back to a
                container and a box months later — NetSuite records the receipt, not
                the packing.
              </p>
              {showCartons && cartonPos.map(([po, boxes]) => (
                <div key={po} className="slip-carton-po">
                  <b>PO{String(po).replace(/^PO/i, '')}</b>
                  <ul>{boxes.map((b) => (
                    <li key={b.box}>box {b.box}: {b.items.map((i) => `${i.sku} ×${i.qty}`).join(', ')}</li>
                  ))}</ul>
                </div>
              ))}
            </div>
          )}

          <div className="slip-commit">
            <button onClick={commit} disabled={phase === 'committing' || !num}>
              {phase === 'committing' ? 'Storing…' : `Store ${label}`}
            </button>
            {saved && (
              <span className="slip-ok">
                Stored {saved.containerLabel} · {saved.lines} lines
                {saved.changed ? ' · revision recorded' : ''}
              </span>
            )}
          </div>
        </>
      )}

      {stored.length > 0 && (
        <div className="slip-stored">
          <h4>Stored containers</h4>
          <table>
            <thead><tr><th>Container</th><th>Units</th><th>Cartons</th><th>POs</th><th>Imported</th><th /></tr></thead>
            <tbody>
              {stored.map((s) => (
                <tr key={s.containerLabel}>
                  <td>{s.containerLabel}</td>
                  <td>{n(s.unitCount)}</td>
                  <td>{s.cartonCount == null ? '—' : n(s.cartonCount)}</td>
                  <td>{(s.poNumbers || []).join(', ')}</td>
                  <td>{s.importedAt ? new Date(s.importedAt).toLocaleDateString() : ''}</td>
                  <td>{s.revisions > 0 ? `${s.revisions} revision${s.revisions > 1 ? 's' : ''}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
