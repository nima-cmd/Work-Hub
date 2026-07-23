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

  // Static assets (Vite emits content-hashed files): cache-first, then network.
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || /\.(png|svg|woff2?|css|js)$/.test(url.pathname))) {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy))
      }
      return res
    })),
  )
})
