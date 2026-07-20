// server/auth.js — the access terminal. A single shared password gates the
// whole app (this is a one-person internal tool, not a multi-user system —
// see memory: "not worth it until someone besides Nima uses it").
//
// No new dependencies: a signed cookie (HMAC-SHA256 over an expiry timestamp)
// stands in for a session store, and cookies are parsed by hand from the
// Cookie header — both trivial enough not to need cookie-parser.
//
// Config (Render env vars / .env.local):
//   SITE_PASSWORD  — required to actually enable the gate. Unset = gate is a
//                    no-op passthrough, so local dev without .env.local still
//                    works exactly as before.
//   SESSION_SECRET — signs the cookie. Falls back to SITE_PASSWORD itself if
//                    unset (fine for single-shared-secret use); either way the
//                    cookie can't be forged without knowing one of them.
import { createHmac, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'nh_session'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days — this is a trusted personal device, not a shared kiosk

const enabled = () => !!process.env.SITE_PASSWORD
const secret = () => process.env.SESSION_SECRET || process.env.SITE_PASSWORD || ''

function sign(expiresAt) {
  const mac = createHmac('sha256', secret()).update(String(expiresAt)).digest('hex')
  return `${expiresAt}.${mac}`
}

function verify(token) {
  if (!token) return false
  const [expiresAt, mac] = token.split('.')
  if (!expiresAt || !mac) return false
  if (Date.now() > Number(expiresAt)) return false
  const expected = createHmac('sha256', secret()).update(expiresAt).digest('hex')
  const a = Buffer.from(mac), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function parseCookies(header) {
  const out = {}
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i === -1) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function issueSessionCookie(res) {
  const expiresAt = Date.now() + MAX_AGE_MS
  res.cookie(COOKIE_NAME, sign(expiresAt), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME)
}

export function isAuthed(req) {
  if (!enabled()) return true // gate disabled — local dev with no SITE_PASSWORD set
  const cookies = parseCookies(req.headers.cookie)
  return verify(cookies[COOKIE_NAME])
}

export function checkPassword(candidate) {
  const real = process.env.SITE_PASSWORD || ''
  if (!real || !candidate) return false
  const a = Buffer.from(String(candidate)), b = Buffer.from(real)
  return a.length === b.length && timingSafeEqual(a, b)
}

// The gate itself. Runs before static files and before every /api route
// except /api/login. Unauthenticated API calls get a plain 401 (the SPA never
// even loads its bundle without a session, so this is defense in depth).
// Unauthenticated page loads get the standalone login terminal — never the
// real app shell.
export function authGate(req, res, next) {
  // Machine-to-machine routes (the GitHub Actions warm-up cron) authenticate
  // with their own shared secret header, not a browser session — exempt them
  // here rather than require a login cookie no scheduler can hold. Their own
  // handler still rejects a missing/wrong secret.
  if (req.path.startsWith('/api/internal/')) return next()
  if (!enabled() || isAuthed(req)) return next()
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' })
  }
  res.status(401).type('html').send(LOGIN_PAGE)
}

// A minimal terminal-styled login page — deliberately dependency-free (no
// build step, no React) so it can render even if the gate blocks everything
// else. Posts to /api/login, then reloads on success.
const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Naghedi · Access Terminal</title>
<style>
  :root { --bg:#0a0d13; --panel:#161b22; --line:#2a323d; --text:#e6edf3; --accent:#d9a441; --holo:#4fd1ff; --hi:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background: radial-gradient(ellipse at 50% 30%, #10203a 0%, #05070d 55%, #02030a 100%);
    font-family: ui-monospace, Menlo, monospace; color: var(--text); }
  .term { width: 360px; background: rgba(20,25,33,0.92); border: 1px solid var(--holo); border-radius: 4px;
    padding: 28px 26px; box-shadow: 0 0 40px rgba(79,209,255,0.12), inset 0 1px 0 rgba(255,255,255,0.04);
    clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px); }
  .brand { font-size: 11px; letter-spacing: 0.28em; color: var(--holo); text-shadow: 0 0 10px rgba(79,209,255,0.6); margin-bottom: 4px; }
  h1 { font-size: 15px; letter-spacing: 0.1em; margin: 0 0 22px; color: var(--accent); text-transform: uppercase; }
  label { display: block; font-size: 10px; letter-spacing: 0.15em; color: #8b949e; text-transform: uppercase; margin-bottom: 6px; }
  input { width: 100%; background: #0d1117; border: 1px solid var(--line); border-radius: 3px; color: var(--text);
    padding: 10px 12px; font-family: inherit; font-size: 14px; letter-spacing: 0.05em; }
  input:focus { outline: none; border-color: var(--holo); box-shadow: 0 0 8px rgba(79,209,255,0.3); }
  button { margin-top: 16px; width: 100%; padding: 10px; border: 1px solid #57708c; border-radius: 3px; cursor: pointer;
    background: linear-gradient(180deg,#eef7ff 0%,#b9d9f6 55%,#9cc4e8 100%); color:#0a1524; font-weight:700;
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 12px; font-family: inherit;
    box-shadow: 0 0 12px rgba(150,205,255,0.35), inset 0 1px 0 rgba(255,255,255,0.85); }
  button:active { transform: translateY(1px); }
  .err { color: var(--hi); font-size: 12px; margin-top: 12px; min-height: 16px; }
  .scan { position:absolute; inset:0; pointer-events:none; opacity:0.03;
    background: repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 3px); }
</style></head>
<body>
  <form class="term" id="f" autocomplete="off">
    <div class="brand">◤ NAGHEDI COMMAND</div>
    <h1>Access Terminal</h1>
    <label for="pw">Passcode</label>
    <input id="pw" type="password" autofocus required />
    <button type="submit">Authenticate</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault()
      const pw = document.getElementById('pw').value
      const err = document.getElementById('err')
      err.textContent = 'Verifying…'
      try {
        const r = await fetch('/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        })
        if (r.ok) { location.reload() }
        else { err.textContent = 'Access denied — incorrect passcode.' }
      } catch { err.textContent = 'Connection error — try again.' }
    })
  </script>
</body></html>`
