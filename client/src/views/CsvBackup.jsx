import { useEffect, useRef, useState } from 'react'
import { fetchFreshness, importCsv } from '../api.js'

// The CSV import, and the six saved-search exports it loads.
//
// This used to sit in the app header on EVERY page, graded red, reading
// "5 exports need re-upload". That was misleading and Nima said so
// (2026-08-11): "the export feed is misleading since it's not taking into
// account all the new data being pushed in" and "we're only keeping it as a
// back up".
//
// He is right, and the panel could not have been right: these six exports were
// RETIRED on 2026-07-29 when the live NetSuite sync took over. Nothing re-pulls
// them, so their age only ever climbs, and the pill could never go green no
// matter how current the actual data was. A permanent alarm about a path we
// deliberately stopped using teaches you to distrust the live data next to it.
//
// So: ages are reported as FACTS here, with no status colour and no "re-upload"
// nag. Whether the app's data is current is a question about the live sync, and
// the sync panel above this one already answers it. The import itself is kept
// working, because it is the fallback for a NetSuite outage — that is the only
// reason this section exists.
const fmtAge = (h) => {
  if (h == null) return 'never imported'
  if (h < 1) return `${Math.round(h * 60)} min ago`
  if (h < 24) return `${Math.round(h)}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function CsvBackup({ onRefresh }) {
  const [fresh, setFresh] = useState(null)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState(null)
  const [open, setOpen] = useState(false)
  const fileRef = useRef(null)

  function load() {
    fetchFreshness().then(setFresh).catch(() => {})
  }
  useEffect(load, [])

  async function onFiles(e) {
    const files = [...e.target.files]
    e.target.value = ''
    if (!files.length) return
    setImporting(true)
    setNotice(null)
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, text: await f.text(), lastModified: f.lastModified })),
      )
      const r = await importCsv(payload)
      const unrec = r.files.filter((f) => !f.recognized)
      setNotice({
        ok: true,
        msg:
          `Imported ${r.files.length - unrec.length} file(s): ${r.orders} orders · ${r.fulfillments} fulfillments · ${r.invoices} invoices` +
          (unrec.length ? ` — not recognized: ${unrec.map((u) => u.name).join(', ')}` : ''),
      })
      load()
      onRefresh?.()
    } catch (e2) {
      setNotice({ ok: false, msg: 'Import failed: ' + e2.message })
    } finally {
      setImporting(false)
    }
  }

  const newest = fresh?.sources?.length
    ? Math.min(...fresh.sources.map((s) => (s.ageHours == null ? Infinity : s.ageHours)))
    : null

  return (
    <>
      <h3 className="hlSection">CSV import <span className="muted">· backup path only</span></h3>
      <div className="muted hlSub">
        The app runs on the live NetSuite sync. These {fresh?.sources?.length || 6} saved-search
        exports are the <b>fallback</b> for when that sync can’t run — they were retired on
        2026-07-29 and nothing re-pulls them, so their ages below are expected to be old and
        say nothing about whether the app’s data is current. That question is the sync panel
        above. Import still works; use it if NetSuite is unreachable.
      </div>

      <div className="hlRows">
        <div className="hlRow">
          <span className="hlDot" />
          <div className="hlRowMain">
            <div className="hlRowTop">
              <b>Import saved-search CSVs</b>
              <button className="btnGhost" disabled={importing} onClick={() => fileRef.current?.click()}>
                {importing ? 'Importing…' : '⤓ Import CSV'}
              </button>
              <input ref={fileRef} type="file" accept=".csv" multiple hidden onChange={onFiles} />
            </div>
            <div className="hlPowers">
              {importing
                ? 'Reading and upserting…'
                : notice
                  ? notice.msg
                  : newest == null || newest === Infinity
                    ? 'Nothing has been imported.'
                    : `Last import ${fmtAge(newest)} — retired, not a problem.`}
            </div>
          </div>
        </div>
      </div>

      <button className="btnGhost" style={{ marginTop: 6 }} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} the {fresh?.sources?.length || 6} exports {open ? '▴' : '▾'}
      </button>

      {open && fresh && (
        <div className="hlRows" style={{ marginTop: 6 }}>
          {fresh.sources.map((s) => (
            <div key={s.key} className="hlRow">
              <span className="hlDot" />
              <div className="hlRowMain">
                <div className="hlRowTop">
                  <b>{s.label}</b>
                  {s.url && (
                    <a href={s.url} target="_blank" rel="noreferrer" className="linkBtn">↗ saved search</a>
                  )}
                </div>
                <div className="hlPowers muted">
                  {s.ageHours == null ? 'never imported' : `imported ${fmtAge(s.ageHours)}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
