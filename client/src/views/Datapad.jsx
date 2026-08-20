import { useEffect, useRef, useState } from 'react'
import { fetchTraceRecent, searchTraceSubjects } from '../api.js'
import TraceView from '../TraceView.jsx'
import { pushTrail, labelFor } from '../../../src/model/trace.js'

// Datapad — THE TRACE SURFACE (Nima, 2026-08-20).
//
//   "we want in every case if possible when looking at an item to get its full
//    history. whether it be an email we want to see the link, a fulfilment the
//    related invoice, SO. we were imagining something interconnected so we can hop
//    from one spot to another."
//
// It used to be a flat list of every note. That list is still reachable — as the
// `notes` filter over the front door — but it is no longer what this page IS.
//
// ⚠️ THE LANDING STATE IS THE ONE REAL DESIGN PROBLEM, and notes cannot solve it:
// there are 10 notes in the whole database and every one is on an email. So the
// front door is RECENT ACTIVITY, which the ledger already knows, with notes as one
// filter over it. Raised with Nima 2026-08-20; he did not object.
//
// ⚠️ The Ledger is NOT folded in here. Nima: "the ledger was always intended to be
// more of a curative type document of our journey with no real purpose." Left alone.

const shortWhen = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')

export default function Datapad({ onNavigate, handoffTrace, onHandoffTaken }) {
  // The trail IS the state — its last entry is the subject. Keeping one list
  // rather than a subject plus a history means the two can never disagree.
  const [trail, setTrail] = useState([])
  const [recent, setRecent] = useState(null)
  const [notesOnly, setNotesOnly] = useState(false)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState(null)
  const searchSeq = useRef(0)

  const subject = trail.length ? trail[trail.length - 1] : null
  const hop = (ref) => setTrail((t) => pushTrail(t, ref))

  useEffect(() => {
    setRecent(null)
    fetchTraceRecent({ limit: 60, notesOnly }).then(setRecent).catch(() => setRecent([]))
  }, [notesOnly])

  // A subject handed over from the drawer's ⤢ button. Taken ONCE and then cleared in
  // App, so "← back to recent" actually goes back instead of being re-seeded on the
  // next render — a handoff is an event, not a standing prop.
  useEffect(() => {
    if (!handoffTrace) return
    setTrail([{ docType: handoffTrace.docType, docNumber: handoffTrace.docNumber }])
    onHandoffTaken?.()
  }, [handoffTrace, onHandoffTaken])

  // Debounced search. The sequence guard drops a slow response that lands after a
  // newer one — otherwise typing fast leaves the results of a shorter prefix on
  // screen under a longer query.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setHits(null); return }
    const seq = ++searchSeq.current
    const id = setTimeout(() => {
      searchTraceSubjects(term)
        .then((rows) => { if (seq === searchSeq.current) setHits(rows) })
        .catch(() => { if (seq === searchSeq.current) setHits([]) })
    }, 180)
    return () => clearTimeout(id)
  }, [q])

  function pick(ref) {
    setQ('')
    setHits(null)
    // Picking from search starts a FRESH trail. It is a new line of enquiry, not
    // a hop from where you were, and pretending otherwise would draw a path
    // between two things that have nothing to do with each other.
    setTrail([{ docType: ref.docType, docNumber: ref.docNumber }])
  }

  return (
    <div className="datapad">
      <h2>Datapad</h2>
      <p className="hint">
        Pick anything — an order, a confirmation, a fulfilment, an invoice, an email, a task — and
        get its <b>data packet</b>: its whole history, what the data relates it to, what someone
        attached by hand, and your notes. Every reference is a hop.
      </p>

      <div className="traceSearch">
        <input className="traceSearchInput" value={q} autoComplete="off"
               placeholder="Search a document number, a customer, an email subject, a task…"
               onChange={(e) => setQ(e.target.value)} />
        {subject && <button className="btnGhost" onClick={() => setTrail([])}>← back to recent</button>}
        {hits && (
          <div className="traceHits">
            {!hits.length && <div className="traceHit traceHitEmpty">Nothing matches “{q}”.</div>}
            {hits.map((h) => (
              <button key={`${h.docType}:${h.docNumber}`} className="traceHit" onClick={() => pick(h)}>
                <span className="traceHitType mono">{h.docType}</span>
                <span className="traceHitNumber mono">{h.docNumber}</span>
                <span className="traceHitTitle">{h.title || ''}</span>
                {h.detail && <span className="traceHitDetail">{h.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {subject
        ? <TraceView subject={subject} trail={trail} onHop={hop} onNavigate={onNavigate} />
        : (
          <div className="traceLanding">
            <div className="traceLandingHead">
              <div className="traceSectionTitle">
                {notesOnly ? 'Everything you have left a note on' : 'Recent activity'}
                <span className="traceSectionHint">{recent ? recent.length : ''}</span>
              </div>
              <div className="traceFilters">
                <button className={'btnGhost' + (notesOnly ? '' : ' btnOn')} onClick={() => setNotesOnly(false)}>Recent</button>
                <button className={'btnGhost' + (notesOnly ? ' btnOn' : '')} onClick={() => setNotesOnly(true)}>With notes</button>
              </div>
            </div>
            {!recent && <div className="banner">Reading the ledger…</div>}
            {recent && !recent.length && (
              <div className="empty">
                {notesOnly
                  ? 'No notes yet — open anything and the notes box is right there.'
                  : 'Nothing in the ledger yet.'}
              </div>
            )}
            {recent && (
              <div className="traceCards">
                {recent.map((r) => (
                  <button key={`${r.docType}:${r.docNumber}:${r.at}`} className="traceCard traceCardHop"
                          onClick={() => pick(r)}>
                    <div className="traceCardTop">
                      <b className="mono">{r.docNumber}</b>
                      <span className="traceCardType">{labelFor(r.docType)}</span>
                    </div>
                    <div className="traceCardDetail">{r.why}</div>
                    <div className="traceCardWhen">{shortWhen(r.at)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
    </div>
  )
}
