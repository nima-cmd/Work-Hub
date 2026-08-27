// client/src/lib/ScanToNetsuite.jsx — scan a tag from ANY view, open the record in
// NetSuite in a new window.
//
// Nima, 2026-08-27: "the ability to scan our qr code outside of scan bay that will pop
// up the order in netsuite in a new window for us to work in."
//
// It is ALSO the backup custody scan (Nima, 2026-08-27): "if we miss a rescan back in
// it marks it as in our possession." Splash, Match at The Breakers and Rescue Spa all
// missed their scan back in, and the miss is only ever noticed later — so the scan you
// DO make should close the gap.
//
// ⚠️ IT OFFERS THE CUSTODY WRITE, IT NEVER MAKES ONE (Nima, 2026-08-27: "maybe its
// better if we have it pop a warning and let us choose ... in case i accidently scan to
// make an edit before giving it to him"). He is right, and for more reasons than that:
//
//   · this button is reachable from EVERY view, which is its whole point — so a write
//     that fires on any scan will eventually fire by accident, far more often than in
//     Scan Bay where a direction is chosen deliberately;
//   · scanning something on its way OUT and recording IN closes a custody loop that
//     never actually closed;
//   · and the date would be wrong anyway. order_events forbids backfilling a guessed
//     date, so a backup scan made three days late is DATED three days late — the
//     warehouse calendar counts "held since" from it and would understate the wait.
//
// So the state is READ (never probed by writing), shown, and a human decides. The
// offer only appears for the one state where it is the right thing: handed out, never
// scanned back, not departed.
//
// ⚠️ The custody write NEVER blocks the NetSuite open. Opening the record is what you
// asked for; the custody row is the bonus. A failed write reports itself and the window
// still opens.
//
// ⚠️ THE POPUP IS THE HARD PART, AND IT IS NOT A DETAIL. A QR decode happens inside a
// requestAnimationFrame callback, which is NOT a user gesture — so `window.open()` from
// there is blocked by default in every modern browser, silently, returning null. Built
// naively this feature would appear to do nothing at all and read as a broken scanner.
//
// So: the open is ATTEMPTED, and whether or not it was blocked the resolved record is
// shown with a real anchor the user can click. A click IS a gesture, so the fallback
// always works. `window.open` returning null is the only reliable signal of a block —
// there is no event and no error.
import { useCallback, useState } from 'react'
import { useQrCamera } from './useQrCamera.js'
import { recordCustodyScan, fetchCustodyState } from '../api.js'

// The server owns the account id, the recordtype→page table and the lookup, and
// answers failures in WORDS rather than a broken redirect (server/index.js).
const nsHref = (doc) => `/api/netsuite/open?doc=${encodeURIComponent(doc)}`

