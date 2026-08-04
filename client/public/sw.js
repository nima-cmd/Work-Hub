// Naghedi Work-Hub service worker — makes the app installable and fast to open
// on a phone. Deliberately conservative about data: it caches the static app
// shell (HTML/JS/CSS/icons) but NEVER caches /api responses, so the tracker's
// numbers are always live. Offline, it can still open the shell; API calls just
// fail as they would in the browser.
const CACHE = 'workhub-shell-v1'

self.addEventListener('install', (e) => {
  self.skipWaiting()
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon-192.png']).catch(() => {})))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const { request } = e
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // let cross-origin (fonts, etc.) pass through
  if (url.pathname.startsWith('/api/')) return // always network — never cache live data

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).then((res) => { caches.open(CACHE).then((c) => c.put('/', res.clone())); return res })
        .catch(() => caches.match('/').then((r) => r || caches.match(request))),
    )
    return
  }

  // Static assets: cache-first, then network.
  //
  // ⚠️ CODE is only ever cached from /assets/, where Vite emits content-hashed
  // filenames — a new build produces new URLs, so cache-first can never serve
  // stale code. The old rule also matched ANY path ending in `.js`/`.css`, which
  // is safe for a built bundle but catastrophic anywhere serving unhashed module
  // URLs: it pinned /src/model/*.js permanently and made a dev page render code
  // that was not on disk (2026-08-04 — see client/src/main.jsx). Registration is
  // now production-only, and this narrowing means a worker that somehow installs
  // against unhashed sources still cannot freeze them.
  const hashedCode = url.pathname.startsWith('/assets/')
  const media = /\.(png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok && (hashedCode || media)) {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy))
      }
      return res
    })),
  )
})
