// client/src/lib/useQrCamera.js — the camera + QR decode loop, shared.
//
// Lifted verbatim out of ScanBay so the Scan Bay and the scan-to-NetSuite overlay
// cannot drift apart. ⚠️ ONE SCANNER, NOT TWO: the decode path has two branches
// (BarcodeDetector where the browser has it, jsQR everywhere else) and a repeat-read
// cooldown, and a second copy of that is a second set of camera bugs to find.
//
// The caller supplies only what to DO with a code; everything about getting one is here.
import { useRef, useState, useCallback, useEffect } from 'react'
import jsQR from 'jsqr'

export function useQrCamera({ onCode, cooldownMs = 2500 } = {}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(null)
  const lastReadRef = useRef({ code: null, at: 0 })
  // ⚠️ Held in a ref so the decode loop always calls the CURRENT handler. Closing over
  // the prop would freeze the first render's callback inside a loop that runs for
  // minutes — the code would decode and nothing would happen.
  const onCodeRef = useRef(onCode)
  useEffect(() => { onCodeRef.current = onCode }, [onCode])

  const [cameraOn, setCameraOn] = useState(false)
  const [camErr, setCamErr] = useState(null)

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraOn(false)
  }, [])

  const start = useCallback(async () => {
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
            // ⚠️ The same tag stays in frame for seconds. Without the cooldown one
            // physical scan fires dozens of times.
            if (code !== last.code || now - last.at > cooldownMs) {
              lastReadRef.current = { code, at: now }
              onCodeRef.current?.(code)
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
  }, [cooldownMs])

  // ⚠️ The camera MUST be released when the component goes away. A live getUserMedia
  // track keeps the recording indicator lit and the webcam warm indefinitely.
  useEffect(() => stop, [stop])

  return { videoRef, start, stop, cameraOn, camErr }
}
