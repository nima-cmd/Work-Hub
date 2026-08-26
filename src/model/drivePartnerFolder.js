// src/model/drivePartnerFolder.js — which Drive folder holds a partner's paperwork.
//
// Drive is organised /Work-Hub Shipping Documents/BOLs/<partner>/<po>/, and the
// <partner> segment is written from routing_shipment.partner. For a PO that joins to
// no routing shipment and no order — 184 of 235 calendar candidates, 2026-08-25 — the
// only name available is edi_transactions.trading_partner, which is ORDERFUL's label
// for the counterparty and is NOT the folder name:
//
//     trading_partner                      folder
//     Bloomingdale's                    →  Bloomingdale's      (identical)
//     Nordstrom (US) (Direct to Store)  →  Nordstrom           (qualified label)
//     Nordstrom (US) (for 856 only)     →  Nordstrom
//     Shopbop (BOP LLC)                 →  — none exists
//     Neiman Marcus Group (NMG)         →  — none exists
//     Saks Fifth Avenue & Saks OFF 5th  →  — none exists
//
// ⚠️ MATCHED AGAINST THE FOLDERS THAT ACTUALLY EXIST, never against a hardcoded list.
// Enumerating Drive turned this from a guess into an observation — and the guess was
// the dangerous version, because listFiledDocuments() walks the path by exact name and
// a wrong segment yields ZERO FILES INDISTINGUISHABLE FROM "nothing was ever filed".
// That silent-zero is why this is derived from the real directory or not at all.
//
// ⚠️ AND NO MATCH IS A REAL ANSWER, not a failure. Only two partner folders exist, so
// a ShopBop PO has no filed paperwork anywhere — saying so is correct, and inventing a
// folder name to search would manufacture a false "none filed" for a partner whose
// documents might later be filed under a name we never checked.

/** Normalise for comparison: case, punctuation and the trailing qualifiers Orderful adds. */
const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/\(.*?\)/g, ' ')      // "(US)", "(for 856 only)", "(BOP LLC)"
  // ⚠️ Apostrophes are DELETED, not turned into a separator. Mapping them to a space
  // makes "Bloomingdale's" normalise to "bloomingdale s" and "Bloomingdales" to
  // "bloomingdales" — two spellings of one partner that no longer compare equal. The
  // comment here claimed apostrophes were handled while the code split on them.
  .replace(/['\u2019\u02BC`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

/**
 * @param name    a partner label — routing_shipment.partner or trading_partner
 * @param folders the folder names that ACTUALLY exist under BOLs/
 * @returns the matching folder name, or null when nothing was ever filed for it
 */
export function resolveDriveFolder(name, folders = []) {
  const n = norm(name)
  if (!n || !folders.length) return null

  // 1. The same partner, however it was punctuated.
  const exact = folders.find((f) => norm(f) === n)
  if (exact) return exact

  // 2. A qualified label for a partner we do file under: "nordstrom us direct to
  //    store" begins with "nordstrom". ⚠️ Anchored at the START and on a WORD
  //    BOUNDARY — a bare `includes` would match any folder whose name appears
  //    anywhere in the label, and a prefix without the boundary would match
  //    "Nordstrom" against a hypothetical "Nord" folder.
  const byPrefix = folders
    .filter((f) => { const g = norm(f); return g && (n === g || n.startsWith(g + ' ')) })
    // Longest wins, so "Saks Fifth Avenue" beats "Saks" if both ever exist.
    .sort((a, b) => norm(b).length - norm(a).length)
  return byPrefix[0] || null
}

/** True when we know where to look. Distinguishes "searched, found none" from "never looked". */
export const canCheckDrive = (name, folders = []) => resolveDriveFolder(name, folders) !== null
