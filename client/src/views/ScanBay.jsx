import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { recordCustodyScan, fetchOrderEvents, recordFulfillmentBox } from '../api.js'
import { LabelButtons, ChannelTag, CustomerName } from '../lib.jsx'

// Scan Bay (Nima, 2026-07-17) — the custody checkpoint. Every IF's cargo tag
// is scanned OUT when handed to the warehouse and IN when
// it comes back: the two transitions NetSuite has no record of. Uses the
// iMac's camera — BarcodeDetector where the browser has it, jsQR fallback
// everywhere else — no dedicated scanner hardware needed.

const COOLDOWN_MS = 4000 // ignore re-reads of the same code while it's still in frame

export default function ScanBay() {
  const [mode, setMode] = useState('OUT')
  const [cameraOn, setCameraOn] = useState(false)
  const [camErr, setCamErr] = useState(null)
  const [result, setResult] = useState(null) // last scan's server response
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState('')
  const [todayEvents, setTodayEvents] = useState([])
  const [pending, setPending] = useState(null) // a repeat scan awaiting confirm
  const [confirmNote, setConfirmNote] = useState('')

  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const lastReadRef = useRef({ code: null, at: 0 })
  const modeRef = useRef(mode)
  modeRef.current = mode
  // Single lock the camera loop can read even from its stale closure — held
  // while a scan is in flight OR a confirm dialog is open, so re-reads of the
  // same tag don't stack scans behind the "log it again?" prompt.
  const lockRef = useRef(false)

  function refreshEvents() {
    const today = new Date().toISOString().slice(0, 10)
    fetchOrderEvents({ date: today }).then(setTodayEvents).catch(() => {})
  }
  useEffect(refreshEvents, [])

  async function submitScan(docNumber, source) {
    if (lockRef.current) return
    lockRef.current = true
    setBusy(true)
    try {
      const r = await recordCustodyScan({ docNumber, direction: modeRef.current })
      setBusy(false)
      if (r.needsConfirm) {
        // already scanned this direction — ask before adding another log
        setPending({ ...r, via: source })
        setConfirmNote('')
        setResult(null)
        return // keep the lock; the confirm panel owns the flow now
      }
      setResult({ ...r, error: null, via: source })
      refreshEvents()
      lockRef.current = false
    } catch (e) {
      setBusy(false)
      setResult({ error: e.message, docNumber })
      lockRef.current = false
    }
  }

  // User said "yes, log it anyway" on a repeat scan — resend with confirm + the
  // (optional) note explaining why (e.g. a re-handoff back to the warehouse).
  async function confirmScan() {
    if (!pending) return
    setBusy(true)
    try {
      const r = await recordCustodyScan({
        docNumber: pending.docNumber,
        direction: pending.direction,
        note: confirmNote.trim() || null,
        confirm: true,
      })
      setResult({ ...r, error: null, via: pending.via })
      refreshEvents()
    } catch (e) {
      setResult({ error: e.message, docNumber: pending.docNumber })
    } finally {
      setBusy(false)
      setPending(null)
      setConfirmNote('')
      lockRef.current = false
    }
  }

  function cancelConfirm() {
    setPending(null)
    setConfirmNote('')
    lockRef.current = false
  }

  // ── camera + decode loop ────────────────────────────────────────────────────
  async function startCamera() {
    setCamErr(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      streamRef.current = stream
      const video = videoRef.current
      video.srcObject = stream
      await video.play()
      setCameraOn(true)

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null
      let lastAttempt = 0

      const tick = async (now) => {
        if (!streamRef.current) return
        // ~5 decode attempts/sec is plenty for a hand-held label and keeps the fan quiet
        if (now - lastAttempt > 200 && video.readyState >= 2) {
          lastAttempt = now
          let code = null
          try {
            if (detector) {
              const found = await detector.detect(video)
              code = found[0]?.rawValue || null
            } else {
              canvas.width = video.videoWidth
              canvas.height = video.videoHeight
              ctx.drawImage(video, 0, 0)
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
              code = jsQR(img.data, img.width, img.height)?.data || null
            }
          } catch { /* a failed frame is just a failed frame */ }
          if (code) {
            const last = lastReadRef.current
            if (code !== last.code || now - last.at > COOLDOWN_MS) {
              lastReadRef.current = { code, at: now }
              submitScan(code, 'camera')
            }
          }
        }
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      setCamErr(
        e.name === 'NotAllowedError'
          ? 'Camera permission denied — allow camera access for this site and try again.'
          : `Couldn’t start the camera: ${e.message}`,
      )
    }
  }

  function stopCamera() {
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCameraOn(false)
  }
  useEffect(() => stopCamera, []) // release the camera on unmount

  const custodyToday = todayEvents.filter((e) => e.eventType === 'CUSTODY_OUT' || e.eventType === 'CUSTODY_IN')

  return (
    <div className="scanbay">
      <div className="scanMain">
        <div className="scanModes">
          <button className={'scanMode out' + (mode === 'OUT' ? ' active' : '')} onClick={() => setMode('OUT')}>
            ⬆ SCAN OUT<span className="hintline">handing cargo to the warehouse</span>
          </button>
          <button className={'scanMode in' + (mode === 'IN' ? ' active' : '')} onClick={() => setMode('IN')}>
            ⬇ SCAN IN<span className="hintline">cargo returned from the warehouse</span>
          </button>
        </div>

        <div className={'scanViewport' + (cameraOn ? ' live' : '')}>
          <video ref={videoRef} muted playsInline />
          {!cameraOn && (
            <div className="scanIdle">
              {camErr && <div className="banner error">⚠ {camErr}</div>}
              <button className="importBtn big" onClick={startCamera}>◉ Activate scanner</button>
              <p className="hint">Point a cargo tag’s QR at the camera — it logs automatically.</p>
            </div>
          )}
          {cameraOn && <div className={'scanFrame ' + mode.toLowerCase()} />}
        </div>
        {cameraOn && (
          <button className="importBtn" onClick={stopCamera}>■ Stop scanner</button>
        )}

        <form
          className="scanManual"
          onSubmit={(e) => {
            e.preventDefault()
            if (manual.trim()) submitScan(manual.trim(), 'manual')
            setManual('')
          }}
        >
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="No tag? Type the IF number (e.g. IF7264)…"
          />
          <button className="importBtn" disabled={busy || !manual.trim()}>Log {mode}</button>
        </form>

        {pending && (
          <div className="scanResult warn scanConfirm">
            <div className="scanHead">
              ⚠ {pending.isDc ? `PO ${pending.poNumber}${pending.dc ? ` · DC ${pending.dc}` : ''}` : pending.docNumber} was already scanned {pending.direction}{' '}
              {pending.priorSameDir === 1 ? 'once' : `${pending.priorSameDir}×`}
              {pending.lastSameDirAt &&
                ` · last ${new Date(pending.lastSameDirAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
            </div>
            <div className="scanMeta">
              Cargo should go out once and in once. Log another {pending.direction}?
              {pending.fulfillment && ` · ${pending.fulfillment.customer || pending.fulfillment.soNumber || ''}`}
            </div>
            <textarea
              className="confirmNote"
              value={confirmNote}
              onChange={(e) => setConfirmNote(e.target.value)}
              placeholder="Why? (optional) — e.g. giving it back to the warehouse for a fix"
            />
            <div className="confirmActions">
              <button className="importBtn" disabled={busy} onClick={confirmScan}>
                Log {pending.direction} anyway
              </button>
              <button type="button" className="linkBtn" onClick={cancelConfirm}>Cancel</button>
            </div>
          </div>
        )}

        {result && !pending && (
          <div className={'scanResult ' + (result.error ? 'bad' : result.found ? 'good' : 'warn')}>
            {result.error ? (
              <>⚠ {result.error}</>
            ) : (
              <>
                <div className="scanHead">
                  {result.direction === 'OUT' ? '⬆ OUT — with the warehouse' : '⬇ IN — back in our hands'}
                  <b> · {result.isDc ? `PO ${result.poNumber}${result.dc ? ` · DC ${result.dc}` : ''}` : result.docNumber}</b>
                </div>
                {result.isDc ? (
                  <div className="scanMeta">
                    {result.customer
                      ? <><ChannelTag order={result} /> <CustomerName order={result} /> · {result.storeCount} {result.storeCount === 1 ? 'store' : 'stores'}</>
                      : `PO ${result.poNumber} — not in the imported orders yet.`}
                  </div>
                ) : result.fulfillment ? (
                  <div className="scanMeta">
                    {result.fulfillment.soNumber} · {result.fulfillment.customer || 'unknown customer'}
                    {result.fulfillment.packedStatus ? ` · ${result.fulfillment.packedStatus}` : ''}
                    <LabelButtons info={{ ifNumber: result.docNumber, ...result.fulfillment }} />
                  </div>
                ) : (
                  <div className="scanMeta">
                    Logged — but this IF isn’t in the imported data yet. It’ll connect on the next CSV import.
                  </div>
                )}
                {result.direction === 'IN' && !result.isDc && (
                  <BoxCapture key={result.docNumber + result.occurredAt} ifNumber={result.docNumber} />
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="scanLog">
        <div className="colHead">Today’s custody log <span className="count">{custodyToday.length}</span></div>
        {custodyToday.map((e) => {
          // DC-carton events store doc_number as '<po>:<abbrev>' — show it as PO · DC.
          const dc = e.docType === 'DC' ? e.docNumber.split(':') : null
          return (
            <div key={e.id} className="kcard">
              <div className="krow">
                <span className="so">{dc ? `PO ${dc[0]}${dc[1] ? ` · DC ${dc[1]}` : ''}` : e.docNumber}</span>
                <span className={'pill ' + (e.eventType === 'CUSTODY_OUT' ? 'warn' : 'fresh')}>
                  {e.eventType === 'CUSTODY_OUT' ? '⬆ OUT' : '⬇ IN'}
                </span>
              </div>
              <div className="cust">
                {e.customer ? <><ChannelTag order={e} /> <CustomerName order={e} /></> : (e.soNumber || '—')}
              </div>
              {e.note && <div className="scanNote">“{e.note}”</div>}
              <div className="ifs docdate">{new Date(e.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          )
        })}
        {!custodyToday.length && <div className="empty">No scans yet today — the bay is quiet.</div>}
      </div>
    </div>
  )
}

// Box capture — appears after an IN scan (the carton's back in our hands, so
// it's the natural moment to weigh & measure it). Entirely skippable: a scan is
// never blocked on it. Saved boxes land in fulfillment_boxes and surface in the
// Custody Register until the IF departs.
function BoxCapture({ ifNumber }) {
  const [w, setW] = useState('')
  const [l, setL] = useState('')
  const [wd, setWd] = useState('')
  const [h, setH] = useState('')
  const [state, setState] = useState(null) // null | 'saving' | 'saved' | 'skipped' | error string
  const [saved, setSaved] = useState(0)

  if (state === 'skipped') return null

  async function save(e) {
    e.preventDefault()
    if (!w && !l && !wd && !h) { setState('Enter a weight or a dimension, or skip.'); return }
    setState('saving')
    try {
      await recordFulfillmentBox({ ifNumber, weightLb: w, lengthIn: l, widthIn: wd, heightIn: h })
      setSaved((n) => n + 1)
      setState('saved')
      setW(''); setL(''); setWd(''); setH('')
    } catch (err) {
      setState(err.message)
    }
  }

  return (
    <form className="boxCapture" onSubmit={save}>
      <div className="boxHead">
        📦 Box for {ifNumber}
        {saved > 0 && <span className="pill fresh">{saved} saved</span>}
        <button type="button" className="linkBtn boxSkip" onClick={() => setState('skipped')}>skip</button>
      </div>
      <div className="boxFields">
        <label>lb<input type="number" step="0.1" min="0" value={w} onChange={(e) => setW(e.target.value)} placeholder="wt" /></label>
        <span className="boxX">·</span>
        <label>L<input type="number" step="0.1" min="0" value={l} onChange={(e) => setL(e.target.value)} placeholder="in" /></label>
        <span className="boxX">×</span>
        <label>W<input type="number" step="0.1" min="0" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="in" /></label>
        <span className="boxX">×</span>
        <label>H<input type="number" step="0.1" min="0" value={h} onChange={(e) => setH(e.target.value)} placeholder="in" /></label>
        <button className="importBtn" disabled={state === 'saving'}>
          {state === 'saving' ? '…' : saved > 0 ? '+ box' : 'Save box'}
        </button>
      </div>
      {state === 'saved' && <div className="boxNote ok">✓ Recorded — add another box or skip.</div>}
      {state && state !== 'saving' && state !== 'saved' && <div className="boxNote bad">{state}</div>}
    </form>
  )
}
