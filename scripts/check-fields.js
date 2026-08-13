// scripts/check-fields.js — which columns are DERIVED rather than observed?
// Run: npm run check:fields      (needs .env.local — reads Neon, writes nothing)
//
// The standalone report behind `check:counters`' arithmetic-field assertions. Run it
// when a number looks wrong and you want to know what the field it is keyed on is
// actually made of.
//
// The question it asks: **is this column always another column plus a constant?**
// `transaction.shipdate` was `trandate + 28` on 1,234 of 1,254 sales orders — a
// NetSuite default lead time nobody types — and the app read it as a ship window.
// A distinctness sweep cannot find that; the column had many distinct values and
// looked alive. See src/model/arithmeticFields.js.
import { pool } from '../src/db.js'
import { sweepArithmeticFields } from '../src/ingest/arithmeticSweep.js'
import {
  describeFinding, unrecorded, vanished, isExpected, isExpectedConstant,
} from '../src/model/arithmeticFields.js'

const sweep = await sweepArithmeticFields()
const extra = unrecorded(sweep)
const stale = vanished(sweep)

console.log('\n  DERIVED-FIELD SWEEP\n  ' + '─'.repeat(72))
console.log(`  ${sweep.pairsTested} column pairs across ${sweep.tables} tables\n`)

console.log('  COLUMNS DETERMINED BY ANOTHER COLUMN')
for (const f of sweep.findings) {
  const known = isExpected(f.table, f.column, f.basis)
  console.log(`  ${known ? '·' : '⚠️ NEW'} ${describeFinding(f)}`)
  if (known) console.log(`      recorded: ${known.why}`)
  console.log()
}
if (!sweep.findings.length) console.log('      none\n')

console.log('  COLUMNS WITH ONE DISTINCT VALUE (the is_ats shape)')
for (const c of sweep.constantFindings) {
  const known = isExpectedConstant(c.table, c.column)
  console.log(`  ${known ? '·' : '⚠️ NEW'} ${c.table}.${c.column}${known ? ' — ' + known.why : ''}`)
}
if (!sweep.constantFindings.length) console.log('      none')

const problems = extra.derived.length + extra.constant.length + stale.derived.length + stale.constant.length
console.log('\n  ' + '─'.repeat(72))
if (!problems) {
  console.log('  ✓ every derived and constant column is recorded and explained')
} else {
  if (extra.derived.length || extra.constant.length) {
    console.log(`  ✗ ${extra.derived.length + extra.constant.length} UNRECORDED — a column started being determined by another.`)
    console.log('    Ask what it is keyed on before believing any number that reads it.')
  }
  for (const e of [...stale.derived, ...stale.constant]) {
    console.log(`  ✗ ${e.table}.${e.column} is no longer derived/constant — if that is orders.ship_date,`)
    console.log('    someone started typing real ship windows. Update the baseline.')
  }
}
console.log()
await pool.end()
process.exit(problems ? 1 : 0)
