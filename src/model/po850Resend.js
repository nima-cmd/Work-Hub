// src/model/po850Resend.js — the same PO sent again, and what it now asks of us.
//
// Nima, 2026-09-17: *"50184318 was in our app unallocated but we just got the allocation
// and it didn't show up in our feed or tell us to look to see if there was an allocation
// as its the same PO sent again."*
//
// ── ⚠️ THE DIFF ALREADY EXISTED AND NOTHING WATCHED IT ──────────────────────────
//
// src/model/edi850Diff.js answers "what changed between these two 850s" correctly — run
// on his PO it reported line items 4 → 22, purpose Original → Duplicate, reworkLikely.
// But it is reachable only through `/api/edi/850-versions?po=…`, which you can only call
// if you ALREADY suspect the PO. Third module in this codebase that works when called by
// hand and was never wired to notice (see the container sync, and PR #16's NetSuite sync).
//
// ⚠️ AND THIS ONE DELIBERATELY DOES NOT READ MESSAGE BODIES. edi850Diff needs both raw
// payloads from Orderful — one HTTP round trip per version, per PO. A watch that has to
// fetch 32 message bodies to decide whether to raise a flag will be switched off. Every
// signal below comes from columns the sync already stores: store_codes,
// store_quantities, total_units, line_count, po_purpose_code. The deep diff stays the
// thing you open AFTER this points at a PO.
//
// ── ⚠️ "DUPLICATE" IS THE CODE THE ALLOCATION ARRIVES UNDER ─────────────────────
//
// His PO came back as BEG02 = 07, "Duplicate" — while going from 1 store to 25. Trusting
// the purpose code would have skipped precisely the transmission that mattered. So the
// code is REPORTED and never used to decide: the store set, the units and the line count
// are what say whether there is work.
//
// ── ⚠️ A STORE COUNT FALLING TO ZERO IS NOT AN ALLOCATION ───────────────────────
//
// Of the 16 POs whose latest 850 changed the store count, three went DOWN to none
// (50073678, 50106212, 40847685). That is not stores to pack — it is more likely a
// cancellation or a partner-side reissue, and calling it "allocation arrived" would send
// someone to enter lines that do not exist. It gets its own kind.

/** What a resend turns out to be. Ordered by how much work it creates. */
export const RESEND_KIND = {
  ALLOCATION: {
    key: 'allocation',
    label: 'allocation arrived',
    work: 'enter the store lines in NetSuite',
  },
  REALLOCATION: {
    key: 'reallocation',
    label: 'allocation changed',
    work: 'the stores moved — check what is already entered against the new split',
  },
  WITHDRAWN: {
    key: 'withdrawn',
    label: 'stores removed',
    work: 'no stores on the latest version — confirm whether this PO is cancelled',
  },
  QUANTITY: {
    key: 'quantity',
    label: 'quantity changed',
    work: 'the units moved — check anything already picked or fulfilled',
  },
  RESEND: {
    key: 'resend',
    label: 'sent again, nothing we track changed',
    work: null,
  },
}

const codes = (v) => [...new Set((v || []).map((s) => String(s).trim()).filter(Boolean))].sort()
const num = (v) => (v == null ? null : Number(v))

/** Per-store units as a comparable map, from the stored `store_quantities` shape. */
export function storeMap(quantities) {
  const out = new Map()
  for (const q of quantities || []) {
    const s = String(q?.store ?? '').trim()
    if (!s) continue
    out.set(s, (out.get(s) || 0) + (Number(q?.units) || 0))
  }
  return out
}

/**
 * Compare the newest version of a PO against the one before it.
 *
 * @param versions stored rows, ANY order, each { id, createdAt, purposeCode, storeCodes,
 *                 storeQuantities, totalUnits, lineCount }
 *
 * ⚠️ RETURNS null FOR A SINGLE VERSION. One 850 is not a resend, and treating it as one
 * would flag every PO the day it arrives.
 */
