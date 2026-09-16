// src/model/poSeason.js — which season is this PO for, and why does the stock exist?
//
// Nima, 2026-09-16: *"we need to match by season and items should have season. PO don't
// have season but we should be able to infer them based off the items and then we can
// confirm it on the PO level. so if we can suggest what the season's for the PO is based
// off the items but have something in the app we need to confirm it help. since the
// transfer order has the correlated PO attached it should know what season and purpose
// its for too correct?"*
//
// Yes — and the chain is: item season (OBSERVED) → PO season (SUGGESTED) → a person
// CONFIRMS → the transfer order inherits it through `container_transfer.po_number` →
// the container shows a breakdown. Every link is already in place except the middle one.
//
// ── ⚠️ ITEMS REALLY DO CARRY A SEASON: `custitem_season_year` ────────────────────
//
// 4,152 of 4,280 inventory items have it (97%). Values are "Spring 2026", "Holiday
// 2026", "Resort 2026" — FIVE seasons a year, not four.
//
// ── ⚠️ AND THE INFERENCE IS OFTEN AMBIGUOUS, WHICH IS THE WHOLE REASON TO CONFIRM ──
//
// Measured on the nine POs across our three live containers (2026-09-16):
//
//   PO1785   Holiday 2026 = 1330                                unambiguous
//   PO1722   Fall 2026 = 765 · Holiday 2026 = 75                 a clear majority
//   PO1747   Resort 2026 = 350 · Holiday 2026 = 350              ⚠️ AN EXACT TIE
//   PO1758   Core = 1290 · Spring 2026 = 115 · Fall 2025 = 110   mostly evergreen
//   PO1761   (no season on any item) = 720                       nothing to go on
//   PO1754   Spring 2027 = 370 · Core = 150 · Spring 2025 = 75   three ways
//
// A function that always returns a season would have answered "Resort" or "Holiday" for
// PO1747 by whichever happened to sort first. That is 350 units of freight filed against
// the wrong launch, from a coin flip nobody saw. So a tie is REFUSED and named.
//
// ── ⚠️ "Core" IS NOT A SEASON, AND IT IS THE RESTOCK SIGNAL ──────────────────────
//
// 182 items carry `Core`: evergreen stock that belongs to no drop. Nima's three reasons
// for inbound stock are restock · launch · re-order, and a PO that is mostly Core is
// almost by definition a restock — the app can suggest that too, and must still let a
// person say otherwise.
//
// ── ⚠️ ONE ITEM'S SEASON IS THE TEXT "ERROR: Field 'custitem_season' Not Found" ───
//
// A broken formula's output, persisted as data. `Internal` is in there too. Neither is a
// season, and a value that merely LOOKS like a string is not evidence — so the parser
// has an explicit reject list rather than trusting whatever the field holds.

/** The five seasons a year, in the order they ship. */
export const SEASONS = ['Spring', 'Summer', 'Fall', 'Holiday', 'Resort']

/** Evergreen stock that belongs to no drop. NOT a season. */
export const EVERGREEN = 'Core'

/**
 * ⚠️ VALUES THAT ARE NOT SEASONS, listed rather than pattern-matched. `Internal` is a
 * placeholder and the ERROR string is a broken formula's output that got saved. Both
 * would otherwise parse as an unrecognised "season" and be offered as a suggestion.
 */
export const NOT_SEASONS = new Set(['Internal', "ERROR: Field 'custitem_season' Not Found"])

/** Why stock is coming in. Nima, 2026-09-16: "restock launch re-order". */
export const REASONS = {
  restock: { key: 'restock', label: 'Restock', detail: 'we are low on the site' },
  launch: { key: 'launch', label: 'Launch', detail: 'for an upcoming drop' },
  reorder: { key: 'reorder', label: 'Re-order', detail: 'against a real order — link the OC or SO' },
}

/**
 * Parse `custitem_season_year` into its parts.
 *
 * "Spring 2026"                    → { kind: 'season', season: 'Spring', year: 2026 }
 * "Core"                           → { kind: 'evergreen' }
 * "Bloomingdale's Exclusive 2024"  → { kind: 'program', program: "Bloomingdale's Exclusive", year: 2024 }
 * "Internal" / the ERROR string    → null
 *
 * ⚠️ A PROGRAM IS NOT FOLDED INTO A SEASON. Exclusives and Waste Not carry a year and
 * behave like a season for planning, but they are not one of the five drops — calling a
 * "Shopbop Exclusive 2023" item Spring would attach it to a launch it has nothing to do
 * with.
 */
