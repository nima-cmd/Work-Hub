// TraceView — one subject's whole story: history · related · linked · notes.
//
// ONE COMPONENT, TWO PRESENTATIONS (Nima, 2026-08-20): the full page in the
// Datapad, and — next — a right-hand drawer over any other view, so clicking a
// reference never loses your place. Both render this. The `compact` prop is the
// only difference between them, and it changes spacing, never facts.
//
// Everything here is presentation. The rules about what may appear in which
// section live in src/model/trace.js and the assembly in server/queries.js,
// because pure logic in a .jsx is untested logic (PR #64).

import { useEffect, useRef, useState } from 'react'
import { fetchTrace, addNote, deleteNote } from './api.js'
import { NsLink } from './lib.jsx'
import { labelFor } from '../../src/model/trace.js'
import { imagesFor } from './data/characterImages.js'

const shortDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')
const fullDate = (d) => (d ? new Date(d).toLocaleString() : '')

// A related card, or a linked entry — the two look deliberately different, and
// both say what they are.
function RelatedCard({ card, onHop }) {
  const body = (
    <>
      <div className="traceCardTop">
        <b className="mono">{card.docNumber}</b>
        <span className="traceCardType">{labelFor(card.docType)}</span>
      </div>
      {card.title && <div className="traceCardTitle">{card.title}</div>}
      {card.detail && <div className="traceCardDetail">{card.detail}</div>}
    </>
  )
  // A card we cannot open is NOT rendered as a link. `missing` means the document
  // is named on another record but is not in our tables (trace.js rule 2), and a
  // hop that dead-ends is worse than a mention that explains itself.
  if (!card.hoppable) {
    return (
      <div className={`traceCard tone-${card.tone}${card.missing ? ' traceCardMissing' : ''}`}>
        {body}
        {card.url && <a className="btnGhost" href={card.url} target="_blank" rel="noreferrer">↗ track</a>}
      </div>
    )
  }
  return (
    <button className={`traceCard tone-${card.tone} traceCardHop`}
            onClick={() => onHop({ docType: card.docType, docNumber: card.docNumber })}>
      {body}
    </button>
  )
}

function LinkedEntry({ entry, onHop }) {
  if (entry.hoppable) {
    return (
      <button className="traceLink" onClick={() => onHop({ docType: entry.docType, docNumber: entry.docNumber })}>
        <span className="traceLinkGlyph">⛓</span>
        <span className="traceLinkBody">
          <span className="traceLinkLabel">{entry.label}</span>
          <span className="traceLinkHost mono">{entry.docType} {entry.docNumber}</span>
        </span>
      </button>
    )
  }
  return (
    <a className="traceLink" href={entry.url || '#'} target="_blank" rel="noreferrer">
      <span className="traceLinkGlyph">{entry.kind === 'email' ? '✉' : '🗎'}</span>
      <span className="traceLinkBody">
        <span className="traceLinkLabel">{entry.label}</span>
        {/* The host, derived from the URL — never assumed. A link with no host is
            shown as what it is rather than captioned with a guess. */}
        <span className="traceLinkHost">{entry.host || 'link'}</span>
      </span>
    </a>
  )
}