export function resendFinding(versions = []) {
  const sorted = [...versions].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  if (sorted.length < 2) return null
  const prev = sorted[sorted.length - 2]
  const latest = sorted[sorted.length - 1]

  const before = codes(prev.storeCodes)
  const after = codes(latest.storeCodes)
  const added = after.filter((s) => !before.includes(s))
  const removed = before.filter((s) => !after.includes(s))

  const beforeUnits = num(prev.totalUnits)
  const afterUnits = num(latest.totalUnits)
  const unitsChanged = beforeUnits != null && afterUnits != null && beforeUnits !== afterUnits

  // Per-store movement even when the SET is identical — a re-split of the same stores.
  const pm = storeMap(prev.storeQuantities), lm = storeMap(latest.storeQuantities)
  const moved = [...new Set([...pm.keys(), ...lm.keys()])]
    .filter((s) => (pm.get(s) || 0) !== (lm.get(s) || 0))

  // ⚠️ ORDER MATTERS AND IS THE RULE ITSELF. Withdrawn is tested before allocation
  // because a PO going 1 → 0 stores has `removed` entries and no `added` ones, and
  // reading it as an allocation would send somebody to enter nothing.
  let kind
  if (after.length === 0 && before.length > 0) kind = RESEND_KIND.WITHDRAWN
  else if (before.length <= 1 && after.length > 1) kind = RESEND_KIND.ALLOCATION
  else if (added.length || removed.length) kind = RESEND_KIND.REALLOCATION
  else if (unitsChanged || moved.length) kind = RESEND_KIND.QUANTITY
  else kind = RESEND_KIND.RESEND

  const parts = []
  if (before.length !== after.length) parts.push(`${before.length} store${before.length === 1 ? '' : 's'} → ${after.length}`)
  if (unitsChanged) parts.push(`${beforeUnits} units → ${afterUnits}`)
  else if (afterUnits != null) parts.push(`${afterUnits} units`)
  if (num(prev.lineCount) !== num(latest.lineCount)) parts.push(`${prev.lineCount} lines → ${latest.lineCount}`)
  // ⚠️ THE RE-SPLIT IS ALWAYS MENTIONED WHEN THE STORE SET DID NOT MOVE, and the guard
  // here used to be `!parts.length` — which meant the unchanged-total "20 units" line
  // filled the summary first and the re-split never appeared. That is the one case where
  // nothing else in the summary says anything happened: same stores, same total, units
  // moved between them. Caught by its own test.
  if (moved.length && !added.length && !removed.length) {
    parts.push(`${moved.length} store${moved.length === 1 ? '' : 's'} re-split`)
  }

  return {
    kind: kind.key,
    label: kind.label,
    work: kind.work,
    // ⚠️ The purpose code is REPORTED, never used to decide — his allocation arrived
    // under "Duplicate".
    purpose: { from: prev.purposeCode ?? null, to: latest.purposeCode ?? null },
    versions: sorted.length,
    at: latest.createdAt,
    previousAt: prev.createdAt,
    stores: { before: before.length, after: after.length, added, removed },
    units: { before: beforeUnits, after: afterUnits },
    lines: { before: num(prev.lineCount), after: num(latest.lineCount) },
    resplit: moved,
    summary: parts.join(' · '),
    // The per-store split as it now stands, so whoever enters it does not re-read the 850.
    allocation: [...lm.entries()].map(([store, units]) => ({ store, units })).sort((a, b) => a.store.localeCompare(b.store)),
  }
}

/**
 * Every PO whose latest 850 asks something of us, newest first.
 *
 * @param byPo    Map|object of poNumber → versions[]
 * @param opts.soCountFor  (po) => how many sales orders exist. ⚠️ INJECTED, not looked
 *                 up here: this module stays pure, and the caller already has the orders.
 * @param opts.withinDays  how recent counts as actionable
 *
 * ⚠️ RECENT ONLY, AND THE REST ARE COUNTED NOT LISTED. Nima, 2026-09-17: "flag the
 * recent ones only." Sixteen POs stretch back to last October; raising fourteen
 * historical alarms is how a banner becomes wallpaper and the two live ones get ignored.
 * The older ones are returned as `older` — a number and their PO numbers, no severity.
 */
export const RESEND_WINDOW_DAYS = 30

export function resendFindings(byPo = {}, { soCountFor = null, withinDays = RESEND_WINDOW_DAYS, now = new Date() } = {}) {
  const entries = byPo instanceof Map ? [...byPo.entries()] : Object.entries(byPo)
  const all = []
  for (const [po, versions] of entries) {
    const f = resendFinding(versions)
    if (!f) continue
    // ⚠️ A resend that changed nothing we track is NOT work and is dropped here rather
    // than shown greyed out. Nordstrom retransmits routinely; listing every one trains
    // people to stop reading the list.
    if (f.kind === RESEND_KIND.RESEND.key) continue
    const soCount = soCountFor ? soCountFor(po) : null
    all.push({
      po,
      ...f,
      soCount,
      // ⚠️ "ENTERED?" IS A SEPARATE FACT FROM "CHANGED". A PO with no sales orders needs
      // entry; one that already has them needs CHECKING against the new split, which is
      // different work. Null when the caller did not supply the orders.
      entered: soCount == null ? null : soCount > 0,
      ageDays: Math.floor((new Date(now) - new Date(f.at)) / 86400000),
    })
  }
  all.sort((a, b) => new Date(b.at) - new Date(a.at))
  const recent = all.filter((f) => f.ageDays <= withinDays)
  const older = all.filter((f) => f.ageDays > withinDays)
  return {
    recent,
    // Named and counted, never raised.
    older: { count: older.length, pos: older.map((f) => f.po) },
    windowDays: withinDays,
  }
}

/**
 * One line for a banner, or null when there is nothing to say.
 *
 * ⚠️ IT COUNTS WORK, NOT RESENDS. "3 POs sent again" is a fact nobody can act on;
 * "1 allocation arrived — 25 stores to enter" is the sentence that gets it done.
 */
export function resendBanner(findings = { recent: [] }) {
  const recent = findings.recent || []
  if (!recent.length) return null
  const needEntry = recent.filter((f) => f.kind === RESEND_KIND.ALLOCATION.key && f.entered === false)
  const parts = []
  if (needEntry.length) {
    const stores = needEntry.reduce((a, f) => a + f.stores.after, 0)
    parts.push(`${needEntry.length} allocation${needEntry.length === 1 ? '' : 's'} arrived — ${stores} store line${stores === 1 ? '' : 's'} to enter`)
  }
  const rest = recent.length - needEntry.length
  if (rest) parts.push(`${rest} other PO${rest === 1 ? '' : 's'} resent with changes`)
  return {
    text: parts.join(' · '),
    total: recent.length,
    needEntry: needEntry.length,
    pos: recent.map((f) => f.po),
    severity: needEntry.length ? 'warn' : 'notice',
  }
}
