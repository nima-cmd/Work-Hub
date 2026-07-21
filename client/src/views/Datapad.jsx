import { useEffect, useState } from 'react'
import { fetchLedgerNotes, fetchAllNotes, deleteNote } from '../api.js'
import { imagesFor } from '../data/characterImages.js'

// Datapad (Nima, 2026-07-20, generalized 2026-07-20): sections by doc_type —
// every note left on anything (email, EDI PO, SO, task…), newest first, each
// with a link back to its source. Email notes still come from the richer
// ledger-notes endpoint (character/subject/task info the generic notes table
// doesn't carry); everything else comes from the generic /api/notes table.
const SECTION_LABEL = { EDI_PO: 'EDI', SO: 'Sales Orders', IF: 'Fulfillments', INV: 'Invoices', TASK: 'Tasks' }
const SECTION_VIEW = { EDI_PO: 'edi', SO: 'table', IF: 'table' }

export default function Datapad({ onNavigate }) {
  const [emailNotes, setEmailNotes] = useState(null)
  const [otherNotes, setOtherNotes] = useState(null)
  const [q, setQ] = useState('')

  function load() {
    fetchLedgerNotes().then(setEmailNotes).catch(() => setEmailNotes([]))
    fetchAllNotes().then((rows) => setOtherNotes(rows.filter((n) => n.docType !== 'EMAIL'))).catch(() => setOtherNotes([]))
  }
  useEffect(load, [])

  async function removeOther(id) {
    await deleteNote(id)
    setOtherNotes((prev) => prev.filter((n) => n.id !== id))
  }

  if (!emailNotes || !otherNotes) return <div className="banner">Loading the datapad…</div>

  // Keyword search (Nima, 2026-07-20) — match note text, the doc it's on, its
  // subject, a linked doc, or the messenger, so "net bag" / a PO / a customer
  // surfaces everything across the whole ledger.
  const kw = q.trim().toLowerCase()
  const matches = (n) => !kw || [n.note, n.docNumber, n.subject, n.taskSubject, n.linkedDocNumber, n.character?.name]
    .some((v) => v && String(v).toLowerCase().includes(kw))
  const emails = emailNotes.filter(matches)
  const others = otherNotes.filter(matches)

  const grouped = others.reduce((acc, n) => {
    (acc[n.docType] ||= []).push(n)
    return acc
  }, {})
  const total = emails.length + others.length

  return (
    <div className="datapad">
      <h2>Datapad <span className="count">{total}</span></h2>
      <p className="hint">Every note left on anything — an email, an EDI PO, a sales order — newest first, grouped by what it's on.</p>
      <input className="qtyInput" style={{ width: '100%', maxWidth: 420, margin: '4px 0 14px' }} value={q}
             placeholder="Search notes — a keyword, doc number, customer…" onChange={(e) => setQ(e.target.value)} />
      {!total && <div className="empty">{kw ? `No notes match “${q}”.` : 'No notes saved yet — use ✎ Notes on any card to keep a highlight here.'}</div>}

      {!!emails.length && (
        <div className="datapadSection">
          <div className="datapadSectionTitle">Transmissions</div>
          {emails.map((n) => {
            const img = imagesFor(n.characterId)[0]
            return (
              <div key={n.id} className="datapadEntry">
                <div className="chipAvatar">
                  {img ? <img src={img} alt="" /> : <span className="chipGlyph">◈</span>}
                </div>
                <div className="datapadBody">
                  <div className="chipTop">
                    <b>{n.character?.name || 'Unknown Messenger'}</b>
                    <span className="cust">{n.receivedAt ? new Date(n.receivedAt).toLocaleDateString() : ''}</span>
                  </div>
                  <div className="holoSubject">{n.subject}</div>
                  <p className="ledgerNote">📌 {n.note}</p>
                  <div className="chipActions">
                    <a className="btnGhost" href={`https://mail.google.com/mail/u/0/#all/${n.threadId || n.id}`} target="_blank" rel="noreferrer">↗ Gmail</a>
                    {n.taskId && (
                      <span className={'flag ' + (n.taskStatus === 'done' ? 'sev-lo' : 'sev-mid')}>
                        Task: {n.taskSubject} ({n.taskStatus})
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {Object.entries(grouped).map(([docType, notes]) => (
        <div key={docType} className="datapadSection">
          <div className="datapadSectionTitle">{SECTION_LABEL[docType] || docType}</div>
          {notes.map((n) => (
            <div key={n.id} className="datapadEntry">
              <div className="datapadBody">
                <div className="chipTop">
                  <b className="mono">{n.docNumber}</b>
                  <span className="cust">{n.createdAt ? new Date(n.createdAt).toLocaleDateString() : ''}</span>
                </div>
                <p className="ledgerNote">📌 {n.note}</p>
                {n.linkedDocNumber && <span className="flag sev-lo">↳ {n.linkedDocType} {n.linkedDocNumber}</span>}
                <div className="chipActions">
                  {SECTION_VIEW[docType] && (
                    <button className="btnGhost" onClick={() => onNavigate?.(SECTION_VIEW[docType])}>↗ open</button>
                  )}
                  <button className="linkBtn" onClick={() => removeOther(n.id)}>remove</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
