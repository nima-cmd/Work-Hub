// scripts/check-neon.js — is the database answering, and WHICH ONE?
//
// ⚠️ The "which one" is the load-bearing half, and this script got it wrong the day the
// app moved to DigitalOcean (2026-08-18): it printed "✓ UP  NEON · 320 orders" while
// connected to DO, and projected transfer against Neon's 5 GB cap. Both halves false.
// The label now comes from DB_TARGET, which src/db.js derives from the connection itself.
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

const LABEL = {
  mirror: 'LOCAL MIRROR',
  neon: 'NEON',
  digitalocean: 'DIGITALOCEAN (managed)',
  other: 'REMOTE POSTGRES',
}
console.log(`\n  ${up ? '✓ UP  ' : '✗ DOWN'}  ${LABEL[DB_TARGET] || DB_TARGET.toUpperCase()}${IS_OFFLINE ? ' (offline mode — writes stay local)' : ''}`)
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

// ⚠️ ONLY ON NEON. "How close to the cap" is a question that exists only where there IS
// a cap: DigitalOcean does not meter managed-database transfer at all, so printing a
// projection against 5 GB there would be inventing a limit. Was `!IS_MIRROR`, which meant
// every non-mirror target inherited Neon's allowance.
if (up && DB_TARGET === 'neon') {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, source, bytes, queries FROM transfer_log`)
    const s = summarizeTransfer(rows, { today: new Date().toISOString().slice(0, 10) })
    console.log(`         transfer: ${fmtBytes(s.today.bytes)} today · ${fmtBytes(s.used)} of ${fmtBytes(s.limitBytes)} measured this month`)
    if (s.verdict.level !== 'ok') console.log(`         ${s.verdict.headline}`)
  } catch { /* pre-migration, or the table is gone — not this script's problem */ }
}

if (!up && DB_TARGET === 'neon') {
  console.log('\n  To keep working:')
  console.log('      npm run dev:offline      # the whole app on local Postgres, writes allowed')
  console.log('      npm run check:neon       # run this again to see when it is back')
  console.log('  ⚠ Do NOT `npm run db:mirror` while offline work is unsaved — it drops the local DB.')
}
console.log()
await pool.end()
process.exit(up ? 0 : 1)
