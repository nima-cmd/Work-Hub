// Advance bol_number_seq past every number already in bol_registry.
//
// Nima, 2026-08-21, generating a BOL from the Base:
//   ⚠ duplicate key value violates unique constraint "bol_registry_pkey"
//
// ⚠️ THAT ERROR WAS THE GUARANTEE WORKING, not failing. bol_registry exists so a BOL
// number is never reissued, and the insert refused to mint NB1731241 because
// NB1731241 already exists. The defect is upstream: the SEQUENCE is behind the data.
//
// Measured 2026-08-21 on DigitalOcean:
//   bol_number_seq  last_value 1731240   -> next would be NB1731241
//   bol_registry    holds NB1731231 .. NB1731267  (37 rows)
//   so the next 27 attempts each collide, one number at a time.
//
// ── ROOT CAUSE ──────────────────────────────────────────────────────────────
//
// The DigitalOcean cutover copied the rows and did not advance this sequence.
// db-copy.js and db-mirror.js both discover sequences with
// `pg_get_serial_sequence(table, column)`, which only ever returns a sequence OWNED
// BY A COLUMN (SERIAL / IDENTITY). `bol_number_seq` is a standalone CREATE SEQUENCE
// with no owning column, so it is invisible to that query — and both scripts then
// print "N sequence(s) advanced past the copied ids", a reassuring green line that
// silently excluded the only sequence in this database that governs a number which
// must never be reused. 15 of 16 sequences are column-owned and were handled; this
// was the 1.
//
// Both scripts are fixed in the same commit. This one repairs the live value.
//
// ⚠️ FORWARD ONLY. setval never moves the sequence back, so this cannot cause a
// reissue even if run twice, and it consumes no number itself. It is a no-op once
// the sequence is already ahead.
//
// Usage:
//   node --env-file=.env.local scripts/fix-bol-sequence.js          # dry run
//   node --env-file=.env.local scripts/fix-bol-sequence.js --apply

import { pool, DB_TARGET } from '../src/db.js'
import { bolSequenceVerdict } from '../src/model/bolSequence.js'

const apply = process.argv.includes('--apply')

const [{ last_value: lastValue, is_called: isCalled }] =
  (await pool.query('SELECT last_value, is_called FROM bol_number_seq')).rows
const [{ max_used: maxUsed, n }] = (await pool.query(
  `SELECT max(nullif(regexp_replace(bol_number, '\\D', '', 'g'), '')::bigint) AS max_used,
          count(*) AS n
     FROM bol_registry`)).rows

const v = bolSequenceVerdict({ lastValue, isCalled, maxUsed })

console.log(`Database: ${DB_TARGET}`)
console.log(`bol_registry: ${n} minted number(s), highest ${v.maxUsed ?? '—'}`)
console.log(`bol_number_seq: last_value ${lastValue} (is_called=${isCalled}) -> next would be ${v.next}`)

if (!v.behind) {
  console.log(`\n✓ The sequence is ahead of the registry. Nothing to do.`)
  process.exit(0)
}

console.log(`\n⚠️ BEHIND by ${v.collisions} number(s). Every one of the next ${v.collisions} ` +
  `BOL attempts would collide on a number that is already minted.`)
console.log(`   Would advance the sequence so the next BOL is NB${v.shouldBe + 1}.`)

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply.`)
  process.exit(0)
}

// is_called = true, so the NEXT nextval() returns shouldBe + 1 — the first number
// strictly above everything ever minted.
await pool.query('SELECT setval($1, $2, true)', ['bol_number_seq', String(v.shouldBe)])

const after = (await pool.query('SELECT last_value, is_called FROM bol_number_seq')).rows[0]
const check = bolSequenceVerdict({ lastValue: after.last_value, isCalled: after.is_called, maxUsed })
console.log(`\nAdvanced. Next BOL will be NB${check.next}.`)
console.log(check.behind
  ? '⚠️ STILL BEHIND — do not generate a BOL; investigate before trying again.'
  : '✓ Verified: the next number is above every number ever minted.')
process.exit(0)
