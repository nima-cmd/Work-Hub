import { useEffect, useState } from 'react'
import { fetchLedgerNotes } from '../api.js'
import { imagesFor } from '../data/characterImages.js'

// Datapad (Nima, 2026-07-20) — every email note on its own, standalone from
// the inbox: the highlights/summaries worth keeping for later reference, each
// with a link back to its source email and (if it was promoted) the task.
export default function Datapad() {
  const [notes, setNotes] = useState(null)

  useEffect(() => {
    fetchLedgerNotes().then(setNotes).catch(() => setNotes([]))
  }, [])

  if (!notes) return <div className="banner">Loading the datapad…</div>

  return (
    <div className="datapad">
      <h2>Datapad <span className="count">{notes.length}</span></h2>
      <p className="hint">Every note left on an email, newest first — with a link back to the email and, if it became a task, the task.</p>
      {!notes.length && <div className="empty">No notes saved yet — use ✎ Datapad on any transmission to keep a highlight here.</div>}
      {notes.map((n) => {
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
  )
}
