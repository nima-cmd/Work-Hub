// src/ingest/googleDrive.js — write generated BOL + scanned PDFs into the team's
// Google Shared Drive (same raw-fetch + refresh-token style as gmail.js /
// googleCalendar.js). Uses the drive.file scope, which only ever sees files THIS
// app created — it can't read or touch the rest of the Drive.
//
// Everything is filed inside the "NAGHEDI Warehouse" SHARED DRIVE, under
// Warehouse Documents → Shipments → Work-Hub BOLs/<partner>/<PO>/ (Nima,
// 2026-07-30) — so the whole warehouse team sees the docs, not just the bot
// account's private My Drive. Shared Drives require supportsAllDrives=true on
// every call, plus includeItemsFromAllDrives=true + corpora on any list/search.
//
// Fails soft exactly like the calendar: a 403/401 is surfaced as either
// { needsReauth:true } (token predates the drive.file scope — re-run
// connect-gmail.js) or { apiDisabled:true } (Drive API switched off in the Cloud
// project — enable it in the console), never thrown, so the app keeps working.

import { getAccessToken } from './gmail.js'

const FILES = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

// Root of all Work-Hub filing: the "Shipments" folder inside the NAGHEDI
// Warehouse shared drive (Warehouse Documents → Shipments). Override via env if
// it ever moves; the app creates "Work-Hub BOLs" and the partner/PO tree beneath.
const SHIPMENTS_FOLDER_ID =
  process.env.DRIVE_SHIPMENTS_FOLDER_ID || '1j3Dd4TvEP4l5fGWuoJNvWr0iJtHv9kXg'

// Shared-Drive query params for list/search. corpora=allDrives (NOT
// corpora=drive+driveId): the drive.file scope can't READ the pre-existing
// Shipments folder to learn its shared-drive id, but it CAN find the sub-folders
// THIS app created, and allDrives needs no id. The `'<parent>' in parents` filter
// still scopes every query to the right place.
const SHARED_LIST = 'supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives'

async function authHeader() {
  const token = await getAccessToken()
  return { Authorization: `Bearer ${token}` }
}

// A Drive 403/401 has two very different causes (mirrors googleCalendar.js): the
// OAuth token predates the drive.file scope (needsReauth → re-run
// connect-gmail.js), or the Drive API is off in the Cloud project (apiDisabled →
// enable it). Tell them apart by the body so the UI can show the right fix.
function classifyAuthError(status, body) {
  if (status !== 403 && status !== 401) return null
  if (/accessNotConfigured|has not been used in project|is disabled/i.test(body || '')) {
    return { apiDisabled: true }
  }
  return { needsReauth: true }
}

// Find a child folder by name under `parentId`, creating it if absent. Returns
// { id }, or a soft-fail marker ({ needsReauth } / { apiDisabled }) on a 403/401.
async function ensureFolder(name, parentId, headers) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `name='${name.replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
  ].join(' and ')
  const listRes = await fetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id,name)&${SHARED_LIST}`, { headers })
  if (!listRes.ok) {
    const body = await listRes.text().catch(() => '')
    const soft = classifyAuthError(listRes.status, body)
    if (soft) return soft
    throw new Error(`Drive list ${listRes.status}: ${body}`)
  }
  const found = (await listRes.json()).files?.[0]
  if (found) return { id: found.id }

  const createRes = await fetch(`${FILES}?fields=id&supportsAllDrives=true`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  })
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => '')
    const soft = classifyAuthError(createRes.status, body)
    if (soft) return soft
    throw new Error(`Drive mkdir ${createRes.status}: ${body}`)
  }
  return { id: (await createRes.json()).id }
}

// Resolve a nested folder path (["Bloomingdale's", "7527064"]) under the shared
// "Shipments" root, creating each level. The app's own "Work-Hub BOLs" folder is
// the first level, so its output is self-contained and easy to find on the drive.
async function ensurePath(segments, headers) {
  let parent = SHIPMENTS_FOLDER_ID
  for (const seg of ['Work-Hub BOLs', ...segments]) {
    const r = await ensureFolder(seg, parent, headers)
    if (r.needsReauth || r.apiDisabled) return r
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
  const existRes = await fetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id)&${SHARED_LIST}`, { headers })
  if (!existRes.ok) {
    const soft = classifyAuthError(existRes.status, await existRes.text().catch(() => ''))
    if (soft) return soft
  }
  const existingId = existRes.ok ? (await existRes.json()).files?.[0]?.id : null

  const boundary = 'wkhub' + buffer.length.toString(36)
  const meta = existingId ? {} : { name: filename, parents: [folderId] }
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ])
  const url = existingId
    ? `${UPLOAD}/${existingId}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`
    : `${UPLOAD}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`
  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!res.ok) {
    const body2 = await res.text().catch(() => '')
    const soft = classifyAuthError(res.status, body2)
    if (soft) return soft
    throw new Error(`Drive upload ${res.status}: ${body2}`)
  }
  const file = await res.json()
  return { id: file.id, link: file.webViewLink }
}

// Upload a PDF buffer to Shipments/Work-Hub BOLs/<partner>/<po>/<filename>. When
// a shipment consolidates multiple POs, it's filed under each PO's folder so it's
// findable from any of them (the manual process filed per PO too).
export async function uploadBolPdf({ partner, pos, filename, buffer }) {
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
    const folder = await ensurePath([partner, String(po)], headers)
    if (folder.needsReauth) return { ok: false, needsReauth: true }
    if (folder.apiDisabled) return { ok: false, apiDisabled: true }
    const put = await putPdf(folder.id, filename, buffer, headers)
    if (put.needsReauth) return { ok: false, needsReauth: true }
    if (put.apiDisabled) return { ok: false, apiDisabled: true }
    uploaded.push({ po, id: put.id, link: put.link })
  }
  return { ok: true, uploaded }
}

// File a scanned document (a split off the multi-page scan) to Drive, into the
// SAME Shipments/Work-Hub BOLs/<partner>/<po>/ tree the digital BOLs use (Nima,
// 2026-07-29 — signed paper sits next to the app's PDFs). `pos` is the list of PO
// folders to drop the file into (one for a per-DC IF split; all covered POs for a
// master BOL). Returns per-PO Drive links. Mirrors uploadBolPdf's soft-fail.
export async function uploadScannedPdf({ partner, pos, filename, buffer }) {
  return uploadBolPdf({ partner, pos, filename, buffer })
}
