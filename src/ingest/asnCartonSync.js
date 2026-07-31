// src/ingest/asnCartonSync.js — run the carton-level ASN reconciliation and
// persist it, so something other than a human at a terminal can ask the question.
//
// The comparison itself lives in src/model/asnCartonCheck.js and is pure. This is
// everything around it: deciding which POs are in scope, closing that scope over
// the ASNs, harvesting the 856 bodies, pulling what NetSuite says actually
// shipped, and writing the verdict to Neon.
//
// WHY IT IS A SYNC AND NOT AN ENDPOINT. A full run costs one Orderful
// message-body GET per delivered ASN (212 of them live) plus two SuiteQL
// queries. That cannot sit inside an HTTP request, so the schedule runs it and
// the UI reads the tables. The harvest is incremental — a delivered 856's body
// is immutable, so it is fetched exactly once ever (see edi_asn_cartons) and
// every later run is two SuiteQL queries and some SQL.
//
// This module exists so the CLI (`npm run check:asn-cartons`) and the scheduled
// caller run the SAME code. A check whose only real implementation is a script
// drifts from whatever the app displays, and then the display is the thing
// nobody trusts.
import { runSuiteQL, netsuiteConfigured } from './netsuiteApi.js'
import { extractAsnManifest } from './orderfulAsn.js'
import { checkAsnCartons, findingRows } from '../model/asnCartonCheck.js'
import { pool } from '../db.js'

const API_BASE = 'https://api.orderful.com/v3/transactions'

// PO numbers are interpolated into SuiteQL (a LIKE pattern can't be bound), so
// they are stripped to the characters a PO number can actually contain. The
// values come from Orderful, i.e. from outside — the check should not be the
// place a partner's malformed reference becomes a query.
const safePo = (po) => String(po ?? '').replace(/[^0-9A-Za-z_-]/g, '')