export default function ScanToNetsuite() {
  const [open, setOpen] = useState(false)
  const [hit, setHit] = useState(null)      // { doc, blocked }
  const [manual, setManual] = useState('')

  const openDoc = useCallback(async (raw) => {
    const doc = String(raw || '').trim()
    if (!doc) return
    // ⚠️ OPEN FIRST. window.open must be as close to the user gesture as possible —
    // awaiting anything before it guarantees a blocked pop-up on the manual path, which
    // is the one path that would otherwise have worked.
    // ⚠️ Passed to the server RAW. normalizeDoc and the recordtype table live there,
    // and a second normalisation on the client is the thing that drifts.
    const w = window.open(nsHref(doc), '_blank', 'noopener')
    setHit({ doc, blocked: !w, state: null, note: null })

    // ⚠️ READ, never a write-probe. Asking recordCustodyScan "is this already in?" and
    // reading `ignored` would WRITE whenever the answer was no — the exact case worth
    // asking about.
    try {
      const st = await fetchCustodyState(doc)
      setHit((h) => (h && h.doc === doc ? { ...h, state: st } : h))
    } catch (e) {
      setHit((h) => (h && h.doc === doc ? { ...h, note: `couldn't read custody: ${e.message}` } : h))
    }
  }, [])

  // Only ever called from a real click.
  const markIn = useCallback(async (doc) => {
    setHit((h) => (h && h.doc === doc ? { ...h, note: 'recording…' } : h))
    try {
      const r = await recordCustodyScan({
        docNumber: doc, direction: 'IN',
        note: 'backup scan-in, entered by hand from Scan → NetSuite — dated when SCANNED, not when it came back',
      })
      setHit((h) => (h && h.doc === doc
        ? { ...h, note: r?.ignored ? 'already in custody — nothing written' : '✓ marked in our possession', state: { ...h.state, inOurPossession: true, missedScanIn: false } }
        : h))
    } catch (e) {
      setHit((h) => (h && h.doc === doc ? { ...h, note: `not recorded: ${e.message}` } : h))
    }
  }, [])

  const { videoRef, start, stop, cameraOn, camErr } = useQrCamera({ onCode: openDoc })

  const close = useCallback(() => { stop(); setOpen(false); setHit(null); setManual('') }, [stop])

  if (!open) {
    return (
      <button
        className="pill scanNsBtn"
        title="Scan a tag to open that record in NetSuite. If it was never scanned back in, it OFFERS to mark it in our possession — it never does so on its own."
        onClick={() => { setOpen(true); setHit(null) }}
      >
        ⛶ Scan → NetSuite
      </button>
    )
  }

  return (
    <div className="scanNsOverlay" role="dialog" aria-label="Scan to open in NetSuite">
      <div className="scanNsPanel">
        <div className="scanNsHead">
          <b>Scan → NetSuite</b>
          <span className="muted">opens the record · offers a backup scan-in if one was missed</span>
          <button className="scanNsClose" onClick={close} aria-label="Close">✕</button>
        </div>

        <video ref={videoRef} className="scanNsVideo" playsInline muted />
        {!cameraOn && <button className="importBtn" onClick={start}>▶ Start camera</button>}
        {cameraOn && <button className="importBtn" onClick={stop}>■ Stop camera</button>}
        {camErr && <div className="banner warn">{camErr}</div>}

        <form
          className="scanManual"
          onSubmit={(e) => { e.preventDefault(); openDoc(manual); setManual('') }}
        >
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="No tag? Type it (IF7264, SO12446, INV11358)…"
          />
          <button className="importBtn" disabled={!manual.trim()}>Open</button>
        </form>

        {hit && (
          <div className="scanNsHit">
            {/* ⚠️ ALWAYS an anchor, blocked or not. A click is a user gesture, so this
                path cannot be blocked — and it doubles as confirmation of WHICH record
                was read before anyone starts working in it. */}
            <a className="btn" href={nsHref(hit.doc)} target="_blank" rel="noreferrer">
              ↗ Open {hit.doc} in NetSuite
            </a>
            {hit.blocked && (
              <span className="muted">
                {' '}Your browser blocked the pop-up — click above. Allowing pop-ups for
                this site makes it automatic.
              </span>
            )}

            {hit.state?.found && (
              <div className="scanNsCustody">
                {hit.state.inOurPossession && <span className="muted">✓ already in our possession</span>}
                {hit.state.departed && !hit.state.inOurPossession && <span className="muted">departed — no custody action</span>}

                {/* ⚠️ THE ONLY STATE WHERE THE OFFER APPEARS: handed out, never scanned
                    back, not departed. Offering it on anything else invites the exact
                    accident this replaced — recording IN for something on its way OUT. */}
                {hit.state.missedScanIn && (
                  <div className="banner warn">
                    <b>No scan back in.</b>{' '}
                    {hit.state.fulfillment?.customer || hit.doc} was handed out
                    {hit.state.lastOut ? ` on ${String(hit.state.lastOut).slice(0, 10)}` : ''} and has
                    not been scanned back.
                    <div className="muted">
                      Only do this if it is physically back with us. It records TODAY, not the
                      day it returned — so the warehouse calendar will count from today.
                    </div>
                    <button className="importBtn" onClick={() => markIn(hit.doc)}>
                      Mark in our possession
                    </button>
                  </div>
                )}
              </div>
            )}
            {hit.note && <span className="muted"> · {hit.note}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
