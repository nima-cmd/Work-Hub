// src/model/containerIdentity.js — what a container is CALLED, and why it matters.
//
// ⚠️ THIS IS THE ONE RULE THE WHOLE IMPORT HANGS OFF. The label is the identity of
// the stored slip (db/schema.sql: packing_slip.container_label) and it is embedded in
// every External ID NetSuite will hold. Get it wrong and the files import perfectly
// and are still wrong: docs/packing-slip-to-netsuite.md pairs a receipt with its
// transfer by RECOMPUTING this key, so a mislabelled container reads as "no
// generated pair found" forever after.
//
// ⚠️ AND IT LIVES IN src/model BECAUSE IT MUST BE TESTABLE WITHOUT A DATABASE. Its
// first home was server/packingSlipImport.js, which imports the connection pool at
// module scope — so `npm test` (deliberately DB-free) could not load it at all.

/**
 * "2026.9.7" → "2026.9.7", "2026-09-07" → "2026.9.7".
 *
 * ⚠️ Leading zeros are STRIPPED. The live records read `321 carton 2026.7.10`, never
 * `2026.07.10`, so a padded date would mint a second near-identical External ID for
 * the same container.
 */
export const toNsDateLabel = (raw) => {
  const p = String(raw ?? '').trim().split(/[.\-/]/)
  if (p.length < 3) return ''
  const [y, m, d] = p
  const mi = parseInt(m, 10)
  const di = parseInt(d, 10)
  if (!y || Number.isNaN(mi) || Number.isNaN(di)) return ''
  return `${y}.${mi}.${di}`
}

/**
 * The container's NetSuite label.
 *
 * ⚠️ THE " carton <date>" SUFFIX IS NOT DECORATION, and the port shipped without it.
 * Every generated container already in NetSuite carries it — `EXT-IR-321 carton
 * 2026.7.101706`, `EXT-16 carton 2026.7.91721`, 134 of the 143 external ids on
 * receipts and transfers. Caught by diffing this pipeline against the
 * Naghedi-Warehouse original: they agreed on every quantity and disagreed on every id.
 *
 * ⚠️ AND `containerNum` IS THE BARE NUMBER — "55", "11 air", "321" — never the
 * filename stem. "55 Container 2026.9.7" yields "55 Container 2026.9.7 carton
 * 2026.9.7": the same date twice.
 */
export function containerLabel(container) {
  const num = String(container?.containerNum ?? '')
  const date = toNsDateLabel(container?.containerDate)
  return date ? `${num} carton ${date}` : `${num} carton`
}

/**
 * Guess the container number and date from a filename.
 *
 * ⚠️ A GUESS, OFFERED FOR EDITING — never applied silently. The import screen shows
 * both fields and the label they compose, because a filename someone typed is not
 * good enough to decide an identity this load-bearing on its own.
 */
export function suggestContainerFields(filename = '') {
  const stem = String(filename).replace(/\.(xlsx|xls|csv)$/i, '')
  const dm = stem.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
  const containerDate = dm ? toNsDateLabel(dm[0]) : null
  let num = dm ? stem.replace(dm[0], '') : stem
  // "55-container-", "11-air-" → "55", "11 air". The word "container" is noise: every
  // one of these is a container, and the live labels read "321", "16", "1 air".
  num = num.replace(/[-_]+/g, ' ').replace(/\bcontainers?\b/gi, '').replace(/\s+/g, ' ').trim()
  // ⚠️ NO TITLE-CASING. I had this upper-casing each word, which turned "11-air-…"
  // into "11 Air" — a convention I invented, against a live record that reads
  // "1 air carton 2026.8.8". Tidying a guess makes it harder to notice it is one.
  return { containerNum: num, containerDate }
}
