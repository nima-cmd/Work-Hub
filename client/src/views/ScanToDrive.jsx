import { useEffect, useState } from 'react'
import { processScan, bytesToBase64 } from '../lib/scanPipeline.js'
import { planScanFiling, fileScannedDoc, fetchUnfiledPaper } from '../api.js'

// Scan → Drive (Nima, 2026-07-29). Takes ONE multi-page scan (signed Master BOL
// + all the IFs, one Brother pass), segments it by the QR tags, and files each
// document to Google Drive — a per-DC IF split per PO, plus the Master BOL copied
// into every PO folder it covers. Nothing is stored on our server. The engine is
// proven on the real 50-page Bloomingdale's scan (see scanPipeline.js).

const DPI = 150 // enough for reliable QR decode off a scan; keeps split files small

// What still owes paper (step 7). Two lists, never one number.
//
// `due` is the live obligation and starts at zero — filing only became a
// recorded fact on the epoch date, so anything older has no event simply because
// none was ever written, not because the paper is missing. `backlog` is those
// older shipments: real work, but an archive project rather than something you
// are behind on, and collapsed by default so it can't read as a to-do list you
// are failing. See src/model/filing.js for the full argument.
function UnfiledPanel({ unfiled, open, onToggle }) {
  if (!unfiled) return null
  const { due = [], backlog = [], since } = unfiled
  if (!due.length && !backlog.length) return null

  const row = (s) => (
    <tr key={s.ifNumber}>
      <td><b>{s.ifNumber}</b></td>
      <td>{s.customer || <span className="muted">—</span>}</td>
      <td>{s.channel === 'edi' ? `EDI${s.dc ? ` · ${s.dc}` : ''}` : 'Boutique'}</td>
      <td>{s.shippedAt ? new Date(s.shippedAt).toLocaleDateString() : <span className="muted">no ship date</span>}</td>
      <td>{s.ageDays == null ? <span className="muted">—</span> : `${s.ageDays}d`}</td>
    </tr>
  )
  const table = (rows) => (
    <table className="s2dTable">
      <thead><tr><th>IF</th><th>Customer</th><th>Channel</th><th>Shipped</th><th>Age</th></tr></thead>
      <tbody>{rows.map(row)}</tbody>
    </table>
  )

  return (
    <div className="s2dUnfiled">
      {due.length > 0 ? (
        <>
          <div className="s2dRowHead">
            ⚠ {due.length} shipment(s) left with no paper filed
            <span className="muted"> — scan the slips and drop them below</span>
          </div>
          {table(due)}
        </>
      ) : (
        <div className="banner good">✓ Every shipment since {since} has its paper filed.</div>
      )}

      {backlog.length > 0 && (
        <>
          <button className="linkBtn" onClick={onToggle}>
            {open ? '▾' : '▸'} {backlog.length} older shipment(s) from before filing was recorded
          </button>
          {open && (
            <>
              <div className="hint">
                These shipped before {since}, when the app started recording filings. Most
                will already have paper — in a binder, or in Drive from a run that predates
                the log. Nothing here is overdue; it is only unrecorded. Scanning one files
                it and marks it, same as any other slip.
              </div>
              {table(backlog)}
            </>
          )}
        </>
      )}
    </div>
  )
}