export function parseSeason(raw) {
  const s = String(raw ?? '').trim()
  if (!s || NOT_SEASONS.has(s)) return null
  if (s === EVERGREEN) return { kind: 'evergreen', label: EVERGREEN }
  const m = s.match(/^(.+?)\s+(\d{4})$/)
  if (!m) return null
  const [, name, year] = m
  const clean = name.trim()
  if (SEASONS.includes(clean)) {
    return { kind: 'season', season: clean, year: Number(year), label: `${clean} ${year}` }
  }
  // ⚠️ "Curated Shop 2025 2025" is real — the year is duplicated in the stored value.
  // Trimming a trailing repeat keeps it one program rather than two.
  const program = clean.replace(new RegExp(`\\s+${year}$`), '')
  return { kind: 'program', program, year: Number(year), label: `${program} ${year}` }
}

/**
 * Suggest a PO's season from the item mix on it.
 *
 * @param lines [{ season, units }] — one row per distinct `custitem_season_year`
 *
 * ⚠️ IT RETURNS A SUGGESTION, NEVER A DECISION, and it refuses to break a tie. The
 * `confident` flag is what a UI should gate "accept" on; `why` is always populated so a
 * person can see what it counted.
 */
export function suggestPoSeason(lines = []) {
  const parsed = []
  let unknownUnits = 0
  for (const l of lines) {
    const units = Number(l.units) || 0
    const p = parseSeason(l.season)
    if (!p) { unknownUnits += units; continue }
    parsed.push({ ...p, units })
  }
  const total = parsed.reduce((a, p) => a + p.units, 0) + unknownUnits
  if (!parsed.length) {
    return {
      suggestion: null, confident: false, total, unknownUnits, mix: [],
      // ⚠️ PO1761 is 720 units with no season on a single item. "Nothing to go on" is a
      // real answer and must not read as "no stock".
      why: unknownUnits
        ? `${unknownUnits} units and not one item carries a season — nothing to infer from`
        : 'no item lines to infer from',
    }
  }

  // Group by label so "Spring 2026" across many items is one candidate.
  const byLabel = new Map()
  for (const p of parsed) {
    const e = byLabel.get(p.label) || { ...p, units: 0 }
    e.units += p.units
    byLabel.set(p.label, e)
  }
  const mix = [...byLabel.values()].sort((a, b) => b.units - a.units)
  const top = mix[0]
  const runnerUp = mix[1] || null

  // ⚠️ AN EXACT TIE IS REFUSED, NOT SORTED. PO1747 is Resort 2026 = 350 and Holiday
  // 2026 = 350; whichever sorted first would have decided 350 units of freight.
  const tied = runnerUp && runnerUp.units === top.units
  if (tied) {
    const names = mix.filter((m) => m.units === top.units).map((m) => m.label)
    return {
      suggestion: null, confident: false, total, unknownUnits, mix,
      why: `${names.join(' and ')} are tied at ${top.units} units each — this one needs a person`,
    }
  }

  // ⚠️ MOSTLY EVERGREEN IS A REASON, NOT A SEASON. A PO that is 1,290 Core units and a
  // scatter of old seasons is a restock; suggesting "Spring 2026" off its 115-unit tail
  // would file a restock against a launch.
  if (top.kind === 'evergreen') {
    return {
      suggestion: { kind: 'evergreen', label: EVERGREEN }, confident: true,
      reason: REASONS.restock.key, total, unknownUnits, mix,
      why: `${top.units} of ${total} units are Core — evergreen stock, so this reads as a restock rather than a drop`,
    }
  }

  const share = total ? Math.round((top.units / total) * 100) : 0
  return {
    suggestion: top,
    // ⚠️ NO REASON IS SUGGESTED FROM A SEASON, and removing this was a correction.
    // It used to return `launch` whenever the top season parsed — which is a DEFAULT
    // dressed as an inference. Nima, 2026-09-16: "in the case of the 11 air we're
    // restocking a launch item that sold well." A PO full of Fall 2026 stock can be the
    // Fall launch OR a restock of Fall goods that sold through, and the item mix cannot
    // tell them apart. What CAN tell them apart is the calendar — see
    // seasonDrops.suggestReason, which reads whether the drop has already happened.
    // ⚠️ A BARE PLURALITY IS NOT CONFIDENCE. A majority of the units, or nothing — the
    // difference between "most of this PO is Holiday" and "Holiday is the biggest of
    // four scattered seasons" is exactly what a person is being asked to settle.
    confident: top.units * 2 > total,
    total, unknownUnits, mix, share,
    why: `${top.units} of ${total} units are ${top.label} (${share}%)`
      + (runnerUp ? `, next is ${runnerUp.label} at ${runnerUp.units}` : '')
      + (unknownUnits ? `; ${unknownUnits} units carry no season` : ''),
  }
}

