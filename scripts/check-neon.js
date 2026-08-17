// scripts/check-neon.js — is the database answering, and which one?
// Run: npm run check:neon
//
// Nima, 2026-08-17: "how will i know when its offline". This is the direct answer, so
// it never has to be inferred from a broken page. Costs one COUNT(*) — a few bytes.
//
// Exit 0 = answering · exit 1 = not. So it also works in a script or a shell prompt.
import { pool, DB_TARGET, IS_MIRROR, IS_OFFLINE, mirrorAsOf, explainDbError } from '../src/db.js'
import { summarizeTransfer, fmtBytes } from '../src/model/transferMeter.js'

const t0 = Date.now()
let up = false, detail = ''
try {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM orders')
  up = true
  detail = `${rows[0].n} orders · ${Date.now() - t0}ms`
} catch (e) {
  detail = explainDbError(e).message
}

console.log(`\n  ${up ? '✓ UP  ' : '✗ DOWN'}  ${IS_MIRROR ? 'LOCAL MIRROR' : 'NEON'}${IS_OFFLINE ? ' (offline mode — writes stay local)' : ''}`)
console.log(`         ${detail}`)

if (up && IS_MIRROR) {
  const m = await mirrorAsOf()
  if (m?.ageHours != null) {
    console.log(`         cloned ${m.ageHours < 1 ? `${Math.round(m.ageHours * 60)} min` : `${m.ageHours.toFixed(1)}h`} ago`)
    // ⚠️ A mirror older than a day is a mirror whose numbers should not be quoted as
    // live. Said here because this is the command someone runs when they are unsure.
    if (m.ageHours > 24) console.log('         ⚠ over a day old — re-clone before trusting these numbers')
  }
}

// On Neon, show the allowance too: "is it up" and "how close is it" are the same
// worry, and answering half of it invites a second command nobody runs.
if (up && !IS_MIRROR) {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, source, bytes, queries FROM transfer_log`)
    const s = summarizeTransfer(rows, { today: new Date().toISOString().slice(0, 10) })
    console.log(`         transfer: ${fmtBytes(s.today.bytes)} today · ${fmtBytes(s.used)} of ${fmtBytes(s.limitBytes)} measured this month`)
    if (s.verdict.level !== 'ok') console.log(`         ${s.verdict.headline}`)
  } catch { /* pre-migration, or the table is gone — not this script's problem */ }
}

if (!up && !IS_MIRROR) {
  console.log('\n  To keep working:')
  console.log('      npm run dev:offline      # the whole app on local Postgres, writes allowed')
  console.log('      npm run check:neon       # run this again to see when it is back')
  console.log('  ⚠ Do NOT `npm run db:mirror` while offline work is unsaved — it drops the local DB.')
}
console.log()
await pool.end()
process.exit(up ? 0 : 1)
