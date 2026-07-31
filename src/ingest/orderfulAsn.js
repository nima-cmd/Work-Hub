// src/ingest/orderfulAsn.js — pull the carton list out of an outbound 856.
//
// Split out of orderful.js for the same reason orderfulDates.js was: the parsing
// is pure and worth testing on its own, while the fetching is not.
//
// An 856 is a hierarchy of HL segments, each tagged with a level code. Confirmed
// against a real delivered Bloomingdale's ASN (Orderful txn 996376235,
// NB1731234) on 2026-07-31 — 85 HL entries: 1 Shipment, 18 Order, 18 Pack,
// 48 Item. So:
//   • 'O' (order) → purchaseOrderReference — which POs this manifest covers.
//     Several per document: one ASN legitimately spans multiple POs.
//   • 'P' (pack)  → marksAndNumbersInformation — the carton's SSCC, qualifier
//     'GM' (EAN.UCC-18 / SSCC-18). This is the join key to NetSuite's carton
//     record. See src/model/asnCartonCheck.js.
//
// ⚠️ The SSCC arrives ZERO-PADDED here (20 chars) and bare (18) from NetSuite —
// always compare through normalizeSscc, never as raw strings.

const levelsOf = (message, code) =>
  (message?.transactionSets?.[0]?.HL_loop || [])
    .filter((h) => h?.hierarchicalLevel?.[0]?.hierarchicalLevelCode === code)

// Qualifier 'GM' is the SSCC-18. Other qualifiers appear in marks-and-numbers
// segments (carrier-assigned marks, for instance) and are deliberately ignored
// rather than guessed at — a wrong join key would invent mismatches.
const GM = 'GM'

export function extractCartonSsccs(message) {
  const ssccs = []
  for (const pack of levelsOf(message, 'P')) {
    for (const mark of pack.marksAndNumbersInformation || []) {
      if (mark?.marksAndNumbersQualifier !== GM) continue
      if (mark?.marksAndNumbers) ssccs.push(String(mark.marksAndNumbers))
    }
  }
  return ssccs
}

export function extractAsnPoNumbers(message) {
  const pos = new Set()
  for (const order of levelsOf(message, 'O')) {
    const po = order?.purchaseOrderReference?.[0]?.purchaseOrderNumber
    if (po) pos.add(String(po))
  }
  return [...pos]
}

// Everything the carton check needs from one 856 body. `packCount` is the number
// of pack-level HL entries, kept alongside the SSCC list so a manifest that
// declares cartons WITHOUT license plates is visible as a gap rather than just
// yielding a short list.
export function extractAsnManifest(message) {
  const packs = levelsOf(message, 'P')
  const ssccs = extractCartonSsccs(message)
  return {
    poNumbers: extractAsnPoNumbers(message),
    ssccs,
    packCount: packs.length,
    packsWithoutSscc: packs.length - ssccs.length,
  }
}
