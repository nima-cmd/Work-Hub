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

// Resolve a nested folder path (["Bloomingdale's", "7527064"]) under an optional
// root, creating each level. The root folder is "Work-Hub BOLs" so the app's
// output is self-contained and easy for Nima to find.
async function ensurePath(segments, headers) {
  let parent = null
  for (const seg of ['Work-Hub BOLs', ...segments]) {
    const r = await ensureFolder(seg, parent, headers)
    if (r.needsReauth) return { needsReauth: true }
    parent = r.id
  }
  return { id: parent }
}

// Upload a PDF buffer to /Work-Hub BOLs/<partner>/<po>/<filename>. When a
// shipment consolidates multiple POs, it's filed under each PO's folder so it's
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

    const meta = { name: filename, parents: [folder.id] }
    const boundary = 'wkhub' + buffer.length.toString(36)
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const res = await fetch(`${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    if (res.status === 403 || res.status === 401) return { ok: false, needsReauth: true }
    if (!res.ok) throw new Error(`Drive upload ${res.status}: ${await res.text().catch(() => '')}`)
    const file = await res.json()
    uploaded.push({ po, id: file.id, link: file.webViewLink })
  }
  return { ok: true, uploaded }
}
