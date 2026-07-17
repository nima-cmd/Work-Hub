import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { recordCustodyScan, fetchOrderEvents } from '../api.js'
import { LabelButtons } from '../lib.jsx'

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

  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const lastReadRef = useRef({ code: null, at: 0 })
  const modeRef = useRef(mode)
  modeRef.current = mode

  function refreshEvents() {
    const today = new Date().toISOString().slice(0, 10)
    fetchOrderEvents({ date: today }).then(setTodayEvents).catch(() => {})
  }
  useEffect(refreshEvents, [])

  async function submitScan(docNumber, source) {
    if (busy) return
    setBusy(true)
    try {
      const r = await recordCustodyScan({ docNumber, direction: modeRef.current })
      setResult({ ...r, error: null, via: source })
      refreshEvents()
    } catch (e) {
      setResult({ error: e.message, docNumber })
    } finally {
      setBusy(false)
    }
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

        {result && (
          <div className={'scanResult ' + (result.error ? 'bad' : result.found ? 'good' : 'warn')}>
            {result.error ? (
              <>⚠ {result.error}</>
            ) : (
              <>
                <div className="scanHead">
                  {result.direction === 'OUT' ? '⬆ OUT — with the warehouse' : '⬇ IN — back in our hands'}
                  <b> · {result.docNumber}</b>
                </div>
                {result.fulfillment ? (
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
              </>
            )}
          </div>
        )}
      </div>

      <div className="scanLog">
        <div className="colHead">Today’s custody log <span className="count">{custodyToday.length}</span></div>
        {custodyToday.map((e) => (
          <div key={e.id} className="kcard">
            <div className="krow">
              <span className="so">{e.docNumber}</span>
              <span className={'pill ' + (e.eventType === 'CUSTODY_OUT' ? 'warn' : 'fresh')}>
                {e.eventType === 'CUSTODY_OUT' ? '⬆ OUT' : '⬇ IN'}
              </span>
            </div>
            <div className="cust">{e.customer || e.soNumber || '—'}</div>
            <div className="ifs docdate">{new Date(e.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        ))}
        {!custodyToday.length && <div className="empty">No scans yet today — the bay is quiet.</div>}
      </div>
    </div>
  )
}
