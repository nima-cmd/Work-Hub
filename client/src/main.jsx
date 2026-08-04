import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

createRoot(document.getElementById('root')).render(<App />)

// Register the service worker so the app is installable to the phone home screen
// (Add to Home Screen → opens standalone). Failures are non-fatal.
//
// ⚠️ PRODUCTION ONLY, and that is a correctness fix, not a preference
// (2026-08-04). The comment here used to claim "Dev (Vite on :5173) has no
// sw.js, so only register where it exists". It does: Vite serves client/public
// at the dev root, so GET /sw.js returns 200 and the worker installed in dev
// too. Combined with sw.js's cache-first rule for anything ending in `.js` —
// and dev module URLs being UNHASHED source paths like
// /src/model/routeItems.js — the worker pinned source modules in
// `workhub-shell-v1` indefinitely.
//
// The failure mode is worse than a stale page: an edit appears to do nothing,
// and a VERIFICATION PASSES against the pre-edit bundle. It cost real debugging
// time on 2026-08-04, when Today's Plan rendered the previous version of its
// legs while the file on disk and the API were both already correct. Note that
// neither restarting the dev server nor deleting client/node_modules/.vite
// clears it — only unregistering the worker does.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
} else if ('serviceWorker' in navigator) {
  // Declining to register is not enough on its own: any browser that already
  // loaded a dev page still has the worker installed and will keep serving its
  // cached modules forever. So dev actively tears it down — otherwise this fix
  // does nothing for exactly the machines that have the problem.
  navigator.serviceWorker.getRegistrations?.()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .catch(() => {})
  globalThis.caches?.keys?.()
    .then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
    .catch(() => {})
}
