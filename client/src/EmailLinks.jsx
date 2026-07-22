import { useEffect, useState } from 'react'
import { fetchEmailLinks, searchLinkableEmails, addEmailLink, deleteEmailLink } from './api.js'

// Reusable email→document link widget (Nima, 2026-07-22). Drop it onto any
// document — a routing shipment/BOL, an authorization, an order, a task — to
// attach the Gmail message(s) that relate to it (e.g. the Bloomingdale's
// routing email carrying the auth #). Stores only a deep link to Gmail + the
// subject (the link label), never the body. Self-fetching, so it just needs a
// docType + docNumber.
//
//   <EmailLinks docType="ROUTING_SHIPMENT" docNumber={shipment.id} />
export default function EmailLinks({ docType, docNumber, compact }) {
  const [links, setLinks] = useState(null)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState([])
  const [manual, setManual] = useState(false)
  const [mUrl, setMUrl] = useState('')
  const [mSubj, setMSubj] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  function load() {
    fetchEmailLinks(docType, docNumber).then(setLinks).catch(() => setLinks([]))
  }
  useEffect(load, [docType, docNumber])

  async function runSearch(e) {
    e?.preventDefault?.()
    if (!q.trim()) return
    setBusy(true); setErr(null)
    try { setHits(await searchLinkableEmails(q)) } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  async function attach(body) {
    setBusy(true); setErr(null)
    try {
      setLinks(await addEmailLink({ docType, docNumber, ...body }))
      setQ(''); setHits([]); setMUrl(''); setMSubj(''); setManual(false); setOpen(false)
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }
  const attachSynced = (m) => attach({ subject: m.subject, gmailId: m.id, threadId: m.threadId, fromAddr: m.fromAddress })
  const attachManual = () => { if (mUrl.trim()) attach({ subject: mSubj.trim() || mUrl.trim(), gmailUrl: mUrl.trim() }) }

  async function unlink(id) {
    setBusy(true)
    try { setLinks(await deleteEmailLink(id, docType, docNumber)) } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  const list = links || []

  return (
    <div className={'emailLinks' + (compact ? ' compact' : '')}>
      <div className="elRow">
        <span className="elIcon" title="Linked emails">✉</span>
        {list.map((l) => (
          <span key={l.id} className="elChip">
            <a href={l.gmailUrl} target="_blank" rel="noreferrer" title={l.fromAddr || 'open in Gmail'}>
              {l.subject || 'email'}
            </a>
            <button className="elX" title="Unlink" disabled={busy} onClick={() => unlink(l.id)}>✕</button>
          </span>
        ))}
        <button className="elAdd" onClick={() => setOpen((o) => !o)}>{open ? '× close' : '🔗 link email'}</button>
      </div>

      {open && (
        <div className="elPanel">
          {!manual ? (
            <>
              <form className="elSearch" onSubmit={runSearch}>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search your Gmail — subject, sender…" />
                <button className="btnGhost" disabled={busy || !q.trim()}>Search</button>
              </form>
              <div className="elHits">
                {hits.map((m) => (
                  <button key={m.id} className="elHit" disabled={busy} onClick={() => attachSynced(m)}>
                    <span className="elHitSubj">{m.subject || '(no subject)'}</span>
                    <span className="elHitMeta">{m.fromName || m.fromAddress}{m.receivedAt ? ` · ${new Date(m.receivedAt).toLocaleDateString()}` : ''}</span>
                  </button>
                ))}
                {q && !hits.length && !busy && <div className="elEmpty muted">No matches in synced mail — or <button className="elLinkBtn" onClick={() => setManual(true)}>paste a Gmail link</button>.</div>}
              </div>
              {!q && <button className="elLinkBtn" onClick={() => setManual(true)}>or paste a Gmail link manually</button>}
            </>
          ) : (
            <div className="elManual">
              <input value={mUrl} onChange={(e) => setMUrl(e.target.value)} placeholder="paste the Gmail URL" />
              <input value={mSubj} onChange={(e) => setMSubj(e.target.value)} placeholder="subject (link label)" />
              <div className="elManualBtns">
                <button className="btn" disabled={busy || !mUrl.trim()} onClick={attachManual}>Link</button>
                <button className="btnGhost" onClick={() => setManual(false)}>← search instead</button>
              </div>
            </div>
          )}
          {err && <div className="elErr">⚠ {err}</div>}
        </div>
      )}
    </div>
  )
}
