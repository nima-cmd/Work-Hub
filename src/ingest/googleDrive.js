// src/ingest/googleDrive.js — write generated BOL PDFs into Google Drive
// (same raw-fetch + refresh-token style as gmail.js / googleCalendar.js). Uses
// the drive.file scope, which only ever sees files THIS app created — it can't
// read or touch the rest of Nima's Drive.
//
// Fails soft exactly like the calendar: if the refresh token predates the Drive
// scope, Google returns 403 and we return { ok:false, needsReauth:true } so the
// UI can prompt a re-run of connect-gmail.js instead of throwing.

import { getAccessToken } from './gmail.js'

const FILES = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

async function authHeader() {
  const token = await getAccessToken()
  return { Authorization: `Bearer ${token}` }
}

// ── 403 means two opposite things, and we used to guess ──────────────────────
// Drive returns 403 for BOTH "your token lacks the scope" (fatal — re-auth) and
// "you're going too fast" (transient — retry). Treating every 403 as a scope
// problem told Nima to re-run connect-gmail.js when the real answer was to wait
// 200ms, and it's very likely how "Drive needs re-auth" became folklore.
// The distinguishing signal is the error `reason`, not the status.
const RETRY_REASONS = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded',
  'backendError', 'internalError',
])

export function classifyDriveError(status, bodyText) {
  let reason = null, message = null
  try {
    const e = JSON.parse(bodyText || '{}')?.error
    reason = e?.errors?.[0]?.reason || e?.status || null
    message = e?.message || null
  } catch { /* non-JSON body — fall through to status-only rules */ }

  if (status === 429) return { retry: true, reason: reason || 'rateLimitExceeded', message }
  if (status >= 500) return { retry: true, reason: reason || 'backendError', message }
  if (status === 401) return { retry: false, needsReauth: true, reason: reason || 'unauthorized', message }
  if (status === 403) {
    // A rate-limit 403 is retryable; anything else at 403 is a real permission
    // problem. Unknown reason at 403 is treated as re-auth (the conservative
    // read: retrying a genuine scope failure just burns time).
    if (reason && RETRY_REASONS.has(reason)) return { retry: true, reason, message }
    return { retry: false, needsReauth: true, reason: reason || 'forbidden', message }
  }
  return { retry: false, reason: reason || `http_${status}`, message }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Turn a give-up verdict into the soft-fail shape callers already understand,
// carrying enough detail that the UI can say what actually went wrong instead of
// the flat "upload failed" it used to show.
function failed(f) {
  return {
    ok: false,
    ...(f.needsReauth ? { needsReauth: true } : {}),
    reason: f.reason || null,
    status: f.status || null,
    where: f.at || null,
    detail: f.message || null,
    retried: !!f.retry, // true = we backed off and it still wouldn't go
  }
}

// One Drive call with bounded retry. Fifteen sequential uploads WILL meet a
// throttle or a transient 5xx — the run that lost 12 of Nima's 15 slips died on
// the first one, because nothing retried and the throw aborted everything.
// Returns { res } on success, or { failure } describing why it gave up.
async function driveFetch(url, init, { attempts = 4 } = {}) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    let res
    try {
      res = await fetch(url, init)
    } catch (e) {
      // Network-level failure — retryable, same as a 5xx.
      last = { retry: true, reason: 'network', message: e.message }
      if (i < attempts - 1) { await sleep(250 * 2 ** i); continue }
      return { failure: last }
    }
    if (res.ok) return { res }
    const body = await res.text().catch(() => '')
    const verdict = classifyDriveError(res.status, body)
    last = { ...verdict, status: res.status }
    if (!verdict.retry || i === attempts - 1) return { failure: last }
    await sleep(250 * 2 ** i) // 250ms · 500 · 1s — well inside Drive's window
  }
  return { failure: last }
}

// Resolved folder ids, so a 15-document stack doesn't re-resolve the root and
// the partner folder 15 times over. That burst (~5 calls per document) is what
// invited the throttle in the first place. Keyed by parent+name; short TTL so a
// folder moved or trashed in Drive can't be cached for long.
const FOLDER_TTL_MS = 10 * 60 * 1000
const folderCache = new Map()
const cacheKey = (parentId, name) => `${parentId || 'root'}/${name}`

export function clearDriveFolderCache() { folderCache.clear() }

