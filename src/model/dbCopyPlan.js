// src/model/dbCopyPlan.js — the decisions `scripts/db-copy.js` makes, as pure rules.
//
// ── WHY THIS IS A MODULE AND NOT PART OF THE SCRIPT ─────────────────────────
//
// `scripts/db-mirror.js` earned three lessons the hard way — values must round-trip
// through TEXT, sequences must be advanced past the copied ids, and a silently empty
// table is worse than a loud failure. None of that logic was testable, because it was
// interleaved with two live connections. This copy is going to point at a database we
// intend to KEEP, so its guards are the part that must not be discovered wrong.
//
// Everything here is a pure function over strings and column lists. The script owns
// the sockets; this owns the answers.

/** Named endpoints, so a command line never has to carry a credential. */
export const ENDPOINTS = {
  neon: 'DATABASE_URL',
  local: 'DATABASE_URL_LOCAL',
  mirror: 'DATABASE_URL_LOCAL',
  do: 'DATABASE_URL_DO',
}

export const ident = (n) => '"' + String(n).replace(/"/g, '""') + '"'

/** neon · local · digitalocean · other — from the host alone. */
export function hostKind(url) {
  let host = ''
  try { host = new URL(url).hostname } catch { return 'other' }
  if (/neon\.tech$|\.neon\.|^neon\./i.test(host)) return 'neon'
  if (/^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host)) return 'local'
  if (/ondigitalocean\.com$/i.test(host)) return 'digitalocean'
  return 'other'
}

/**
 * host/dbname, and NEVER the password. This string goes to stdout and into the
 * copy's own record, so it has to be safe to paste into a PR.
 */
