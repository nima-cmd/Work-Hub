// src/model/asnCartonCheck.js — did every carton that shipped actually get
// announced on an 856?
//
// The sibling of packCheck.js, one level down. The pack check asks "is every UNIT
// on the fulfilment inside a carton"; this asks "is every CARTON that left the
// building named on an ASN the partner actually received". Both failures land as
// the same retailer chargeback weeks later, but they need opposite fixes:
//   • pack short   → go finish packing the box
//   • undeclared   → go send (or re-send) the ASN; the box is already gone
//
// The join is the SSCC — the per-carton license plate. NetSuite writes it on the
// carton record (custrecord_hb_edi_package_ucc) and the 856 transmits the same
// value in a pack-level HL segment, so the two sides are directly comparable
// without needing to resolve which 856 covers which fulfilment. That matters: an
// 856 is a consolidated manifest (one real Bloomingdale's ASN carried 18 cartons
// across 3 different POs), so any IF-to-document mapping would be a guess. The
// SSCC set IS the mapping.
//
// ⚠️ Do NOT try to link a carton to its 856 via the fulfilment's
// custbody_hb_edi_transaction_id. Verified 2026-07-31: that field holds the same
// value for every IF on a purchase order (8 IFs across 4 different DCs all read
// 993832000), so it points at the inbound 850, not the outbound 856.
//
// Nothing here touches a database or the network.

// An SSCC-18 is 18 digits. NetSuite stores exactly that (`185072747095765391`),
// but the 856 transmits it zero-padded — 20 characters on real Bloomingdale's
// data (`00185072747003728869`). A plain string compare therefore reports EVERY
// carton as undeclared, which reads as a catastrophe rather than a format
// mismatch.
//
// Only leading ZEROS are stripped, and only down to 18. A value that is too long
// for some other reason keeps its digits so it shows up as a real mismatch
// instead of being silently truncated into a false match.
export function normalizeSscc(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (!digits) return null
  let s = digits
  while (s.length > 18 && s.startsWith('0')) s = s.slice(1)
  return s
}

const keyed = (rows, field) => {
  const map = new Map()
  for (const r of rows) {
    const k = normalizeSscc(r?.[field])
    if (!k) continue
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(r)
  }
  return map
}

// Compare what shipped against what was announced.
//
//   packed   — carton rows from NetSuite: { sscc, ifNumber?, poDc? }
//   declared — pack-level entries from outbound 856s: { sscc, transactionId?,
//              businessNumber?, deliveryStatus? }
//
// `declared` should only contain ASNs that actually reached the partner. An 856
// sitting undelivered in Orderful has announced nothing — that's a different
// check (ediDelivery.js) and folding it in here would mark a carton "announced"
// on the strength of a document nobody received.
export function checkAsnCartons({ packed = [], declared = [] } = {}) {
  const packedBy = keyed(packed, 'sscc')
  const declaredBy = keyed(declared, 'sscc')

  // Cartons with no SSCC at all can't be reconciled in either direction. Same
  // shape of human error as the pack check's blank-quantity cartons: the box was
  // made and a field was left empty, so it's reported separately rather than
  // counted as a miss.
  const blankSscc = packed.filter((p) => !normalizeSscc(p?.sscc))

  const matched = []
  const undeclared = []
  for (const [sscc, rows] of packedBy) {
    const hit = declaredBy.get(sscc)
    const entry = { sscc, cartons: rows, ifNumber: rows[0]?.ifNumber ?? null, poDc: rows[0]?.poDc ?? null }
    if (hit) matched.push({ ...entry, declaredOn: hit.map((d) => d.businessNumber ?? d.transactionId ?? null) })
    else undeclared.push(entry)
  }

  // Announced but not in NetSuite. Either the carton record was deleted after
  // the ASN went out, or the ASN invented a box — both leave the partner waiting
  // for a carton that never arrives, so it is a real finding, not noise.
  const phantom = []
  for (const [sscc, rows] of declaredBy) {
    if (packedBy.has(sscc)) continue
    phantom.push({ sscc, declaredOn: rows.map((d) => d.businessNumber ?? d.transactionId ?? null) })
  }

  // A duplicated SSCC is its own defect — the license plate is supposed to be
  // unique, and two cartons sharing one make the partner's receiving scan
  // ambiguous.
  const duplicated = [...packedBy.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([sscc, rows]) => ({ sscc, count: rows.length, ifNumbers: rows.map((r) => r.ifNumber ?? null) }))

  // The same carton announced on more than one ASN. Usually benign — a corrected
  // 856 re-declares the boxes — but it is reported because it explains why a raw
  // count of declared segments exceeds the unique carton count. An unexplained
  // gap between those two numbers is exactly what makes someone distrust the
  // check and stop reading it.
  const reDeclared = [...declaredBy.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([sscc, rows]) => ({ sscc, count: rows.length, declaredOn: rows.map((d) => d.businessNumber ?? d.transactionId ?? null) }))

  // Ordered so the worst real finding wins. `no_asn` is deliberately distinct
  // from `undeclared`: before anything is transmitted there is nothing to
  // reconcile, and calling that a failure is the noise that gets a check ignored
  // (the same reasoning as packCheck's not_started).
  const status = !packedBy.size && !declaredBy.size ? 'empty'
    : !declaredBy.size ? 'no_asn'
      : undeclared.length ? 'undeclared'
        : phantom.length ? 'phantom'
          : 'ok'

  // With no ASN at all, every carton would otherwise land in `undeclared` and
  // fill the re-send queue with shipments whose ASN isn't due yet. The status
  // already says `no_asn` loudly; the actionable list stays empty so it only
  // ever contains cartons an ASN genuinely missed.
  //
  // ⚠️ This makes SCOPING the caller's job: feeding in cartons from fulfilments
  // that have already SHIPPED is what turns `no_asn` into a real finding. An
  // unshipped fulfilment with no ASN is normal; a shipped one is the
  // never-transmitted gap ediDelivery.js tracks.
  const actionable = status === 'no_asn' ? [] : undeclared

  return {
    status,
    clean: status === 'ok',
    counts: {
      packed: packedBy.size,
      declared: declaredBy.size,
      matched: matched.length,
      undeclared: actionable.length,
      phantom: phantom.length,
      blankSscc: blankSscc.length,
      duplicated: duplicated.length,
      reDeclared: reDeclared.length,
    },
    matched,
    undeclared: actionable,
    phantom,
    blankSscc,
    duplicated,
    reDeclared,
  }
}

