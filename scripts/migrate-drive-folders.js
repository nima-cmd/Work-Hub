// scripts/migrate-drive-folders.js — move the app's two Drive trees under one
// parent, and rename them to the names the app now looks for.
//
//   Work-Hub BOLs   →  Work-Hub Shipping Documents/BOLs
//   Packing Slips   →  Work-Hub Shipping Documents/Boutiques
//
// WHY THIS EXISTS (Nima, 2026-07-31): ensureFolder in src/ingest/googleDrive.js
// resolves folders BY NAME. Changing DRIVE_ROOT_* without touching Drive would
// make the app create fresh empty roots and silently orphan everything already
// filed — the files would still exist, but nothing would ever look there again.
// So the constant change and this migration are one unit.
//
// SAFE BECAUSE: a Drive rename/move keeps the folder's ID, and children keep
// theirs, so every file already filed keeps its id and its webViewLink. Nothing
// is copied, nothing is deleted, and any link the app recorded still resolves.
//
// The app uses the `drive.file` scope, which can only see and modify files the
// app itself created — which is exactly these two trees. It cannot touch anything
// else in Nima's Drive, including a same-named folder someone made by hand.
//
// Idempotent: run it as often as you like. Already-migrated trees report "ok".
//
// Run: npm run migrate:drive        (add --dry to preview without changing Drive)
import { getAccessToken } from '../src/ingest/gmail.js'
import { DRIVE_PARENT, DRIVE_ROOT_BOLS, DRIVE_ROOT_SLIPS } from '../src/ingest/googleDrive.js'

const FILES = 'https://www.googleapis.com/drive/v3/files'
const DRY = process.argv.includes('--dry')

// The old names, paired with what they become. Kept here rather than in the
// module so the app never carries a memory of a name it no longer uses.
const MOVES = [
  { from: 'Work-Hub BOLs', to: DRIVE_ROOT_BOLS },
  { from: 'Packing Slips', to: DRIVE_ROOT_SLIPS },
]

async function main() {
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    console.error('✗ GOOGLE_REFRESH_TOKEN not set — run with --env-file=.env.local')
    process.exit(1)
  }
  const token = await getAccessToken()
  const H = { Authorization: `Bearer ${token}` }
  const JSON_H = { ...H, 'Content-Type': 'application/json' }

  const findFolder = async (name, parentId = null) => {
    const q = [
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      `name='${name.replace(/'/g, "\\'")}'`,
      parentId ? `'${parentId}' in parents` : "'root' in parents",
    ].join(' and ')
    const res = await fetch(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id,name,parents)`, { headers: H })
    if (!res.ok) throw new Error(`Drive list ${res.status}: ${await res.text().catch(() => '')}`)
    return (await res.json()).files?.[0] || null
  }

  // ── the parent ──
  let parent = await findFolder(DRIVE_PARENT)
  if (parent) {
    console.log(`• parent "${DRIVE_PARENT}" already exists (${parent.id})`)
  } else if (DRY) {
    // No id to query against — leave it null and skip the already-migrated probe
    // below rather than sending a placeholder to Drive (it 404s).
    console.log(`• would CREATE parent "${DRIVE_PARENT}"`)
    parent = { id: null }
  } else {
    const res = await fetch(`${FILES}?fields=id`, {
      method: 'POST',
      headers: JSON_H,
      body: JSON.stringify({ name: DRIVE_PARENT, mimeType: 'application/vnd.google-apps.folder' }),
    })
    if (!res.ok) throw new Error(`Drive mkdir ${res.status}: ${await res.text().catch(() => '')}`)
    parent = { id: (await res.json()).id }
    console.log(`✓ created parent "${DRIVE_PARENT}" (${parent.id})`)
  }

  // ── each tree ──
  for (const { from, to } of MOVES) {
    // Already migrated? Then it sits under the parent under its NEW name.
    // (No parent id yet on a dry run — nothing can be under it, so skip.)
    const done = parent.id ? await findFolder(to, parent.id) : null
    if (done) {
      console.log(`✓ "${to}" already under "${DRIVE_PARENT}" (${done.id}) — nothing to do`)
      continue
    }
    const old = await findFolder(from)
    if (!old) {
      // Nothing to move. Not an error: the app creates the tree on first upload.
      console.log(`• "${from}" not found at Drive root — will be created on first use as "${to}"`)
      continue
    }
    if (DRY) {
      console.log(`• would RENAME "${from}" → "${to}" and move under "${DRIVE_PARENT}" (id ${old.id} unchanged)`)
      continue
    }
    // Rename + reparent in ONE PATCH: the id is preserved, so children and their
    // webViewLinks are untouched.
    const params = new URLSearchParams({
      addParents: parent.id,
      removeParents: (old.parents || []).join(','),
      fields: 'id,name,parents',
    })
    const res = await fetch(`${FILES}/${old.id}?${params}`, {
      method: 'PATCH',
      headers: JSON_H,
      body: JSON.stringify({ name: to }),
    })
    if (!res.ok) throw new Error(`Drive move ${res.status}: ${await res.text().catch(() => '')}`)
    console.log(`✓ "${from}" → "${DRIVE_PARENT}/${to}" (id ${old.id} unchanged, files untouched)`)
  }

  if (DRY) console.log('\n(dry run — Drive was not modified)')
}

main().catch((e) => { console.error('✗', e.message); process.exit(1) })