export default function ScanToDrive() {
  const [phase, setPhase] = useState('idle') // idle | decoding | plan | uploading | done
  const [progress, setProgress] = useState(null)
  const [plan, setPlan] = useState(null)     // { documents, master, warnings }
  const [bytesByPage, setBytesByPage] = useState({}) // firstPageNum → split Uint8Array
  const [masterBytes, setMasterBytes] = useState(null)
  const [masterBol, setMasterBol] = useState('')
  const [results, setResults] = useState([]) // per-file upload outcome
  const [error, setError] = useState(null)
  const [fileName, setFileName] = useState('')
  const [unfiled, setUnfiled] = useState(null)
  const [showBacklog, setShowBacklog] = useState(false)

  // What still owes paper. Re-read after a filing run so the list shrinks as you
  // work rather than lying until the next page load.
  const loadUnfiled = () => fetchUnfiledPaper().then(setUnfiled).catch(() => setUnfiled(null))
  useEffect(() => { loadUnfiled() }, [])

  async function onFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setError(null); setResults([]); setPlan(null); setFileName(f.name)
    setPhase('decoding'); setProgress({ phase: 'raster', page: 0, total: 0 })
    try {
      const bytes = new Uint8Array(await f.arrayBuffer())
      const { documents, orphanPages, orphanBytes } = await processScan(bytes, {
        dpi: DPI,
        onProgress: (p) => setProgress(p),
      })
      // Index each document's split bytes by its first page so we can pair them
      // back to the server's plan.
      const byPage = {}
      for (const d of documents) byPage[d.pageNums[0]] = d.bytes
      setBytesByPage(byPage)

      // The leading QR-less pages are the signed Master BOL (already split).
      const segments = documents.map((d) => ({ qr: d.qr, pageNums: d.pageNums, proNumbers: d.proNumbers || [] }))
      if (orphanPages.length) segments.unshift({ qr: null, pageNums: orphanPages, orphan: true })
      setMasterBytes(orphanBytes)

      const p = await planScanFiling(segments)
      setPlan(p)
      setMasterBol(p.master?.suggestedBol || '')
      setPhase('plan')
    } catch (err) {
      setError(err.message); setPhase('idle')
    }
  }

  async function upload() {
    setPhase('uploading'); setError(null)
    const out = []
    const push = (r) => { out.push(r); setResults([...out]) }
    try {
      for (const d of plan.documents) {
        if (d.skip) {
          // Only things we genuinely can't place land here now. Name it when we
          // can: "IF7441" waiting on a sync is a different problem from a QR we
          // don't recognise at all.
          push({
            name: d.collision
              ? `${d.ifNumber || d.qr || 'document'} → ${d.collision}`
              : d.ifNumber ? `${d.ifNumber}${d.customer ? ` · ${d.customer}` : ''}` : `${d.raw} (unrecognised)`,
            status: 'skipped',
            note: d.collision
              ? `another document in this scan already files as ${d.collision} — held instead of overwriting it`
              : d.ifNumber && d.known === false
                ? 'not in the app yet — press ↻ Refresh NetSuite and re-scan'
                : 'couldn’t resolve its customer and order — not filed rather than filed wrong',
          })
          continue
        }
        const bytes = bytesByPage[d.pageNums[0]]
        if (!bytes) { push({ name: d.filename, status: 'error', note: 'no bytes for this document' }); continue }
        // ⚠️ EACH DOCUMENT IS ISOLATED (2026-07-31). This try used to sit OUTSIDE
        // the loop, so the first document that threw ended the whole run: a real
        // 15-slip Bloomingdale's scan filed 3 and silently abandoned 12, and two
        // DCs were never attempted at all. One bad document must cost one row,
        // never the remaining stack.
        try {
          const r = await fileScannedDoc({
            partner: d.partner, pos: d.pos, filename: d.filename,
            pdfBase64: bytesToBase64(bytes), root: d.root,
            ifNumber: d.ifNumber, soNumber: d.soNumber, po: d.po, dc: d.dc,
          })
          push(mapResult(d.filename, `${d.partner}/${d.pos[0]}`, r))
        } catch (err) {
          push({ name: d.filename, status: 'error', note: err.message || 'upload failed — the rest of the stack continued' })
        }
      }
      // Master BOL — needs a confirmed number (no QR to read it from).
      if (plan.master && masterBytes) {
        if (!masterBol.trim()) {
          push({ name: 'Master BOL', status: 'skipped', note: 'enter the BOL # to file it' })
        } else {
          const filename = `${masterBol.trim()} master BOL.pdf`
          try {
            const r = await fileScannedDoc({ partner: plan.master.partner, pos: plan.master.pos, filename, pdfBase64: bytesToBase64(masterBytes) })
            push(mapResult(filename, `${plan.master.partner}/${plan.master.pos.length} PO folders`, r))
          } catch (err) {
            push({ name: filename, status: 'error', note: err.message || 'upload failed' })
          }
        }
      }
      setPhase('done')
      loadUnfiled()
    } catch (err) {
      setError(err.message); setPhase('plan')
    }
  }

  // Say what actually went wrong. This used to collapse every failure to
  // "upload failed" and every 403 to "re-auth needed" — but Drive returns 403
  // for rate limits too, so a throttled upload told Nima to go re-authorise
  // something that was working fine.
  function mapResult(name, where, r) {
    if (r.ok) {
      const replaced = r.uploaded?.some((u) => u.replaced)
      return { name, status: 'ok', note: replaced ? `${where} (replaced an existing file)` : where, links: r.uploaded }
    }
    if (r.configured === false) return { name, status: 'error', note: 'Drive not configured (no refresh token)' }
    if (r.needsReauth) {
      return { name, status: 'error', note: `Drive refused this (${r.reason || 'forbidden'}) — re-run scripts/connect-gmail.js` }
    }
    const rate = r.reason && /rate|quota/i.test(r.reason)
    return {
      name,
      status: 'error',
      note: rate
        ? `Drive throttled this${r.where ? ` on ${r.where}` : ''} even after retries — file it again in a moment`
        : `${r.where || 'upload'} failed${r.status ? ` (${r.status}` : ''}${r.reason ? ` ${r.reason}` : ''}${r.status ? ')' : ''}`,
    }
  }

  const edi = plan?.documents?.filter((d) => d.kind === 'edi') || []
  const slips = plan?.documents?.filter((d) => d.kind === 'slip') || []
  const boutique = plan?.documents?.filter((d) => d.kind === 'boutique') || []

  return (
    <div className="scanToDrive">
      <div className="s2dHead">
        <h3>📄 Scan → Drive</h3>
        <p className="hint">
          Scan the whole stack (signed Master BOL on top, then each DC’s IFs behind its QR tag) in one Brother pass,
          then drop the PDF here. It splits by QR and files to Google Drive — nothing is kept on the server.
        </p>
      </div>

      <UnfiledPanel unfiled={unfiled} open={showBacklog} onToggle={() => setShowBacklog((o) => !o)} />

      <label className="importBtn big s2dPick">
        {phase === 'decoding' ? 'Reading…' : 'Choose scan PDF'}
        <input type="file" accept="application/pdf" onChange={onFile} disabled={phase === 'decoding' || phase === 'uploading'} hidden />
      </label>
      {fileName && <div className="s2dFile">📎 {fileName}</div>}

      {phase === 'decoding' && progress && (
        <div className="banner">
          {progress.phase === 'split'
            ? `Splitting document ${progress.page} / ${progress.total}`
            : `Decoding page ${progress.page} / ${progress.total || '…'}`}
        </div>
      )}
      {error && <div className="banner error">⚠ {error}</div>}

      {plan && phase !== 'done' && (
        <div className="s2dPlan">
          {plan.warnings?.map((w, i) => <div key={i} className="banner warn">⚠ {w}</div>)}

          {plan.master && (
            <div className="s2dMaster">
              <div className="s2dRowHead">Master BOL <span className="muted">→ copied into {plan.master.pos.length} PO folder(s): {plan.master.pos.join(', ')}</span></div>
              <label className="s2dBolInput">
                BOL #
                <input value={masterBol} onChange={(e) => setMasterBol(e.target.value)} placeholder="e.g. NB1731240 (read it off the page)" />
              </label>
              {!plan.master.suggestedBol && <div className="hint">No match found — type the number printed on the master BOL.</div>}
            </div>
          )}

          <div className="s2dRowHead">{edi.length} EDI document(s)</div>
          <table className="s2dTable">
            <thead><tr><th>File</th><th>Partner / PO</th><th>Pages</th></tr></thead>
            <tbody>
              {edi.map((d, i) => (
                <tr key={i}>
                  <td>{d.filename}</td>
                  <td>
                    {d.partner} · {d.po}{d.dc ? ` · ${d.dc}` : ' (PO-level)'}
                    {d.ifNumber && <span className="cust"> · from {d.ifNumber}</span>}
                  </td>
                  <td>{d.pageNums.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {slips.length > 0 && (
            <>
              <div className="s2dRowHead">
                {slips.length} boutique packing slip(s)
                <span className="muted"> → Packing Slips / customer / sales order</span>
              </div>
              <table className="s2dTable">
                <thead><tr><th>File</th><th>Customer / Order</th><th>Pages</th></tr></thead>
                <tbody>
                  {slips.map((d, i) => (
                    <tr key={i}>
                      <td>{d.filename}</td>
                      <td>
                        {d.customer} · {d.soNumber}
                        {d.customerPo && <span className="cust"> · PO {d.customerPo}</span>}
                      </td>
                      <td>{d.pageNums.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {boutique.length > 0 && (
            <div className="hint">
              {boutique.length} document(s) skipped — {boutique.map((d) => d.ifNumber || d.raw).join(', ')}.
              Not filed rather than filed somewhere wrong.
            </div>
          )}

          <button className="importBtn big" onClick={upload} disabled={phase === 'uploading'}>
            {phase === 'uploading' ? 'Filing to Drive…' : `⬆ File ${edi.length + slips.length + (plan.master ? 1 : 0)} document(s) to Drive`}
          </button>
        </div>
      )}

      {results.length > 0 && (
        <div className="s2dResults">
          {results.map((r, i) => (
            <div key={i} className={'s2dResult ' + r.status}>
              <b>{r.status === 'ok' ? '✓' : r.status === 'skipped' ? '↷' : '⚠'} {r.name}</b>
              <span className="muted"> — {r.note}</span>
              {r.links?.map((l, j) => l.link && <a key={j} href={l.link} target="_blank" rel="noreferrer" className="s2dLink"> open</a>)}
            </div>
          ))}
        </div>
      )}
      {phase === 'done' && <div className="banner good">✓ Done. {results.filter((r) => r.status === 'ok').length} filed to Drive.</div>}
    </div>
  )
}