export function describeEndpoint(url) {
  try {
    const u = new URL(url)
    const db = u.pathname.replace(/^\//, '') || '(default)'
    return `${u.hostname}/${db}`
  } catch { return '(unparseable url)' }
}

/** The identity two endpoints must not share: same host, same port, same database. */
export function identityOf(url) {
  try {
    const u = new URL(url)
    return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${u.pathname.replace(/^\//, '')}`
  } catch { return String(url) }
}

/**
 * Resolve `--from=neon` / `--to=do` / a raw postgres:// url against the environment.
 * Returns { name, url, envVar, kind, label } or { name, error }.
 */
export function resolveEndpoint(name, env = {}) {
  if (!name) return { name, error: 'no endpoint given' }
  if (/^postgres(ql)?:\/\//i.test(name)) {
    return { name: describeEndpoint(name), url: name, envVar: null, kind: hostKind(name), label: describeEndpoint(name) }
  }
  const key = String(name).toLowerCase()
  const envVar = ENDPOINTS[key]
  if (!envVar) {
    return { name: key, error: `unknown endpoint "${name}" — use one of ${Object.keys(ENDPOINTS).join(', ')}, or a full postgres:// url` }
  }
  const url = env[envVar]
  if (!url) return { name: key, envVar, error: `${envVar} is not set (needed for "${key}")` }
  return { name: key, url, envVar, kind: hostKind(url), label: describeEndpoint(url) }
}

/**
 * Every reason to refuse, as sentences. Empty array = safe to proceed.
 *
 * ⚠️ THE TARGET MAY NEVER BE NEON, and there is no override flag. Neon is currently
 * the ONLY record of the app-owned rows written to it after the mirror was cloned
 * (2026-08-17 16:52) — five orders' departure confirmations among them. A script that
 * TRUNCATEs its target must not be able to point at the one copy of that. Reconciling
 * those rows back into Neon is an insert-only job for a different tool.
 */
export function guardCopy({ from, to } = {}) {
  const refusals = []
  if (!from || from.error) refusals.push(`source: ${from?.error || 'missing'}`)
  if (!to || to.error) refusals.push(`target: ${to?.error || 'missing'}`)
  if (refusals.length) return refusals

  if (identityOf(from.url) === identityOf(to.url)) {
    refusals.push(`source and target are the same database (${from.label}) — nothing to copy`)
  }
  if (to.kind === 'neon') {
    refusals.push(
      'the TARGET is Neon. This script empties its target, and Neon holds the only copy '
      + 'of the app-owned rows written since the mirror was cloned. Refusing, with no override.',
    )
  }
  return refusals
}

/**
 * Which columns actually cross, for one table.
 *
 * The source is the authority on what data EXISTS; the target is the authority on the
 * TYPE it lands in. Casting back to the target's own declared type is what made the
 * mirror safe — a type that differs between the two fails loudly here instead of
 * quietly storing text.
 */
export function planTable({ table, sourceCols = [], targetCols = [] }) {
  const byName = new Map(targetCols.map((c) => [c.name, c]))
  if (!targetCols.length) return { table, cols: [], skip: 'table not in the target schema' }
  const cols = sourceCols
    .filter((c) => byName.has(c.name))
    .map((c) => ({ name: c.name, type: byName.get(c.name).type }))
  const skippedColumns = sourceCols.filter((c) => !byName.has(c.name)).map((c) => `${table}.${c.name}`)
  if (!cols.length) return { table, cols: [], skippedColumns, skip: 'no shared columns' }
  return { table, cols, skippedColumns, skip: null }
}

/** SELECT list: every value as TEXT, the one representation every type survives. */
export function selectList(cols) {
  return cols.map((c) => `${ident(c.name)}::text`).join(', ')
}

/** INSERT for `rowCount` tuples, each value cast back to the TARGET's declared type. */
export function insertSql(table, cols, rowCount) {
  let n = 0
  const tuples = []
  for (let i = 0; i < rowCount; i += 1) {
    tuples.push('(' + cols.map((c) => {
      n += 1
      return `$${n}::${c.type}`
    }).join(',') + ')')
  }
  return `INSERT INTO ${ident(table)} (${cols.map((c) => ident(c.name)).join(',')})`
    + ` VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`
}

export function insertParams(cols, chunk) {
  const params = []
  for (const row of chunk) for (const c of cols) params.push(row[c.name])
  return params
}

// ── Verification ────────────────────────────────────────────────────────────
//
// ⚠️ A COUNT IS NOT A COMPARISON. Two tables can hold the same number of different
// rows — and this copy's whole purpose is to be trusted afterwards, so it checks the
// CONTENT as well: one md5 per table over every shared column, computed the same way
// on both sides.
//
// Both sides are read with TimeZone=UTC and DateStyle=ISO first. Without that, a
// timestamptz renders in the session's zone and two identical rows hash differently —
// a false alarm on a check whose only value is that a mismatch means something.

/** md5 of the whole table, order-independent (rows are hashed, then sorted). */
export function tableHashSql(table, cols) {
  const parts = cols.map((c) => `coalesce(${ident(c.name)}::text, ${NULL_MARK})`).join(`, chr(31), `)
  return `SELECT coalesce(md5(string_agg(h, '' ORDER BY h)), 'empty') AS hash`
    + ` FROM (SELECT md5(concat(${parts})) AS h FROM ${ident(table)}) s`
}

/**
 * Same hash, per column, so a mismatch NAMES the column instead of reporting a blob.
 * Costs one query a side and is only run on tables that already disagreed.
 */
export function columnHashSql(table, cols) {
  const per = cols.map((c) => `coalesce(md5(string_agg(coalesce(${ident(c.name)}::text, ${NULL_MARK}), '' `
    + `ORDER BY coalesce(${ident(c.name)}::text, ${NULL_MARK}))), 'empty') AS ${ident(c.name)}`)
  return `SELECT ${per.join(', ')} FROM ${ident(table)}`
}

// A NULL and the literal string 'NULL' must not hash alike.
// ⚠️ NOT chr(0) — Postgres rejects it outright ("null character not permitted"), which
// would have made every hash query an error rather than a comparison.
const NULL_MARK = 'chr(1)'

export const SESSION_SETUP = [`SET TimeZone = 'UTC'`, `SET DateStyle = 'ISO, MDY'`, `SET extra_float_digits = 3`]

/**
 * The verdict, per table and overall. `rows` = [{ table, source, target, sourceHash,
 * targetHash, columns }]. A table the copy SKIPPED is not silently fine — it is
 * reported as its own kind so the caller cannot mistake absence for agreement.
 */
export function verifyVerdict(rows = []) {
  const findings = []
  for (const r of rows) {
    if (r.skip) { findings.push({ table: r.table, kind: 'skipped', detail: r.skip }); continue }
    if (r.source !== r.target) {
      findings.push({
        table: r.table,
        kind: 'row-count',
        detail: `source ${Number(r.source).toLocaleString()} rows, target ${Number(r.target).toLocaleString()}`,
      })
      continue
    }
    if (r.sourceHash && r.targetHash && r.sourceHash !== r.targetHash) {
      const cols = (r.columns || []).filter((c) => c.sourceHash !== c.targetHash).map((c) => c.name)
      findings.push({
        table: r.table,
        kind: 'content',
        detail: cols.length ? `same ${r.source} rows, differing values in: ${cols.join(', ')}` : `same ${r.source} rows, different content`,
        columns: cols,
      })
    }
  }
  const blocking = findings.filter((f) => f.kind !== 'skipped')
  return {
    ok: blocking.length === 0,
    findings,
    matched: rows.filter((r) => !r.skip).length - blocking.length,
    checked: rows.filter((r) => !r.skip).length,
  }
}

/**
 * What the verification actually compared, for the summary line.
 *
 * ⚠️ This is a function, and tested, because the first version hardcoded
 * "(rows + content)" and printed it under --counts-only too — a counter claiming more
 * than it did, which is CLAUDE.md's second counter-bug shape and the exact reason
 * `npm run check:counters` exists.
 */
export function verifyBasisLabel(countsOnly) {
  return countsOnly ? 'row counts only — content NOT compared' : 'rows + content'
}
