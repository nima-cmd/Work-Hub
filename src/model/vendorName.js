// src/model/vendorName.js — the short name for a factory, for a narrow column.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ "Guangzhou Fantasy Leather Factory (Chelly)" is 42 characters and appears   │
// │ on most rows of the season board, pushing everything else off the screen.   │
// │ Nima calls her Chelly; the other factory makes shoes. So the column shows   │
// │ the short name and the full one is on hover.                                │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ⚠️ A LOOKUP, NOT A TRUNCATION. Cutting the string at 12 characters would give
// "Guangzhou Fa" and "Hong Kong Mi" — unreadable, and identical for two Guangzhou
// vendors if a second is ever added. These are names a person chose.
//
// ⚠️ AND AN UNKNOWN VENDOR KEEPS ITS FULL NAME. A factory that is not on this list is
// not abbreviated to something invented — it reads long, which is a visible prompt to
// add it here rather than a silent mislabel. See [[po-vendor-and-shipto]]: the vendor
// is also how we know what a PO contains, so getting one wrong is not cosmetic.
const SHORT = [
  [/guangzhou fantasy leather|chelly/i, 'Chelly'],
  [/hong kong milestone/i, 'Shoe factory'],
]

/** The short name, or the full one when we have not been told a short one. */
export function vendorShort(vendor) {
  const full = String(vendor || '').trim()
  if (!full) return { short: null, full: null, abbreviated: false }
  for (const [re, short] of SHORT) {
    if (re.test(full)) return { short, full, abbreviated: true }
  }
  return { short: full, full, abbreviated: false }
}