const chunk = (xs, n) => {
  const out = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

async function fetchMessage(apiKey, id) {
  const res = await fetch(`${API_BASE}/${id}/message`, {
    headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' },
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  return { ok: true, message: await res.json() }
}

// The 856 side of the scope: POs referenced by an outbound 856, newest first.
// `sinceDays` is what the schedule uses (paired with recentlyShippedPos below);
// `recent` is a count-based window for a quick CLI run; `all` is the full audit.
//
// Ordered by when the ASN was SENT, not by PO number: PO numbers are not
// chronological, so sorting on them would make "recent" a lie.
async function posInScope({ recent, all, sinceDays }, db) {
  const { rows } = await db.query(`
    SELECT r.po_number, MAX(t.created_at) AS latest
      FROM edi_document_po_refs r
      JOIN edi_transactions t ON t.id = r.transaction_id
     WHERE t.type ILIKE '%856%' AND t.direction = 'OUT' AND t.stream = 'LIVE'
     GROUP BY r.po_number
     ${sinceDays ? `HAVING MAX(t.created_at) >= now() - ($1 || ' days')::interval` : ''}
     ORDER BY latest DESC
     ${!all && !sinceDays ? 'FETCH FIRST $1 ROWS ONLY' : ''}`,
  sinceDays ? [String(sinceDays)] : all ? [] : [recent])
  return rows.map((r) => r.po_number)
}

// The other half of a windowed scope: POs that SHIPPED recently, whether or not
// their last ASN was recent. Without this, the window has a false negative in
// exactly the case the check exists for — a carton that goes out today on a PO
// whose only 856 is older than the window would drop out of scope and never be
// reported as unannounced.
//
// ⚠️ custbody_po_cd_identifier is FREE TEXT and is used for far more than EDI:
// real values in the last 60 days include "EveSummer26-11-", "PO1681 -
// Liberty26-", "Selfridges Summer-" and "720-0326-19551-". Splitting on a hyphen
// to get "the PO number" produces garbage. So each value is matched against the
// PO numbers Neon actually knows from the EDI documents — an exact
// `<po>-` prefix — and anything that matches nothing is simply not an EDI PO.
async function recentlyShippedPos(sinceDays, db) {
  const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString().slice(0, 10)
  const q = await runSuiteQL(`
    SELECT DISTINCT custbody_po_cd_identifier AS po_dc
      FROM transaction
     WHERE type='ItemShip' AND status='C'
       AND custbody_po_cd_identifier IS NOT NULL
       AND trandate >= TO_DATE('${cutoff}','YYYY-MM-DD')`)
  if (!q.ok) return { ok: false, error: q.error }

  const { rows: known } = await db.query('SELECT DISTINCT po_number FROM edi_document_po_refs')
  const pos = new Set()
  for (const r of q.rows) {
    const poDc = String(r.po_dc || '')
    for (const k of known) {
      if (poDc.startsWith(`${k.po_number}-`)) { pos.add(k.po_number); break }
    }
  }
  return { ok: true, pos: [...pos] }
}

// ⚠️ The closure is not optional. An 856 is a consolidated manifest and we take
// every SSCC on it, so if a document also covers a PO outside the scope, that
// PO's cartons are never pulled and its boxes read as phantoms. Measured on real
// data 2026-07-31: scoping to PO 6592086 alone reported 12 phantoms, and its ASN
// turned out to span four POs. With the closure the same run is clean.
async function closeScope(pos, db) {
  const docsForPos = async (ps) => (await db.query(`
    SELECT DISTINCT t.id, t.business_number, t.delivery_status, t.trading_partner
      FROM edi_transactions t
      JOIN edi_document_po_refs r ON r.transaction_id = t.id
     WHERE t.type ILIKE '%856%' AND t.direction = 'OUT' AND t.stream = 'LIVE'
       AND r.po_number = ANY($1)
     ORDER BY t.id`, [ps])).rows

  const scope = new Set(pos)
  let docs = []
  for (let pass = 0; pass < 10; pass++) {
    docs = await docsForPos([...scope])
    if (!docs.length) break
    const { rows: co } = await db.query(
      'SELECT DISTINCT po_number FROM edi_document_po_refs WHERE transaction_id = ANY($1)',
      [docs.map((d) => d.id)])
    const before = scope.size
    for (const r of co) scope.add(r.po_number)
    if (scope.size === before) break
  }
  return { pos: [...scope], docs }
}

// Read the carton manifests of the delivered ASNs, fetching only the bodies we
// have never read. Failures are counted and left UNRECORDED so they are retried
// next run — writing a harvest row for an unreadable message would quietly
// convert a transport error into "this ASN declared no cartons".
async function harvestManifests(delivered, apiKey, db, log) {
  const { rows: done } = await db.query(
    'SELECT transaction_id FROM edi_asn_harvest WHERE transaction_id = ANY($1)',
    [delivered.map((d) => d.id)])
  const already = new Set(done.map((r) => r.transaction_id))
  const todo = delivered.filter((d) => !already.has(String(d.id)))
  if (todo.length) log(`Harvesting ${todo.length} ASN body(ies) (${already.size} already read)`)

  let errors = 0
  let packsWithoutSscc = 0
  for (const d of todo) {
    const r = await fetchMessage(apiKey, d.id)
    if (!r.ok) { errors++; log(`  ! ${d.business_number}: ${r.error}`); continue }
    const m = extractAsnManifest(r.message)
    packsWithoutSscc += m.packsWithoutSscc
    // One statement per manifest, not per carton. An ASN carries up to ~40
    // cartons and there are hundreds of ASNs; a round trip each would make the
    // first harvest an hours-long job against Neon.
    const ssccs = [...new Set(m.ssccs)].map(String)
    if (ssccs.length) {
      await db.query(
        `INSERT INTO edi_asn_cartons (transaction_id, sscc)
         SELECT $1, s FROM unnest($2::text[]) AS s
         ON CONFLICT (transaction_id, sscc) DO NOTHING`,
        [String(d.id), ssccs])
    }
    await db.query(
      `INSERT INTO edi_asn_harvest (transaction_id, ssccs, packs_without_sscc, harvested_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (transaction_id) DO UPDATE SET
         ssccs = EXCLUDED.ssccs, packs_without_sscc = EXCLUDED.packs_without_sscc,
         harvested_at = now()`,
      [String(d.id), new Set(m.ssccs).size, m.packsWithoutSscc])
  }

  // The comparison reads back from the table rather than from what was just
  // fetched, so a run that harvested nothing new still compares against the full
  // declared set.
  const { rows } = await db.query(`
    SELECT c.sscc, c.transaction_id, t.business_number
      FROM edi_asn_cartons c
      JOIN edi_transactions t ON t.id = c.transaction_id
     WHERE c.transaction_id = ANY($1)`,
    [delivered.map((d) => String(d.id))])
  return {
    declared: rows.map((r) => ({ sscc: r.sscc, transactionId: r.transaction_id, businessNumber: r.business_number })),
    errors,
    packsWithoutSscc,
  }
}

// What NetSuite says actually shipped. Sequential and chunked on purpose:
// NetSuite governs by CONCURRENT requests and Celigo shares the allowance.
//
// ⚠️ This deliberately omits ediPackagesLive's `status <> 'C'` filter. That feed
// carries only UNSHIPPED fulfilments and is replaced each sync, so by the time an
// 856 exists the cartons have left it by design — this check needs precisely the
// shipped ones, which is why it reads NetSuite instead of edi_packages.
async function packedCartons(pos) {
  const ifs = []
  for (const group of chunk(pos.map(safePo).filter(Boolean), 50)) {
    const q = await runSuiteQL(`
      SELECT id, tranid, status, custbody_po_cd_identifier AS po_dc
        FROM transaction
       WHERE type='ItemShip' AND (${group.map((p) => `custbody_po_cd_identifier LIKE '${p}-%'`).join(' OR ')})`)
    if (!q.ok) return { ok: false, error: q.error }
    ifs.push(...q.rows)
  }
  const shipped = ifs.filter((r) => r.status === 'C')
  if (!shipped.length) return { ok: true, ifs, shipped, packed: [] }

  const byId = new Map(shipped.map((r) => [String(r.id), r]))
  const packed = []
  for (const group of chunk(shipped.map((r) => r.id), 200)) {
    const q = await runSuiteQL(`
      SELECT custrecord_hb_edi_pack_related_iff AS if_id,
             custrecord_hb_edi_package_ucc AS ucc
        FROM customrecord_hb_edi_packages
       WHERE isinactive = 'F'
         AND custrecord_hb_edi_pack_related_iff IN (${group.join(',')})`)
    if (!q.ok) return { ok: false, error: q.error }
    for (const c of q.rows) {
      const f = byId.get(String(c.if_id))
      packed.push({ sscc: c.ucc, ifNumber: f?.tranid ?? null, poDc: f?.po_dc ?? null })
    }
  }
  return { ok: true, ifs, shipped, packed }
}

async function persist(rows, run, db) {
  await db.query('BEGIN')
  try {
    await db.query('DELETE FROM asn_carton_check')
    // Batched: a clean live run is ~700 matched rows plus findings, and a round
    // trip per row is the difference between a second and a minute of Neon time
    // every cycle. 500 rows × 5 params stays far under Postgres' 65535 limit.
    for (const group of chunk(rows, 500)) {
      const params = []
      const values = group.map((r, i) => {
        params.push(r.sscc, r.finding, r.ifNumber, r.poDc, r.declaredOn.filter(Boolean))
        const b = i * 5
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}, now())`
      })
      await db.query(
        `INSERT INTO asn_carton_check (sscc, finding, if_number, po_dc, declared_on, checked_at)
         VALUES ${values.join(',')}`, params)
    }
    await db.query(
      `INSERT INTO asn_carton_run
         (status, scope, pos, pos_requested, docs_delivered, docs_undelivered,
          fulfillments, shipped, message_errors, counts, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [run.status, run.scope, run.pos, run.posRequested, run.docsDelivered, run.docsUndelivered,
        run.fulfillments, run.shipped, run.messageErrors, JSON.stringify(run.counts || {}), run.error || null])
    await db.query('COMMIT')
  } catch (e) {
    await db.query('ROLLBACK')
    throw e
  }
}

// Run the whole thing.
//
//   pos       — check these POs specifically (still closed over their ASNs)
//   sinceDays — POs with 856 or shipping activity in that window. The schedule's
//               mode: it keeps the panel about work that can still be acted on.
//   all       — every PO any outbound 856 references. The full audit; slow, and
//               it surfaces years of history that is mostly no longer actionable.
//   recent    — otherwise, the POs of the N most recently sent ASNs
//   persist   — false for a dry CLI run that shouldn't touch the tables
//
// ⚠️ Whatever picks the scope, the COMPARISON is always whole-PO: every shipped
// fulfilment on every PO in scope, not just the ones inside the window. Windowing
// the comparison instead would report cartons announced on an older ASN as
// phantoms, which is the false alarm the closure below exists to prevent.
export async function syncAsnCartons({
  pos: wantPos = [], recent = 5, all = false, sinceDays = null,
  persist: doPersist = true, log = () => {}, db = pool,
} = {}) {
  if (!process.env.ORDERFUL_API_KEY) return { ok: false, error: 'ORDERFUL_API_KEY not set' }
  if (!netsuiteConfigured()) return { ok: false, error: 'NetSuite not configured' }

  let requested = wantPos.length ? wantPos : await posInScope({ recent, all, sinceDays }, db)
  if (!wantPos.length && sinceDays) {
    const shipped = await recentlyShippedPos(sinceDays, db)
    if (!shipped.ok) return { ok: false, error: `NetSuite (shipped POs): ${shipped.error}` }
    const before = requested.length
    requested = [...new Set([...requested, ...shipped.pos])]
    log(`Scope: ${before} PO(s) with a recent 856, +${requested.length - before} that shipped recently`)
  }
  if (!requested.length) return { ok: true, empty: true, reason: 'no POs with an outbound 856' }

  const { pos, docs } = await closeScope(requested, db)
  if (pos.length > requested.length) log(`Scope closed over co-listed POs: ${requested.length} → ${pos.length}`)

  const delivered = docs.filter((d) => d.delivery_status === 'DELIVERED')
  const undelivered = docs.filter((d) => d.delivery_status !== 'DELIVERED')
  log(`${pos.length} PO(s) · ${docs.length} outbound 856(s): ${delivered.length} delivered, ${undelivered.length} not`)

  const { declared, errors: messageErrors, packsWithoutSscc } = await harvestManifests(delivered, process.env.ORDERFUL_API_KEY, db, log)
  log(`ASN cartons declared: ${declared.length}${packsWithoutSscc ? ` (+${packsWithoutSscc} pack segments with no SSCC)` : ''}`)

  const ns = await packedCartons(pos)
  if (!ns.ok) return { ok: false, error: `NetSuite: ${ns.error}` }
  log(`NetSuite fulfilments: ${ns.ifs.length} (${ns.shipped.length} shipped)`)

  const result = checkAsnCartons({ packed: ns.packed, declared })
  const run = {
    status: result.status,
    // Which claim this run is making. A 60-day window that finds nothing does NOT
    // mean the whole history is clean, and the UI has to be able to say which one
    // it is showing.
    scope: wantPos.length ? 'pos' : all ? 'all' : sinceDays ? `window:${sinceDays}d` : `recent:${recent}`,
    pos: pos.length,
    posRequested: requested.length,
    docsDelivered: delivered.length,
    docsUndelivered: undelivered.length,
    fulfillments: ns.ifs.length,
    shipped: ns.shipped.length,
    messageErrors,
    counts: result.counts,
  }
  if (doPersist) await persist(findingRows(result), run, db)

  return { ok: true, result, run, undelivered, packsWithoutSscc }
}