// Notes, always a live composer — there is no empty state, because writing the
// first note IS the action (Nima, 2026-08-20). All 10 existing notes are legacy
// email notes, so most traces land here with nothing.
function TraceNotes({ subject, notes, onChanged }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function save() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true); setErr(null)
    try {
      await addNote({ docType: subject.docType, docNumber: subject.docNumber, note: text })
      setDraft('')
      await onChanged()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    await deleteNote(id)
    await onChanged()
  }

  return (
    <div className="traceSection">
      <div className="traceSectionTitle">Notes <span className="traceSectionHint">yours</span></div>
      <div className="traceNoteList">
        {notes.map((n) => (
          <div key={n.id} className="traceNote">
            <p className="traceNoteText">📌 {n.note}</p>
            <div className="traceNoteFoot">
              <span className="cust" title={fullDate(n.createdAt)}>{shortDate(n.createdAt)}</span>
              {/* A LEGACY note lives in quest_emails.note, not the notes table, so
                  /api/notes has no row to delete. Offering a remove button that
                  silently does nothing is worse than not offering one. */}
              {n.legacy
                ? <span className="traceNoteLegacy" title="Written on the email itself, before the notes table existed">on the email</span>
                : <button className="linkBtn" onClick={() => remove(n.id)}>remove</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="traceNoteCompose">
        <textarea className="traceNoteInput" rows={2} value={draft} placeholder={`Note on ${subject.docNumber}…`}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }} />
        <button className="btn" disabled={!draft.trim() || busy} onClick={save}>{busy ? 'saving…' : 'Save note'}</button>
      </div>
      {err && <div className="banner error">{err}</div>}
    </div>
  )
}

export default function TraceView({ subject, trail = [], onHop, onNavigate, compact = false }) {
  const [trace, setTrace] = useState(null)
  const [err, setErr] = useState(null)
  // Which request is current. Without this, hopping fast lands the SLOWER
  // response last and the page shows a subject you already left.
  const wanted = useRef(null)

  async function load() {
    const key = `${subject.docType}:${subject.docNumber}`
    wanted.current = key
    try {
      const t = await fetchTrace(subject.docType, subject.docNumber)
      if (wanted.current === key) { setTrace(t); setErr(null) }
    } catch (e) {
      if (wanted.current === key) { setErr(e.message); setTrace(null) }
    }
  }
  useEffect(() => { setTrace(null); load() }, [subject.docType, subject.docNumber])

  if (err) return <div className="banner error">{err}</div>
  if (!trace) return <div className="banner">Reading the trace for {subject.docNumber}…</div>

  const s = trace.subject
  const img = s.characterId ? imagesFor(s.characterId)[0] : null

  return (
    <div className={'traceView' + (compact ? ' traceCompact' : '')}>
      {/* The hop trail is the way back. It is where you actually walked, not a
          derived path — a derived one would show a route nobody took. */}
      {trail.length > 1 && (
        <div className="traceTrail">
          {trail.map((t, i) => (
            <span key={`${t.docType}:${t.docNumber}`}>
              {i > 0 && <span className="traceTrailSep">›</span>}
              {i === trail.length - 1
                ? <span className="traceTrailHere mono">{t.docNumber}</span>
                : <button className="traceTrailHop mono" onClick={() => onHop(t)}>{t.docNumber}</button>}
            </span>
          ))}
        </div>
      )}

      <div className={`traceHead tone-${s.tone}`}>
        {img && <div className="chipAvatar"><img src={img} alt="" /></div>}
        <div className="traceHeadBody">
          <div className="traceHeadTop">
            <span className="traceHeadType">{s.typeLabel}</span>
            <b className="traceHeadNumber mono">{s.docNumber}</b>
          </div>
          {s.title && <div className="traceHeadTitle">{s.title}</div>}
          {s.missing && <div className="traceHeadMissing">Not in the database — nothing here but what other records say about it.</div>}
          <div className="traceFacts">
            {(s.facts || []).map((f) => (
              <span key={f.k} className="traceFact"><span className="traceFactK">{f.k}</span> {f.v}</span>
            ))}
          </div>
          {s.snippet && <p className="traceSnippet">{s.snippet}</p>}
        </div>
        <div className="traceHeadActions">
          {s.view && onNavigate && <button className="btn" onClick={() => onNavigate(s.view)}>Open in {s.viewLabel || s.view}</button>}
          {s.gmailUrl && <a className="btnGhost" href={s.gmailUrl} target="_blank" rel="noreferrer">↗ Gmail</a>}
          {['SO', 'IF', 'INV'].includes(s.docType) && <NsLink doc={s.docNumber}>↗ NetSuite</NsLink>}
        </div>
      </div>

      <div className="traceBody">
        <div className="traceSection">
          <div className="traceSectionTitle">History <span className="traceSectionHint">{trace.counts.history}</span></div>
          {!trace.history.length && <div className="empty">No dated events on this yet.</div>}
          <ol className="traceTimeline">
            {trace.history.map((h) => (
              // `own` marks the subject's OWN events. The rest belong to sibling
              // documents on the same order and are shown because an IF's events
              // mean nothing without the order's — each names its own document,
              // so nothing is being attributed to the subject that isn't its.
              <li key={h.id} className={'traceEvent' + (h.own ? ' traceEventOwn' : '')}>
                <span className="traceEventDate mono" title={fullDate(h.occurredAt)}>{shortDate(h.occurredAt)}</span>
                <span className="traceEventLabel">{h.label}</span>
                {!h.own && <span className="traceEventOn mono">{h.docNumber}</span>}
                {h.note && <span className="traceEventNote">{h.note}</span>}
              </li>
            ))}
          </ol>
        </div>

        <div className="traceSection">
          {/* RELATED and LINKED are never merged, and each says where it came
              from — a link someone made must not read as one the data implies. */}
          <div className="traceSectionTitle">Related <span className="traceSectionHint">from the data</span></div>
          {!trace.related.length && <div className="empty">Nothing else in the data points at this.</div>}
          <div className="traceCards">
            {trace.related.map((c) => <RelatedCard key={`${c.docType}:${c.docNumber}`} card={c} onHop={onHop} />)}
          </div>
        </div>

        <div className="traceSection">
          <div className="traceSectionTitle">Linked <span className="traceSectionHint">added by hand</span></div>
          {!trace.linked.length && <div className="empty">Nothing attached by hand.</div>}
          <div className="traceLinks">
            {trace.linked.map((l) => <LinkedEntry key={l.id} entry={l} onHop={onHop} />)}
          </div>
        </div>

        <TraceNotes subject={s} notes={trace.notes} onChanged={load} />
      </div>
    </div>
  )
}