// Find a child folder by name under `parentId` (or root), creating it if absent.
// Returns { id }, or { failure } — it no longer THROWS. The old version threw on
// any non-ok create, including a throttled one, and that throw is what killed
// the rest of the run.
async function ensureFolder(name, parentId, headers) {
  const key = cacheKey(parentId, name)
  const hit = folderCache.get(key)
  if (hit && Date.now() - hit.at < FOLDER_TTL_MS) return { id: hit.id }

  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `name='${name.replace(/'/g, "\\'")}'`,
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ')
  const list = await driveFetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers })
  if (list.failure) return { failure: { ...list.failure, at: `list folder "${name}"` } }
  const found = (await list.res.json()).files?.[0]
  if (found) {
    folderCache.set(key, { id: found.id, at: Date.now() })
    return { id: found.id }
  }

  const created = await driveFetch(`${FILES}?fields=id`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
  if (created.failure) return { failure: { ...created.failure, at: `create folder "${name}"` } }
  const id = (await created.res.json()).id
  folderCache.set(key, { id, at: Date.now() })
  return { id }
}

// The two output trees. BOLs are freight; packing slips are boutique/parcel and
// deliberately live OUTSIDE that tree (Nima, 2026-07-31) so "BOLs" keeps meaning
// freight — a boutique slip filed in there would read as a missing BOL.
export const DRIVE_ROOT_BOLS = 'Work-Hub BOLs'
export const DRIVE_ROOT_SLIPS = 'Packing Slips'

// Resolve a nested folder path (["Bloomingdale's", "7527064"]) under a root,
// creating each level. Defaults to the BOL tree so existing callers are unchanged.
async function ensurePath(segments, headers, root = DRIVE_ROOT_BOLS) {
  let parent = null
  for (const seg of [root, ...segments]) {
    const r = await ensureFolder(seg, parent, headers)
    if (r.failure) return { failure: r.failure }
    parent = r.id
  }
  return { id: parent }
}

// Upload one PDF buffer into an already-resolved folder. Shared by the BOL and
// scanned-doc uploaders. A same-named file in the folder is OVERWRITTEN (update
// in place) so re-filing a corrected scan doesn't leave duplicates.
async function putPdf(folderId, filename, buffer, headers) {
  const q = [
    'trashed=false',
    `name='${filename.replace(/'/g, "\\'")}'`,
    `'${folderId}' in parents`,
  ].join(' and ')
  const exist = await driveFetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id)`, { headers })
  if (exist.failure) return { failure: { ...exist.failure, at: `look up "${filename}"` } }
  const existingId = (await exist.res.json()).files?.[0]?.id || null

  const boundary = 'wkhub' + buffer.length.toString(36)
  const meta = existingId ? {} : { name: filename, parents: [folderId] }
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const url = existingId
    ? `${UPLOAD}/${existingId}?uploadType=multipart&fields=id,webViewLink`
    : `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`
  const put = await driveFetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (put.failure) return { failure: { ...put.failure, at: `upload "${filename}"` } }
  const file = await put.res.json()
  return { id: file.id, link: file.webViewLink, replaced: !!existingId }
}

// Upload a PDF buffer to /Work-Hub BOLs/<partner>/<po>/<filename>. When a
// shipment consolidates multiple POs, it's filed under each PO's folder so it's
// findable from any of them (the manual process filed per PO too).
export async function uploadBolPdf({ partner, pos, filename, buffer, root = DRIVE_ROOT_BOLS }) {
  if (!process.env.GOOGLE_REFRESH_TOKEN) return { ok: false, configured: false }
  let headers
  try {
    headers = await authHeader()
  } catch {
    return { ok: false, configured: false }
  }

  const uploaded = []
  const poList = pos && pos.length ? pos : ['_unfiled']
  for (const po of poList) {
    const folder = await ensurePath([partner, String(po)], headers, root)
    if (folder.failure) return failed(folder.failure)
    const put = await putPdf(folder.id, filename, buffer, headers)
    if (put.failure) return failed(put.failure)
    uploaded.push({ po, id: put.id, link: put.link, replaced: put.replaced })
  }
  return { ok: true, uploaded }
}

// File a scanned document (a split off the multi-page scan) to Drive, into the
// SAME /Work-Hub BOLs/<partner>/<po>/ tree the digital BOLs use (Nima, 2026-07-29
// — signed paper sits next to the app's PDFs). `pos` is the list of PO folders to
// drop the file into (one for a per-DC IF split; all covered POs for a master
// BOL). Returns per-PO Drive links. Mirrors uploadBolPdf's soft-fail contract.
export async function uploadScannedPdf({ partner, pos, filename, buffer, root }) {
  return uploadBolPdf({ partner, pos, filename, buffer, root })
}
