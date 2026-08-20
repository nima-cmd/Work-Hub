// src/model/docLinkUrl.js — turning a pasted link into something storable.
//
// Nima, 2026-08-20: "we would also like within task the ability to take notes as well
// as link to any google docs if possible."
//
// `doc_links` already attaches any document to any other by (type, number) — but a
// Google Doc has no document number, it has a URL. So links gain a `url`, and this
// module is the part that decides what a pasted string actually IS before it is stored.
//
// ⚠️ WHY EXTRACT THE FILE ID AT ALL, rather than just keeping the URL? Because the same
// document has many URLs — /edit, /view, ?usp=sharing, /edit#gid=0, a copy pasted from
// the address bar versus one from the share dialog. Storing the raw string means the
// same doc attached twice looks like two different documents, and `doc_links`' UNIQUE
// constraint is on (a_type, a_number, b_type, b_number). The file id IS the identity;
// the URL is how you get there.
//
// ⚠️ NOT limited to Google. He said "any google docs", and Drive is what gets the id
// treatment — but refusing a Dropbox link or a NetSuite saved search would be a rule he
// never asked for, and the failure would be silent-ish at exactly the wrong moment. A
// non-Drive URL is kept whole, with kind 'link'.

/** Google's per-product path segments → what the thing is. */
const DRIVE_KINDS = {
  document: 'doc',
  spreadsheets: 'sheet',
  presentation: 'slide',
  forms: 'form',
  drawings: 'drawing',
}

/**
 * A pasted string → { ok, url, kind, fileId, host } or { ok: false, error }.
 *
 * `kind`: 'doc' | 'sheet' | 'slide' | 'form' | 'drawing' | 'drive' | 'folder' | 'link'
 */
export function parseDocUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return { ok: false, error: 'Paste a link first.' }

  // A bare id is not a link, and guessing which product it belongs to would be
  // inventing information. Ask for the URL.
  if (!/^https?:\/\//i.test(s)) {
    return /^[\w-]{20,}$/.test(s)
      ? { ok: false, error: 'That looks like a file id. Paste the full link so we know which app it is.' }
      : { ok: false, error: 'That is not a link — it should start with https://' }
  }

  let u
  try { u = new URL(s) } catch { return { ok: false, error: 'That link could not be read.' } }

  const host = u.hostname.toLowerCase()
  const isGoogle = /(^|\.)google\.com$/.test(host) || host === 'docs.google.com' || host === 'drive.google.com'
  if (!isGoogle) {
    // Keep it, whole and unjudged.
    return { ok: true, url: u.toString(), kind: 'link', fileId: null, host }
  }

  // /document/d/<id>/edit · /spreadsheets/d/<id> · /presentation/d/<id>
  const byProduct = u.pathname.match(/^\/(document|spreadsheets|presentation|forms|drawings)\/d\/([\w-]+)/)
  if (byProduct) {
    return { ok: true, url: canonicalDrive(byProduct[1], byProduct[2]), kind: DRIVE_KINDS[byProduct[1]], fileId: byProduct[2], host }
  }
  // /file/d/<id>/view — a PDF or an upload, no editor
  const byFile = u.pathname.match(/^\/file\/d\/([\w-]+)/)
  if (byFile) return { ok: true, url: `https://drive.google.com/file/d/${byFile[1]}/view`, kind: 'drive', fileId: byFile[1], host }
  // /drive/folders/<id>
  const byFolder = u.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)/)
  if (byFolder) return { ok: true, url: `https://drive.google.com/drive/folders/${byFolder[1]}`, kind: 'folder', fileId: byFolder[1], host }
  // ?id=<id> (older share links)
  const byQuery = u.searchParams.get('id')
  if (byQuery && /^[\w-]{20,}$/.test(byQuery)) {
    return { ok: true, url: `https://drive.google.com/file/d/${byQuery}/view`, kind: 'drive', fileId: byQuery, host }
  }
  // A Google URL we do not recognise — keep it rather than reject it.
  return { ok: true, url: u.toString(), kind: 'link', fileId: null, host }
}

/**
 * ⚠️ The canonical URL drops every query and fragment — `?usp=sharing`, `#gid=0`,
 * `/edit` vs `/view`. Two people pasting the same doc from different places must produce
 * the SAME row, or doc_links' UNIQUE constraint never fires and the task grows duplicates.
 */
function canonicalDrive(product, id) {
  return `https://docs.google.com/${product}/d/${id}/edit`
}

/** What to show when there is no label. Never the raw URL — they are unreadable. */
export const KIND_LABEL = {
  doc: 'Google Doc',
  sheet: 'Google Sheet',
  slide: 'Google Slides',
  form: 'Google Form',
  drawing: 'Google Drawing',
  drive: 'Drive file',
  folder: 'Drive folder',
  link: 'Link',
}

/** The `b_number` a link is stored under — the file id when there is one. */
export function linkKey(parsed) {
  if (!parsed?.ok) return null
  // ⚠️ A non-Drive link has no id, so the URL itself is the identity. Lower-cased host
  // + path so trailing-slash and case differences do not create twins.
  if (parsed.fileId) return parsed.fileId
  try {
    const u = new URL(parsed.url)
    return (u.host + u.pathname.replace(/\/+$/, '')).toLowerCase()
  } catch { return parsed.url }
}
