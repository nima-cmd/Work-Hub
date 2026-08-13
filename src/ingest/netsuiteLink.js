// src/ingest/netsuiteLink.js — resolve one of our document numbers to its NetSuite URL.
//
// Rules and every URL live in src/model/netsuiteLinks.js (pure, tested). This file only
// asks NetSuite and remembers the answer.
//
// ── ⚠️ NO `ns_id` COLUMN, ON PURPOSE ───────────────────────────────────────────
//
// The obvious design is to store each document's internal id alongside its number and
// skip the lookup. It buys about a second, and it costs a migration, a backfill and a
// third place for the two systems to disagree. More to the point the DESTINATION IS
// NETSUITE: if NetSuite is down, a cached id gets you to a page that will not load. So
// the id is fetched on demand and held in memory for the life of the process — a
// transaction's internal id and record type never change once it exists, which is
// exactly the shape that is safe to cache and pointless to persist.

import { runSuiteQL, netsuiteConfigured, netsuiteCreds } from './netsuiteApi.js'
import { netsuiteUrl, isDocNumber, normalizeDoc, LINK_ERROR } from '../model/netsuiteLinks.js'

// doc -> { id, recordtype }. Unbounded in principle, bounded in practice by how many
// distinct documents one process is asked about; each entry is two short strings.
const cache = new Map()

export function _resetLinkCache() {
  cache.clear()
}

/**
 * @returns {{ ok: true, url, id, recordtype, cached }} or { ok: false, error }
 *   where `error` is one of LINK_ERROR — never a raw exception message, so a caller
 *   can say something useful without parsing prose.
 */
export async function resolveNetsuiteLink(rawDoc, { _runSuiteQL = runSuiteQL, env = process.env } = {}) {
  const doc = normalizeDoc(rawDoc)
  // ⚠️ Checked BEFORE the query, and the reason is not just politeness: `doc` is
  // interpolated into SQL below, and this is the gate that makes that safe. The shape
  // is letters-then-digits only, so nothing that passes can carry a quote.
  if (!isDocNumber(doc)) return { ok: false, error: LINK_ERROR.BAD_DOC }
  if (!netsuiteConfigured(env)) return { ok: false, error: LINK_ERROR.NOT_CONFIGURED }

  const account = netsuiteCreds(env).account

  const hit = cache.get(doc)
  if (hit) {
    const url = netsuiteUrl({ account, recordtype: hit.recordtype, id: hit.id })
    return url
      ? { ok: true, url, id: hit.id, recordtype: hit.recordtype, cached: true }
      : { ok: false, error: LINK_ERROR.UNKNOWN_TYPE, recordtype: hit.recordtype }
  }

  const r = await _runSuiteQL(`SELECT id, recordtype, tranid FROM transaction WHERE tranid = '${doc}'`)
  if (!r?.ok) return { ok: false, error: LINK_ERROR.LOOKUP_FAILED, detail: r?.error || null }
  const row = (r.rows || [])[0]
  if (!row) return { ok: false, error: LINK_ERROR.NOT_FOUND }

  cache.set(doc, { id: row.id, recordtype: row.recordtype })
  const url = netsuiteUrl({ account, recordtype: row.recordtype, id: row.id })
  return url
    ? { ok: true, url, id: row.id, recordtype: row.recordtype, cached: false }
    : { ok: false, error: LINK_ERROR.UNKNOWN_TYPE, recordtype: row.recordtype }
}
