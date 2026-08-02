// src/model/filing.js — step 7 of Nima's flow: scan the signed paper and file it.
//
// The scan→Drive pipeline has worked on real paper since 2026-07-31, but it was
// fire-and-forget: `fileScannedDoc` uploaded to Drive and returned links, and
// nothing anywhere recorded that a document had been filed. Drive was the only
// register, and the app can't read it back. So the one question step 7 exists to
// answer — "which shipments left and still have no paper?" — had no answer.
//
// This module owns the two decisions that question needs: what a filing attaches
// to, and which unfiled shipments are actually YOUR PROBLEM TODAY versus which
// are archive backlog.
//
// ── Why there is an epoch ────────────────────────────────────────────────────
//
// FILED events start the day this lands. Nothing before it was recorded, so on
// day one 91 shipments from the previous 60 days have no filing event — and
// almost all of them do in fact have paper, sitting in a binder or already in
// Drive from a run the app didn't log.
//
// Backfilling a guess is exactly what the ledger's honest-timestamp rule forbids
// (see orderEvents.js). And surfacing all 91 as work would be worse than useless:
// a court-strip chip that opens at 91 and can only be cleared by scanning two
// months of backlog is a chip you collapse on day one — the same burying the
// strip exists to undo (see [[work-hub-court-strip]]'s never-lump rule).
//
// So the two are split rather than summed. `due` is the live obligation and
// starts empty; `backlog` is a deliberate archive project you chip at on a slow
// day. Filing either one goes through the identical path and records the same
// event — the epoch changes what NAGS you, never what you're allowed to file.

// The day filing became a recorded fact. Shipments that departed before this
// have no filing event because none was ever written, not because the paper is
// missing — so they are never counted as due.
//
// A constant rather than "the earliest FILED event we can find": that would be
// self-bootstrapping right up until the first time someone files an old backlog
// slip, which would drag the epoch backwards and flood the due count with
// shipments nobody had fallen behind on.
export const FILING_LEDGER_START = '2026-08-02'

export const FILED_EVENT = 'FILED'

// A date that arrived as a Date, a string, or nothing. Never an Invalid Date —
// that would sort as NaN and quietly land a shipment in whichever bucket the
// comparison happened to fall through to.
function asDate(v) {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

// Whole days between two dates, floor. Same convention as the label-gap ages.
export function daysBetween(from, to) {
  const a = asDate(from)
  const b = asDate(to)
  if (!a || !b) return null
  return Math.floor((b.getTime() - a.getTime()) / 86400000)
}

// Which document a filing attaches to, given one entry from the scan plan.
//
// The QR decides. A packing slip carries `IF<n>`, so both a boutique slip and a
// per-DC EDI slip resolve to their fulfilment — that is the honest key, because
// the fulfilment is the thing that physically shipped. The old bare-PO labels
// and the per-DC tags have no IF, so they attach to the same `<po>:<dc>` doc
// key the custody DC scans already use, keeping one timeline per DC.
//
// The master BOL covers several POs and is not one shipment's paper at all, so
// it gets no event. Filing it is real work, but "the master BOL is in Drive"
// does not tell you any individual shipment's slip was filed — recording it
// against every covered PO would mark them all filed on the strength of a
// document that isn't their slip. Returns null; the caller uploads it anyway.
export function filingTarget(doc = {}) {
  if (!doc || doc.skip) return null
  if (doc.ifNumber) {
    return { docType: 'IF', docNumber: String(doc.ifNumber).toUpperCase(), soNumber: doc.soNumber || null }
  }
  if (doc.po) {
    return { docType: 'DC', docNumber: `${doc.po}:${doc.dc || ''}`, soNumber: null }
  }
  return null
}

// A human note for the event, so the Ledger row says where the paper went
// rather than just "filed". Kept short — the Drive link lives in the upload
// result, not the ledger.
export function filingNote(doc = {}, { partner, pos } = {}) {
  const where = [partner || doc.partner, (pos || doc.pos)?.[0]].filter(Boolean).join('/')
  const name = doc.filename || null
  return [name, where && `→ ${where}`].filter(Boolean).join(' ') || null
}

// Split unfiled shipments into what you owe today and what is archive.
//
//   rows: [{ ifNumber, soNumber, customer, channel, shippedAt }] — shipped
//         fulfilments that carry NO FILED event (the query does that half).
//
// A shipment with no ship date can't be placed on either side of the epoch. It
// goes to backlog rather than due: claiming an undated shipment is overdue is a
// guess, and this whole module exists to not make those.
export function splitUnfiled(rows = [], { start = FILING_LEDGER_START, now = new Date() } = {}) {
  const epoch = asDate(start)
  const due = []
  const backlog = []
  for (const r of rows) {
    const shippedAt = asDate(r.shippedAt)
    const entry = { ...r, shippedAt, ageDays: daysBetween(shippedAt, now) }
    if (shippedAt && epoch && shippedAt.getTime() >= epoch.getTime()) due.push(entry)
    else backlog.push(entry)
  }
  const byOldest = (a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1)
  due.sort(byOldest)
  backlog.sort(byOldest)
  return {
    due,
    backlog,
    counts: { due: due.length, backlog: backlog.length },
    since: start,
  }
}
