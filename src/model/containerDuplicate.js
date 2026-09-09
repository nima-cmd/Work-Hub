// src/model/containerDuplicate.js — is this container already here under another name?
//
// Nima, 2026-09-09: "we find it alarming how easily we re-created the same container
// twice."
//
// He is right, and the cause is structural rather than careless. The container's
// identity IS its label (db/schema.sql: packing_slip.container_label), because that
// label is what NetSuite holds inside every generated External ID and it can never be
// renamed afterwards. But a label is assembled from a container number and a date
// that a person types, so:
//
//     11 Air 1820 1777 air list carton            (no date typed)
//     11 Air 1820 1777 air list carton 2026.9.7   (date typed, wrong date)
//     11 air carton 2026.9.9                      (what the slip actually says)
//
// are three containers as far as the database is concerned, and one container as far
// as the world is concerned. Nothing about the label can detect that. So the check
// has to ignore the name entirely and look at the SHIPMENT.
//
// ⚠️ AND THE OBVIOUS SIGNAL IS WRONG. Overlapping POs are NORMAL: PO1820 shipped 30
// units on `11 air` and another 20 on `55 container`, which is a PO split across two
// vessels and is the ordinary case. Flagging PO overlap as a duplicate would fire on
// half of all real containers and be switched off within a week.

/**
 * A shipment's identity, independent of what anyone called it.
 *
 * ⚠️ THE SKU MULTISET IS THE STRONG SIGNAL. Two documents listing the same SKUs in
 * the same quantities against the same POs describe the same physical shipment; the
 * probability of two genuinely different containers matching on that is negligible,
 * and it survives the label, the filename and the date all being wrong.
 */
export function slipFingerprint(container = {}) {
  const lines = (container.skuTotals || [])
    .map((l) => `${String(l.poNumber ?? '').replace(/^PO/i, '')}|${String(l.sku ?? '').toUpperCase()}|${Number(l.units) || 0}`)
    .sort()
  return {
    lineKey: lines.join(';'),
    poKey: [...new Set((container.poNumbers || []).map((p) => String(p).replace(/^PO/i, '')))].sort().join(','),
    unitCount: Number(container.unitCount) || 0,
    // ⚠️ NULL, not 0, on a master packing list — that form cannot carry cartons at
    // all, so a 0 here would make every master list look like a match for every other.
    cartonCount: container.cartonCount == null ? null : Number(container.cartonCount),
  }
}

/**
 * Compare an incoming slip against every container already stored.
 *
 * @param incoming  the parsed container (plus optional `contentHash`)
 * @param stored    rows with { containerLabel, contentHash, lineKey|skuTotals, unitCount, cartonCount, poNumbers }
 * @returns matches, most certain first
 */
export function findDuplicates(incoming, stored = []) {
  const me = slipFingerprint(incoming)
  const myLabel = incoming.containerLabel ?? null
  const out = []

  for (const s of stored) {
    // Re-importing under the SAME label is not a duplicate — it is a re-import, and
    // packingSlipRevision.js already decides whether that is news.
    if (myLabel && s.containerLabel === myLabel) continue
    const theirs = s.lineKey != null ? s : slipFingerprint(s)
    const theirLine = s.lineKey ?? theirs.lineKey

    // ⚠️ THE SAME BYTES UNDER A DIFFERENT NAME IS THE CASE THAT ACTUALLY HAPPENED.
    // Nothing else needs comparing: it is literally the same document, so the only
    // difference is the name someone typed, and one of the two names is wrong.
    if (incoming.contentHash && s.contentHash && incoming.contentHash === s.contentHash) {
      out.push({
        containerLabel: s.containerLabel,
        kind: 'same-file',
        certainty: 'certain',
        reason: 'byte-for-byte the same document, stored under a different container label — one of the two names is wrong',
      })
      continue
    }

    if (theirLine && theirLine === me.lineKey) {
      out.push({
        containerLabel: s.containerLabel,
        kind: 'same-shipment',
        certainty: 'certain',
        reason: `identical PO, SKU and quantity on every line (${me.unitCount} units) — the same shipment under a different label`,
      })
      continue
    }

    // Same POs and the same total, different breakdown: a factory reissue that moved
    // quantities between SKUs, stored under a new name instead of replacing the old.
    if (me.poKey && theirs.poKey === me.poKey && theirs.unitCount === me.unitCount && me.unitCount > 0) {
      out.push({
        containerLabel: s.containerLabel,
        kind: 'possible-reissue',
        certainty: 'likely',
        reason: `same POs and the same ${me.unitCount} units, but a different SKU breakdown — probably a reissued slip stored under a new label`,
      })
      continue
    }

    // ⚠️ WHAT IS DELIBERATELY NOT HERE: PO overlap on its own. PO1820 shipped 30
    // units on `11 air` and 20 on `55 container` — one PO split across two vessels,
    // which is the ordinary case, not a duplicate.
  }

  const rank = { certain: 0, likely: 1 }
  out.sort((a, b) => (rank[a.certainty] ?? 9) - (rank[b.certainty] ?? 9))
  return out
}

/**
 * ⚠️ A DUPLICATE WARNS, IT DOES NOT BLOCK, and that asymmetry is on purpose. A
 * factory genuinely does reissue a slip, and a genuinely new container can share a
 * total with an old one. Refusing the store outright would leave someone with a real
 * document and no way to record it — and the workaround they would find is renaming
 * the container, which is the exact thing that created the mess.
 *
 * What it does instead is require the person to say which case it is, and never
 * default to "new".
 */
export const DUPLICATE_BLOCKS_STORE = false

export function duplicateVerdict(matches = []) {
  if (!matches.length) return { duplicate: false, requiresConfirmation: false, matches: [] }
  const certain = matches.filter((m) => m.certainty === 'certain')
  return {
    duplicate: true,
    requiresConfirmation: true,
    certain: certain.length > 0,
    matches,
    // The heading the screen shows. Deliberately a question, because the app does not
    // know which of the two labels is the right one and must not pretend to.
    headline: certain.length
      ? `This shipment is already stored as "${certain[0].containerLabel}"`
      : `This may already be stored as "${matches[0].containerLabel}"`,
  }
}
