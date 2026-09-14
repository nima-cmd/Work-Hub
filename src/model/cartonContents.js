// src/model/cartonContents.js — what is IN a carton, which is the one thing the
// carton label and the packing slip could not say.
//
// ⚠️ THE BLOCKER, MEASURED. Both documents need `style` per carton (§8.5 / §9 lists it
// among the markings required on EVERY carton, and labelProblems() refuses to print
// without it). `edi_carton` holds carton number, units, weight, SSCC and box size —
// and nothing about contents. On PO 8928906 that meant 22 of 22 cartons unprintable,
// each missing exactly one field.
//
// NetSuite has it, on the carton record itself, in a field we never ingested:
// `custrecord_pkg_upc_or_mixed`. Sampled across 3,761 carton records it holds four
// different shapes, and they are not interchangeable:
//
//   2,459  NULL            nobody recorded what went in
//     779  "Mixed SKUs"    more than one style in the box
//     506  a plain UPC     840470893555
//      17  an itemid       SN82014BD-ATLANTIC
//
// ⚠️ SO THE FIELD'S NAME UNDERSTATES IT. "upc_or_mixed" suggests two cases; there are
// four, and two of them are "we cannot label this carton". Treating null as blank or
// "Mixed SKUs" as a style would print exactly the confident-wrong label that §12
// prices at $250 a carton and §9.1 audits against the physical units.

/** A UPC as NetSuite stores it — 12 to 14 digits, no separators. */
export const isUpc = (v) => /^\d{12,14}$/.test(String(v ?? '').trim())

/** An itemid like SN82014BD-ATLANTIC — a style, already. */
export const isItemId = (v) => /^[A-Z]{2}\d{4,6}[A-Z]{0,3}-[A-Z0-9 ]+$/i.test(String(v ?? '').trim())

export const MIXED = /^mixed/i

/**
 * Resolve each carton's contents to the `style` the documents need.
 *
 * @param cartons  [{ carton, units, sscc, contents }] — `contents` is the raw
 *                 custrecord_pkg_upc_or_mixed value, whatever shape it is in.
 * @param items    [{ upc, itemid, displayname }] from NetSuite, for the UPCs present.
 *
 * ⚠️ IT RETURNS PROBLEMS RATHER THAN PLACEHOLDERS, the same rule labelProblems()
 * follows: a label that prints "STYLE: —" is a fee that looks like a formatting choice.
 */
export function resolveCartonContents(cartons = [], items = []) {
  const byUpc = new Map(items.map((i) => [String(i.upc), i]))
  const byItemId = new Map(items.map((i) => [String(i.itemid).toUpperCase(), i]))
  const styleOf = (i) => (i.displayname ? `${i.itemid} | ${i.displayname}` : i.itemid)

  const resolved = []
  const problems = []

  for (const c of cartons) {
    const raw = c.contents == null ? '' : String(c.contents).trim()
    const at = `carton ${c.carton}`

    if (!raw) {
      problems.push({ carton: c.carton, kind: 'unrecorded', why: `${at}: NetSuite has no contents on the package record — nobody recorded what went in` })
      resolved.push({ ...c, style: null, upc: null }); continue
    }
    if (MIXED.test(raw)) {
      // ⚠️ A REAL CASE, NOT A DATA FAULT — 779 of 3,761 cartons. Exemplar requires
      // "style, colour, size details" on every carton (§8.5) and our extraction does
      // not say what they want when a carton holds several. That is a question for
      // Exemplar, not something to answer with the word "MIXED" on a label.
      problems.push({ carton: c.carton, kind: 'mixed', why: `${at}: holds mixed SKUs — §8.5 wants style/colour/size on every carton and the guide does not say how to mark a mixed one` })
      resolved.push({ ...c, style: null, upc: null, mixed: true }); continue
    }
    if (isUpc(raw)) {
      const item = byUpc.get(raw)
      if (!item) {
        problems.push({ carton: c.carton, kind: 'unknown-upc', why: `${at}: UPC ${raw} is not an item in NetSuite` })
        resolved.push({ ...c, style: null, upc: raw }); continue
      }
      resolved.push({ ...c, style: styleOf(item), upc: raw }); continue
    }
    if (isItemId(raw)) {
      // Already a style. Its UPC is still wanted by the packing slip, so look it up —
      // and a style we cannot price to a UPC is reported rather than left blank.
      const item = byItemId.get(raw.toUpperCase())
      if (!item) {
        problems.push({ carton: c.carton, kind: 'unknown-item', why: `${at}: "${raw}" is not an item in NetSuite` })
        resolved.push({ ...c, style: null, upc: null }); continue
      }
      resolved.push({ ...c, style: styleOf(item), upc: item.upc ?? null }); continue
    }
    problems.push({ carton: c.carton, kind: 'unrecognised', why: `${at}: contents read "${raw}", which is neither a UPC, an item id, nor "Mixed SKUs"` })
    resolved.push({ ...c, style: null, upc: null })
  }

  return {
    cartons: resolved,
    problems,
    // ⚠️ ALL OR NOTHING PER SHIPMENT. Printing 20 of 22 labels leaves two cartons
    // going out unlabelled, which is the same fee as labelling them wrong and much
    // easier to miss on a pallet.
    printable: problems.length === 0 && resolved.length > 0,
  }
}

/** The UPCs and item ids to ask NetSuite about, for a set of carton rows. */
export function lookupKeys(cartons = []) {
  const upcs = new Set()
  const itemIds = new Set()
  for (const c of cartons) {
    const raw = c?.contents == null ? '' : String(c.contents).trim()
    if (!raw || MIXED.test(raw)) continue
    if (isUpc(raw)) upcs.add(raw)
    else if (isItemId(raw)) itemIds.add(raw)
  }
  return { upcs: [...upcs], itemIds: [...itemIds] }
}
