// The trace DRAWER — the same trace, over the page you are already on.
//
// Nima, 2026-08-20: the Datapad is a PLACE you go, and that is wrong in the middle
// of work. You are on Mission Quests working the board, you see IF7486, you want its
// story, and you do not want to lose your scroll position, your open card, or your
// train of thought to get it. So the drawer slides over the right-hand side, and ✕
// puts you back exactly where you were.
//
// ⚠️ ONE COMPONENT, TWO PRESENTATIONS. This renders the SAME TraceView the Datapad
// renders — `compact` stacks its four sections into one column and changes nothing
// else. Two implementations of "show me a trace" would drift within a week.
//
// Opened through a context rather than a prop, because the thing that opens it is
// NsLink, which appears 46 times across 13 views. Threading a callback through all of
// them would mean every view that ever prints a document number has to know the
// drawer exists.

import { useCallback, useEffect, useMemo, useState } from 'react'
import TraceView from './TraceView.jsx'
import { pushTrail, traceTypeFor, labelFor } from '../../src/model/trace.js'
// ⚠️ The context lives in its own module on purpose — see the header there. Do not
// move it back in here; it makes lib → TraceDrawer → TraceView → lib.
import { TraceDrawerContext, useTraceDrawer } from './traceDrawerContext.js'

export { useTraceDrawer }

export function TraceDrawerProvider({ children, onNavigate }) {
  // The trail IS the state, exactly as in the Datapad — its last entry is the
  // subject. One list, so the subject and the way back cannot disagree.
  const [trail, setTrail] = useState([])
  const subject = trail.length ? trail[trail.length - 1] : null

  const open = useCallback((ref) => {
    if (!ref?.docType || !ref?.docNumber) return
    // A fresh open REPLACES the trail. It is a new line of enquiry, not a hop from
    // wherever the last one ended — drawing a path between two unrelated things
    // would make the trail a lie.
    setTrail([{ docType: String(ref.docType).toUpperCase(), docNumber: String(ref.docNumber) }])
  }, [])

  // The entry point for callers that hold only a document number (NsLink). Returns
  // false when the number is not something we can trace, so the caller can keep
  // whatever behaviour it had rather than opening an empty drawer.
  const openDoc = useCallback((docNumber) => {
    const docType = traceTypeFor(docNumber)
    if (!docType) return false
    open({ docType, docNumber })
    return true
  }, [open])

  const hop = useCallback((ref) => setTrail((t) => pushTrail(t, ref)), [])
  const close = useCallback(() => setTrail([]), [])

  // Escape closes. Bound only while the drawer is open, so it cannot swallow Escape
  // from the forms and pickers elsewhere in the app.
  useEffect(() => {
    if (!subject) return undefined
    const onKey = (e) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [subject, close])

  const api = useMemo(() => ({ open, openDoc, close, isOpen: !!subject }), [open, openDoc, close, subject])

  return (
    <TraceDrawerContext.Provider value={api}>
      {children}
      {subject && (
        // The backdrop is deliberately click-through-to-close but NOT a dark scrim
        // over the whole app: the point is that you can still SEE the board you came
        // from, so the drawer reads as a panel over your work rather than a new page.
        <>
          <div className="traceDrawerBack" onClick={close} />
          <aside className="traceDrawer" role="dialog" aria-label={`Data packet for ${subject.docNumber}`}>
            <div className="traceDrawerBar">
              <span className="traceDrawerTitle">
                Data packet <span className="traceDrawerSubject mono">{subject.docNumber}</span>
                <span className="traceDrawerType">{labelFor(subject.docType)}</span>
              </span>
              <div className="traceDrawerBarBtns">
                {/* Hands the current subject to the full page, so a trace worth
                    sitting with is one click from the room it belongs in. */}
                {onNavigate && (
                  <button className="btnGhost" title="Open this data packet full-page in the Datapad"
                          onClick={() => { onNavigate('datapad', subject); close() }}>
                    ⤢ Datapad
                  </button>
                )}
                <button className="btnGhost" onClick={close} title="Close (Esc)">✕</button>
              </div>
            </div>
            <div className="traceDrawerBody">
              {/* onNavigate is deliberately NOT passed down: inside a drawer, "Open
                  in Mission Quests" would navigate the page underneath and throw
                  away the place this drawer exists to preserve. */}
              <TraceView subject={subject} trail={trail} onHop={hop} compact />
            </div>
          </aside>
        </>
      )}
    </TraceDrawerContext.Provider>
  )
}
