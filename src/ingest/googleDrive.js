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

// Find a child folder by name under `parentId` (or root), creating it if absent.
// Returns folderId, or null on a scope 403 (caller treats as needsReauth).
async function ensureFolder(name, parentId, headers) {
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `name='${name.replace(/'/g, "\\'")}'`,
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ].join(' and ')
  const listRes = await fetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id,name)`, { headers })
  if (listRes.status === 403 || listRes.status === 401) return { needsReauth: true }
  if (!listRes.ok) throw new Error(`Drive list ${listRes.status}: ${await listRes.text().catch(() => '')}`)
  const found = (await listRes.json()).files?.[0]
  if (found) return { id: found.id }

  const createRes = await fetch(`${FILES}?fields=id`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
  if (!createRes.ok) throw new Error(`Drive mkdir ${createRes.status}: ${await createRes.text().catch(() => '')}`)
  return { id: (await createRes.json()).id }
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
    if (r.needsReauth) return { needsReauth: true }
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
  const existRes = await fetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id)`, { headers })
  if (existRes.status === 403 || existRes.status === 401) return { needsReauth: true }
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
    ? `${UPLOAD}/${existingId}?uploadType=multipart&fields=id,webViewLink`
    : `${UPLOAD}?uploadType=multipart&fields=id,webViewLink`
  const res = await fetch(url, {
    method: existingId ? 'PATCH' : 'POST',
    headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (res.status === 403 || res.status === 401) return { needsReauth: true }
  if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text().catch(() => '')}`)
  const file = await res.json()
  return { id: file.id, link: file.webViewLink }
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
    if (folder.needsReauth) return { ok: false, needsReauth: true }
    const put = await putPdf(folder.id, filename, buffer, headers)
    if (put.needsReauth) return { ok: false, needsReauth: true }
    uploaded.push({ po, id: put.id, link: put.link })
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
