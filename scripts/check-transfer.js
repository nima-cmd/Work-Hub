// scripts/check-transfer.js — how much are we reading out of Neon, and who?
// Run: npm run check:transfer          (reads only; add --neon to force the live DB)
//
// Neon's Free plan allows 5 GB/month of public network transfer and SUSPENDS the
// compute when it runs out. On 2026-08-14 we found out at 84%, on the 14th, from an
// email. This is so the next time we know before the email.
//
// ⚠️ AN ESTIMATE AND A LOWER BOUND — row bytes only, no TLS or wire framing, and only
// processes that report. Neon's console is the authority. Pass --used=4.2GB to
// anchor the projection to the real figure from that console.
import { pool, DB_TARGET } from '../src/db.js'
import { summarizeTransfer, fmtBytes, MONTHLY_LIMIT_BYTES } from '../src/model/transferMeter.js'

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || null
const parseSize = (s) => {
  if (!s) return null
  const m = String(s).trim().match(/^([\d.]+)\s*(GB|MB|KB|B)?$/i)
  if (!m) return null
  const mult = { GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024, B: 1 }[(m[2] || 'B').toUpperCase()]
  return Number(m[1]) * mult
}

const today = new Date().toISOString().slice(0, 10)
let rows = []
try {
  ;({ rows } = await pool.query(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, source, bytes, queries FROM transfer_log ORDER BY day`))
} catch (e) {
  console.error(`\n  transfer_log is not there yet — run \`npm run migrate\`.\n  (${e.message})\n`)
  process.exit(1)
}

const s = summarizeTransfer(rows, { today, knownUsed: parseSize(arg('used')) })

console.log(`\n  NEON TRANSFER\n  ${'─'.repeat(72)}`)
console.log(`  reading: ${DB_TARGET}${DB_TARGET === 'mirror' ? '  ⚠️ the mirror only records LOCAL work, which costs Neon nothing' : ''}`)
console.log(`  month to date: ${fmtBytes(s.used)} of ${fmtBytes(MONTHLY_LIMIT_BYTES)}` +
  ` (${s.pctUsed.toFixed(1)}%)${s.isEstimate ? '  · estimated' : '  · from Neon'}`)
if (s.perDay) console.log(`  rate: ${fmtBytes(s.perDay)}/day over ${s.dayOfMonth} day(s)`)
if (s.projected) console.log(`  projected month end: ${fmtBytes(s.projected)} (${s.pctProjected.toFixed(0)}% of the cap)`)
if (s.daysLeftAtRate != null && Number.isFinite(s.daysLeftAtRate)) {
  console.log(`  runway at this rate: ${s.daysLeftAtRate.toFixed(1)} day(s) · ${s.daysInMonth - s.dayOfMonth} left in the month`)
}

console.log(`\n  WHO`)
if (!s.bySource.length) console.log('      nothing recorded yet')
for (const b of s.bySource) {
  console.log(`      ${b.source.padEnd(8)} ${fmtBytes(b.bytes).padStart(9)} · ${b.queries.toLocaleString()} queries · ${b.days} day(s)`)
}

const mark = { ok: '✓', warn: '!', critical: '✗', exceeded: '✗' }[s.verdict.level]
console.log(`\n  ${'─'.repeat(72)}`)
console.log(`  ${mark} ${s.verdict.headline}`)
console.log(`    ${s.caveat}`)
if (s.verdict.level === 'critical' || s.verdict.level === 'exceeded') {
  console.log('    The LOCAL app keeps working through a suspension — it reads the mirror.')
  console.log('    `npm run db:mirror` while Neon is still up; the Render deploy is what stops.')
}
console.log()
await pool.end()
// Never fail a build on a projection. This informs; it does not gate.
process.exit(0)
