// src/model/palletLabel.js — the pallet placard (§12.6, p37).
//
// Nima, 2026-09-14, palletising PO 8928906: "can you build the pallet label".
//
// ⚠️ THE FIFTH REQUIRED DOCUMENT WITH NO GENERATOR. `PALLET.label` has listed its five
// fields since the standards were extracted, `shipmentChecklist` has had a "Label every
// pallet" step with a $250 price on it, and nothing produced one — the same shape as
// the manifest this morning. Fee code 175 (SFA and NMG alike), §12.6, $10 per carton
// with a $250 minimum, so one unlabelled pallet of 22 cartons costs $250.
//
// ⚠️ IT IS NOT THE CARTON LABEL. No SSCC, no barcode. A pallet is not a logistics unit
// with its own GS1 identity here — the cartons carry the SSCCs — and putting a
// barcode on the placard would give a receiver a second thing that looks scannable.
//
// ⚠️ AND THE GUIDE SPECIFIES CONTENT, NOT PLACEMENT OR COUNT. It says label every
// pallet and lists what goes on the label. It does not say how many faces, or which.
// So the count is the caller's, defaulting to one, and the sheet says the guide is
// silent rather than implying two-adjacent-sides is a rule we read somewhere.

import { PALLET } from './exemplarStandards.js'

export const REQUIRED = [
  ['operatingCompany', 'Exemplar operating company name/address'],
  ['po', 'PO number'],
  ['department', 'Department number'],
  ['store', 'Store number and abbreviation'],
  ['cartons', 'Number of cartons on the pallet'],
]

export const PLACEMENT_UNSPECIFIED =
  'The Manual lists what the placard must say (§12.6, p37) and does not say how many faces of the pallet to put it on.'

/**
 * Build one pallet's placard, or say what is missing.
 *
 * ⚠️ IT RETURNS PROBLEMS, NEVER PLACEHOLDERS — the same rule as labelProblems(). A
 * placard reading "DEPT: —" is a $250 fee that looks like a formatting choice.
 */
export function palletLabel(input = {}) {
  const l = {
    operatingCompany: input.operatingCompany ?? null,
    po: input.po ?? null,
    department: input.department ?? null,
    store: input.store ?? null,
    storeAbbrev: input.storeAbbrev ?? null,
    dc: input.dc ?? null,
    dcName: input.dcName ?? null,
    cartons: Number(input.cartons) || 0,
    pallet: Number(input.pallet) || 1,
    ofPallets: Number(input.ofPallets) || 1,
    // ⚠️ MULTIPLE POs GET A PLACARD LINE PER PO, not a lumped total. PALLET's own
    // `multiPoPlacard` is "PO number - carton count", which is only meaningful per PO —
    // a pallet placard saying "3 POs, 22 cartons" tells a receiver nothing about which
    // carton belongs to which order.
    poBreakdown: Array.isArray(input.poBreakdown) ? input.poBreakdown : null,
  }

  const missing = REQUIRED.filter(([k]) => {
    const v = k === 'cartons' ? (l.cartons > 0 ? l.cartons : null) : l[k]
    return v === null || v === undefined || String(v).trim() === ''
  }).map(([k, label]) => ({ field: k, requirement: label }))

  const errors = []
  if (l.pallet > l.ofPallets) errors.push(`pallet ${l.pallet} of ${l.ofPallets} — the number exceeds the total`)
  if (l.poBreakdown) {
    const sum = l.poBreakdown.reduce((a, p) => a + (Number(p.cartons) || 0), 0)
    if (sum !== l.cartons) {
      errors.push(`the per-PO carton counts total ${sum} but the pallet says ${l.cartons}`)
    }
  }

  return {
    ...l,
    // The placard line the Manual names, per PO, when there is more than one.
    placards: l.poBreakdown ? l.poBreakdown.map((p) => `${p.po} - ${p.cartons}`) : null,
    fields: PALLET.label,
    section: '12.6',
    page: PALLET.page,
    missing,
    errors,
    printable: missing.length === 0 && errors.length === 0,
  }
}

/**
 * Split a shipment's cartons across pallets.
 *
 * ⚠️ IT REFUSES TO GUESS THE SPLIT. Nothing in our data says which carton went on which
 * pallet — that is a physical fact from the floor. With one pallet there is nothing to
 * decide; with more, the caller has to say, because a placard with the wrong carton
 * count is exactly the thing §12.6 charges for.
 */
export function palletPlan({ cartons = 0, pallets = 1, perPallet = null, ...rest } = {}) {
  const total = Number(cartons) || 0
  const n = Math.max(1, Number(pallets) || 1)
  if (n === 1) return { ok: true, labels: [palletLabel({ ...rest, cartons: total, pallet: 1, ofPallets: 1 })] }
  if (!Array.isArray(perPallet) || perPallet.length !== n) {
    return { ok: false, why: `${n} pallets, and nothing in our data says how the ${total} cartons are split across them — give the count per pallet` }
  }
  const sum = perPallet.reduce((a, c) => a + (Number(c) || 0), 0)
  if (sum !== total) return { ok: false, why: `the per-pallet counts total ${sum}, the shipment has ${total} cartons` }
  return {
    ok: true,
    labels: perPallet.map((c, i) => palletLabel({ ...rest, cartons: c, pallet: i + 1, ofPallets: n })),
  }
}