/**
 * What a PO's season IS — the confirmed value, or the suggestion, clearly distinguished.
 *
 * ⚠️ CONFIRMED BEATS SUGGESTED, and this is the ordinary direction of the rule (unlike
 * transferPurpose.js, where the destination is an observed fact rather than a guess).
 * Here the inference genuinely is a guess about intent, so a person's answer wins and
 * the suggestion is kept only to show what was overridden.
 */
export function seasonFor(po = {}, { drops = [], today = new Date(), hasOrderLink = false, suggestReason } = {}) {
  const suggested = suggestPoSeason(po.lines || [])
  // ⚠️ THE REASON IS SUGGESTED BY THE CALENDAR, NOT BY THE ITEM MIX — injected rather
  // than imported so this module keeps no dependency on seasonDrops.js (which imports
  // SEASONS from here; importing back would be a cycle).
  const reasonHint = suggestReason && (suggested.suggestion || suggested.reason)
    ? suggestReason({
      seasonLabel: suggested.suggestion?.kind === 'evergreen' ? null : suggested.suggestion?.label,
      drop: po.drop ?? null,
      evergreen: suggested.suggestion?.kind === 'evergreen',
      hasOrderLink, drops, today,
    })
    : null
  if (po.season || (po.seasons || []).length) {
    // ⚠️ EVERY CONFIRMED SEASON IS CARRIED, and `label` is only the one that leads.
    // 46% of POs span more than one season; reporting a single label loses the rest.
    const all = (po.seasons || []).length ? po.seasons : (po.season ? [po.season] : [])
    const lead = po.season || all[0] || null
    return {
      state: 'confirmed',
      label: lead,
      seasons: all,
      // ⚠️ The units behind each confirmed season, so the card can show "Fall 2025
      // 175 · Fall 2026 140" rather than asking anyone to trust a bare list.
      units: Object.fromEntries(all.map((x) => [x, (suggested.mix || []).find((m) => m.label === x)?.units ?? null])),
      drop: po.drop ?? null,
      reason: po.reason ?? null,
      by: po.seasonBy || null,
      suggestion: suggested.suggestion?.label || null,
      reasonHint,
      // ⚠️ Named when a person chose something the items do not support — not blocked.
      // They may know a thing the catalogue does not; the disagreement is the signal.
      // ⚠️ A DISAGREEMENT IS ONLY A DISAGREEMENT IF THE SUGGESTION IS NOWHERE IN THE
      // CONFIRMED SET. Confirming "Fall 2025 AND Fall 2026" on a PO the items call
      // Fall 2025 is agreement plus detail, not a conflict — flagging it would train
      // somebody to ignore the warning.
      differs: suggested.suggestion && !all.includes(suggested.suggestion.label)
        ? `the items on this PO are mostly ${suggested.suggestion.label}`
        : null,
      why: suggested.why,
    }
  }
  return {
    state: suggested.suggestion ? 'suggested' : 'unknown',
    label: suggested.suggestion?.label || null,
    // ⚠️ THE WHOLE MIX IS OFFERED, not just the winner — so "confirm all of these" is
    // one click on the 46% of POs that span several.
    seasons: (suggested.mix || []).map((m) => m.label),
    units: Object.fromEntries((suggested.mix || []).map((m) => [m.label, m.units])),
    drop: null,
    // ⚠️ THE SUGGESTED REASON COMES FROM THE CALENDAR AND CARRIES ITS OWN CONFIDENCE.
    // Stock arriving AFTER its drop reads as a restock but is not confident — it can
    // equally be a launch that slipped, and that is the difference between "we sold out"
    // and "we missed the date".
    reason: reasonHint?.reason || null,
    reasonWhy: reasonHint?.why || null,
    reasonConfident: reasonHint?.confident ?? false,
    confident: suggested.confident,
    mix: suggested.mix,
    why: suggested.why,
  }
}
