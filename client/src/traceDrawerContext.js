// The drawer's context, alone in its own module and importing NOTHING of ours.
//
// ⚠️ THIS FILE EXISTS TO BREAK AN IMPORT CYCLE, which is the only reason it is not
// inside TraceDrawer.jsx. NsLink (lib.jsx) has to be able to open the drawer, the
// drawer renders TraceView, and TraceView renders NsLink — so putting the context
// in TraceDrawer.jsx makes lib → TraceDrawer → TraceView → lib. ES modules tolerate
// that cycle today only because every binding involved happens to be a hoisted
// function; add one module-level const to the wrong file and it evaluates as
// undefined at import time, which surfaces as a blank view rather than an error.
//
// Consumers: TraceDrawer.jsx provides the value, lib.jsx and anything else that
// wants to open a trace consumes it.

import { createContext, useContext } from 'react'

export const TraceDrawerContext = createContext(null)

/**
 * The drawer API — { open, openDoc, close, isOpen } — or null when no provider is
 * mounted. Callers MUST handle null rather than assuming the drawer exists: it is
 * how a surface rendered outside the app shell keeps working.
 */
export function useTraceDrawer() {
  return useContext(TraceDrawerContext)
}
