// src/model/upcBarcode.js — a UPC-A barcode, as bar widths.
//
// Nima is making his own hang tags (2026-08-28: "now that we are gonna make UPC labels").
// The existing label pipeline draws PDFs with pdfkit and already renders a QR code
// (server/printLabel.js drawQr), but nothing in this repo has ever drawn a LINEAR
// barcode — there is no ^BU/^BE/^BC anywhere, and qrcode-generator is 2D only. So the
// symbology is implemented here, pure and tested.
//
// ⚠️ WHY THIS IS A TESTED MODULE AND NOT A HELPER IN THE PDF BUILDER. A barcode that
// does not scan is an annoyance you notice immediately. A barcode that scans as the
// WRONG NUMBER is a bag that rings up as another bag, and nobody notices until a
// customer is at the till. The encoding is therefore checked digit-by-digit against the
// spec, and against a REAL PRINTED TAG (SN03012LD Bordeaux, 840470897966 — see the test).
//
// ── The structure of a UPC-A symbol ─────────────────────────────────────────
//
//   quiet zone (9 modules) | guard 101 | 6 left digits x 7 | centre 01010 |
//   6 right digits x 7 | guard 101 | quiet zone (9 modules)
//
//   = 3 + 42 + 5 + 42 + 3 = 95 modules of bars and spaces, plus quiet zones.
//
// ⚠️ THE QUIET ZONES ARE PART OF THE SYMBOL, not padding. A scanner needs clear space
// either side to find the guard bars; a barcode butted against a label edge or against
// text is the single most common reason a correctly-encoded tag will not read. They are
// returned in the geometry so a caller cannot forget them.

/** Left-hand (odd parity) patterns, digits 0-9. 1 = bar, 0 = space. */
const L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
]

// ⚠️ DERIVED, NOT TYPED OUT. The right-hand patterns are the bitwise complement of the
// left-hand ones — that is what makes a UPC symbol readable upside down. Writing them
// out by hand would be 70 more digits to get wrong for no gain, and a typo in one of
// them would encode a wrong number that still scans.
const R = L.map((p) => [...p].map((b) => (b === '1' ? '0' : '1')).join(''))

const GUARD = '101'
const CENTRE = '01010'

/** Modules of clear space required either side. Part of the symbol — see the header. */
export const QUIET_MODULES = 9

/** The 95 modules of a UPC-A symbol, excluding quiet zones. */
export const SYMBOL_MODULES = 95

const digitsOf = (v) => String(v ?? '').replace(/[\s-]/g, '')

/**
 * The check digit for the first 11 digits of a UPC-A.
 *
 * Odd positions (1st, 3rd, … 11th) are tripled, even positions added, and the check
 * digit is what takes the total to a multiple of ten.
 *
 * ⚠️ POSITIONS ARE 1-BASED IN THE SPEC and 0-based in the array, which is exactly the
 * off-by-one that silently produces a plausible wrong digit. Verified against the
 * printed tag in the test rather than against my own reading of the rule.
 */
export function upcCheckDigit(first11) {
  const d = digitsOf(first11)
  if (!/^\d{11}$/.test(d)) return null
  let sum = 0
  for (let i = 0; i < 11; i++) {
    const n = Number(d[i])
    // i=0 is the 1st digit, an ODD position, so it is tripled.
    sum += i % 2 === 0 ? n * 3 : n
  }
  return (10 - (sum % 10)) % 10
}

/**
 * Why this is not a valid UPC-A, or null when it is.
 *
 * ⚠️ A REASON, NEVER A BARE FALSE — the never-lump rule. "Not 12 digits" and "the check
 * digit disagrees" are different problems: the first is a data-entry slip, the second
 * means the number in our catalogue does not describe the item it claims to.
 */
export function upcError(upc) {
  const d = digitsOf(upc)
  if (!d) return 'no UPC'
  if (!/^\d+$/.test(d)) return 'a UPC is digits only'
  if (d.length !== 12) return `a UPC-A is 12 digits, this is ${d.length}`
  const want = upcCheckDigit(d.slice(0, 11))
  if (String(want) !== d[11]) {
    return `check digit is ${d[11]} but the first 11 digits require ${want} — this number is not self-consistent`
  }
  return null
}

export const isValidUpc = (upc) => upcError(upc) === null

/**
 * The human-readable line, grouped the way it is printed: number-system digit outside
 * the bars, then two groups of five, then the check digit outside.
 *
 * Verified against the real tag: 840470897966 prints as "8 40470 89796 6".
 */
export function upcHumanReadable(upc) {
  const d = digitsOf(upc)
  if (!/^\d{12}$/.test(d)) return null
  return { lead: d[0], left: d.slice(1, 6), right: d.slice(6, 11), check: d[11] }
}

/**
 * The symbol as a module string: '1' is a bar, '0' is a space, one character per module.
 * Returns null rather than a wrong symbol when the UPC is not valid — nothing should be
 * able to print bars for a number that does not check out.
 */
export function upcModules(upc) {
  if (upcError(upc)) return null
  const d = digitsOf(upc)
  let out = GUARD
  for (let i = 0; i < 6; i++) out += L[Number(d[i])]
  out += CENTRE
  for (let i = 6; i < 12; i++) out += R[Number(d[i])]
  out += GUARD
  return out
}

/**
 * The symbol as drawable bars, in module units.
 *
 * Each bar is {at, width, tall}. `tall` marks the guard and centre bars, which extend
 * BELOW the others so the human-readable digits sit between them — that descender is
 * how a printed UPC gets its shape, and leaving it out makes a symbol that looks wrong
 * to anyone who handles retail tags even though it scans.
 *
 * Units are modules, not points: the caller multiplies by whatever module width the
 * label size allows, so this stays independent of paper.
 */
export function upcBars(upc) {
  const mods = upcModules(upc)
  if (!mods) return null
  // Guard positions within the 95 modules: left 0-2, centre 45-49, right 92-94.
  const isTall = (i) => (i >= 0 && i < 3) || (i >= 45 && i < 50) || (i >= 92 && i < 95)
  const bars = []
  let i = 0
  while (i < mods.length) {
    if (mods[i] === '0') { i++; continue }
    const start = i
    while (i < mods.length && mods[i] === '1' && isTall(i) === isTall(start)) i++
    bars.push({ at: start, width: i - start, tall: isTall(start) })
  }
  return { bars, modules: SYMBOL_MODULES, quiet: QUIET_MODULES, totalModules: SYMBOL_MODULES + QUIET_MODULES * 2 }
}