// Group the undeclared cartons by fulfilment — the actionable unit. You re-send
// an ASN for a shipment, not for a single box.
export function undeclaredByFulfilment(result) {
  const by = new Map()
  for (const u of result?.undeclared || []) {
    const k = u.ifNumber ?? '(unknown IF)'
    if (!by.has(k)) by.set(k, { ifNumber: u.ifNumber ?? null, poDc: u.poDc ?? null, ssccs: [] })
    by.get(k).ssccs.push(u.sscc)
  }
  return [...by.values()].sort((a, b) => b.ssccs.length - a.ssccs.length)
}

// Findings as rows. Matched cartons are kept, not just failures: the headline is
// "710/710 announced", and that denominator is the evidence the two sides are
// comparable at all. Counts are NOT derived from these rows — a duplicated SSCC
// is also matched, so aggregating by finding would double-count. The run row
// carries the model's counts verbatim instead.
export function findingRows(result) {
  const rows = []
  for (const m of result.matched) {
    rows.push({ sscc: m.sscc, finding: 'matched', ifNumber: m.ifNumber, poDc: m.poDc, declaredOn: m.declaredOn || [] })
  }
  for (const u of result.undeclared) {
    rows.push({ sscc: u.sscc, finding: 'undeclared', ifNumber: u.ifNumber, poDc: u.poDc, declaredOn: [] })
  }
  for (const p of result.phantom) {
    rows.push({ sscc: p.sscc, finding: 'phantom', ifNumber: null, poDc: null, declaredOn: p.declaredOn || [] })
  }
  for (const b of result.blankSscc) {
    rows.push({ sscc: null, finding: 'blank_sscc', ifNumber: b.ifNumber ?? null, poDc: b.poDc ?? null, declaredOn: [] })
  }
  // One row per (SSCC, fulfilment) pair — the actionable fact about a duplicated
  // license plate is WHICH boxes share it.
  for (const d of result.duplicated) {
    for (const ifNumber of d.ifNumbers) {
      rows.push({ sscc: d.sscc, finding: 'duplicated', ifNumber, poDc: null, declaredOn: [] })
    }
  }
  return rows
}

// How often the scheduled caller re-runs this. A full run costs one Orderful
// message GET per delivered ASN the first time it sees it plus two SuiteQL
// queries every time, and the recurring check fires roughly every 90 minutes
// (GitHub throttles scheduled workflows — see syncHealth.js), so re-checking on
// every cycle would spend NetSuite's shared concurrency allowance re-answering a
// question whose inputs move a few times a day.
//
// Six hours is chosen against what it's protecting: an undeclared carton has
// already left the building, so the fix is sending an ASN, not catching it in the
// next ten minutes. A missed carton found four times a day is found in time.
export const ASN_CHECK_MIN_HOURS = 6

// How far back the SCHEDULED run looks for POs to check — on both sides: a
// recent 856, or a recent shipment. Not the whole history, which the full audit
// (`--all`) covers: measured 2026-07-31, full history is ~14 minutes and reports
// 127 undeclared cartons on 2023-era POs, one of them announcing the SSCC
// "12345678910123456789". Pinning years of unactionable history to a live panel
// is how a check earns being ignored.
//
// 120 days, not 60, and the reason is a real finding: the first windowed run
// caught Bloomingdale's IF6809 (PO 6049324, 4 cartons, shipped 2026-06-01, 810
// invoiced and delivered, no 856 ever created) — 60 days old on the day it was
// found, i.e. it would have aged out the following day. A window that only just
// contains the thing it caught is set too tight. The run costs seconds, so the
// only reason to bound it at all is keeping 2023-era junk off a live panel.
export const ASN_CHECK_WINDOW_DAYS = 120

// Never run at all → always due. That distinction matters here: this repo has
// twice shipped a module with no caller, which looks exactly like a working
// feature ([[netsuite-sync-wiring]]).
export function asnCheckDue(lastRanAt, now = new Date(), minHours = ASN_CHECK_MIN_HOURS) {
  if (!lastRanAt) return true
  const ageHours = ((now instanceof Date ? now : new Date(now)).getTime() - new Date(lastRanAt).getTime()) / 3.6e6
  return !(ageHours >= 0) || ageHours >= minHours
}

// One line for a badge. Always shows both numbers so a clean result still proves
// it was checked, rather than silently showing nothing.
export function asnSummary(result) {
  if (!result || result.status === 'empty') return ''
  const { packed, declared, undeclared, phantom } = result.counts
  const base = `${declared}/${packed} cartons announced`
  if (result.status === 'no_asn') return `${packed} cartons — no ASN yet`
  if (undeclared) return `${base} — ${undeclared} unannounced`
  if (phantom) return `${base} — ${phantom} announced but not packed`
  return base
}
