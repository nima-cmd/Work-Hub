// src/ingest/arithmeticSweep.js — run the arithmetic-field rule over the real DB.
//
// The rule itself lives in src/model/arithmeticFields.js and is pure. This file only
// decides WHICH columns to point it at and does the SQL. Split that way because the
// rule is the part worth testing and the SQL is the part that changes when a table
// gains a column.
//
// Read-only. Writes nothing, ever.

import { pool } from '../db.js'
import { analyzeOffsets, columnPairs, isExpected, MIN_ROWS } from '../model/arithmeticFields.js'

const DATE_TYPES = ['date', 'timestamp with time zone', 'timestamp without time zone']
const NUM_TYPES = ['integer', 'numeric', 'bigint', 'double precision', 'real', 'smallint']

// ⚠️ Bookkeeping columns are excluded as BASES and as CANDIDATES. `created_at` and
// `updated_at` are stamped by the app on write, so a row nobody has edited has them
// equal by construction and a row loaded in one batch has them equal to each other's
// batch — that is a property of our own writer, not a claim about the business, and
// nothing reads them as evidence of anything. Including them buries the real
// findings under one row per table.
const IGNORED = new Set([
  'created_at', 'updated_at', 'first_seen', 'last_seen', 'checked_at', 'synced_at',
  'inserted_at', 'imported_at', 'fetched_at',
])

// Surrogate keys and counters are numerically meaningless to subtract.
const IGNORED_NUM = new Set(['id', 'shipment_id', 'auth_id', 'line', 'seq', 'position'])

export async function listSweepColumns(db = pool) {
  const { rows } = await db.query(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND (c.data_type = ANY($1) OR c.data_type = ANY($2))
      ORDER BY c.table_name, c.ordinal_position`,
    [DATE_TYPES, NUM_TYPES],
  )
  const byTable = new Map()
  for (const r of rows) {
    if (IGNORED.has(r.column_name)) continue
    const isDate = DATE_TYPES.includes(r.data_type)
    if (!isDate && IGNORED_NUM.has(r.column_name)) continue
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, { dates: [], nums: [] })
    byTable.get(r.table_name)[isDate ? 'dates' : 'nums'].push(r.column_name)
  }
  return byTable
}

// ⚠️ Identifiers are interpolated, so they are whitelisted against
// information_schema first (above) and quoted here. They can never come from a
// request — this script has no input.
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"'

// How many distinct non-null values a column holds. Cached per column, because the
// same column appears in every pair its table can form.
async function distinctCount(table, col, cache, db) {
  const key = `${table}.${col}`
  if (!cache.has(key)) {
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT ${q(col)}) AS n FROM ${q(table)} WHERE ${q(col)} IS NOT NULL`)
    cache.set(key, Number(rows[0].n))
  }
  return cache.get(key)
}

async function offsetsFor(table, a, b, kind, db) {
  // Dates are compared in DAYS: a formula is "+28 days", and a timestamp difference
  // in seconds would scatter the same offset across thousands of values purely from
  // the time of day, hiding the very pattern this looks for.
  const expr = kind === 'date'
    ? `(${q(a)}::date - ${q(b)}::date)`
    : `(${q(a)} - ${q(b)})`
  const { rows } = await db.query(
    `SELECT ${expr} AS off FROM ${q(table)}
      WHERE ${q(a)} IS NOT NULL AND ${q(b)} IS NOT NULL`,
  )
  return rows.map((r) => Number(r.off)).filter((n) => Number.isFinite(n))
}

/**
 * Sweep every table for columns that are arithmetic on a sibling column.
 * Returns { findings, pairsTested, tables }.
 */
export async function sweepArithmeticFields({ db = pool, minRows = MIN_ROWS } = {}) {
  const byTable = await listSweepColumns(db)
  const findings = []
  const constantFindings = []
  const constants = new Set()
  const distinct = new Map()
  let pairsTested = 0

  for (const [table, cols] of byTable) {
    for (const [kind, list] of [['date', cols.dates], ['num', cols.nums]]) {
      for (const [a, b] of columnPairs(list)) {
        let offsets
        try {
          offsets = await offsetsFor(table, a, b, kind, db)
        } catch {
          // A column type that will not subtract (an array, an enum) is not a
          // failure of the sweep — it is simply not a candidate.
          continue
        }
        pairsTested++
        const [distinctA, distinctB] = await Promise.all([
          distinctCount(table, a, distinct, db), distinctCount(table, b, distinct, db),
        ])
        const result = analyzeOffsets(offsets, { minRows, distinctA, distinctB })
        if (result.verdict === 'constant') {
          // Deduped by COLUMN, not by pair — a dead column pairs with every sibling
          // and would otherwise be reported once per sibling.
          for (const [dead, col] of [[result.deadA, a], [result.deadB, b]]) {
            if (!dead || constants.has(`${table}.${col}`)) continue
            constants.add(`${table}.${col}`)
            constantFindings.push({ table, column: col, kind })
          }
          continue
        }
        if (result.verdict !== 'derived' && result.verdict !== 'copy') continue
        // Report the direction whose offset is positive, so the sentence reads
        // "later column = earlier column + N" the way a human would say it.
        const flip = result.top[0].offset < 0
        findings.push({
          table,
          column: flip ? b : a,
          basis: flip ? a : b,
          unit: kind === 'date' ? 'days' : 'units',
          expected: isExpected(table, a, b),
          result: flip
            ? { ...result, top: result.top.map((t) => ({ ...t, offset: -t.offset })) }
            : result,
        })
      }
    }
  }
  // Loudest first: a formula covering more rows is a bigger claim.
  findings.sort((x, y) => y.result.covered - x.result.covered)
  constantFindings.sort((x, y) => (x.table + x.column).localeCompare(y.table + y.column))
  return { findings, constantFindings, pairsTested, tables: byTable.size }
}
