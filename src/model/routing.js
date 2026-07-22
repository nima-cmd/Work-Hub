// src/model/routing.js — the EDI routing rollup (Nima, 2026-07-22). Replaces
// the NetSuite routing_helper.js Suitelet + Google-Sheet step: takes the
// per-PO-DC package feed (EDIPackagesVolume) and consolidates it into the
// shipments we actually route — ONE per (partner, DC), rolling up every PO
// bound for that DC — with the exact integers the partner portals want.
//
// The two locked rules from the manual process:
//   1. ONE BOL per DC. Multiple POs to the same DC MUST consolidate under one
//      shipment/BOL (that's the whole point of the "Group by DC" checkbox in
//      the old Suitelet).
//   2. Portal numbers are ALWAYS rounded UP to whole numbers — never down,
//      never a decimal. Cubic feet per DC = ceil(sum of the raw cubic feet
//      across the DC's POs): one clean round-up on the total, not a sum of
//      per-row round-ups (which can over-count). We keep the sum-of-rounded
//      too so the view can flag the rare case where they disagree.
//
// The feed is pre-aggregated per PO-DC. A future per-carton feed (with box
// L×W×H, for the UPS-label case) rolls up to the SAME grain — group the
// cartons by poDc first, then hand the same shape here — so this stays the one
// consolidation point regardless of feed granularity.

import { dcLabel, partnerForDc } from './dc.js'

// rows: [{ poNumber, dc, weight, cartons, units, cubicFeetRaw, cubicFeetRounded }]
//   dc          — the DC *code* from "PO Number - DC" (e.g. "CG", "584")
//   cubicFeetRaw — unrounded cubic feet for the PO-DC (summed, then ceil'd)
// returns: [{ partner, dc, dcLabel, memberPos[], poCount, cartons, units,
//             weightLb, cubicFeet, cubicFeetRoundedSum, cubicRoundingDiffers,
//             showUnits, key }]  sorted partner then biggest (cartons) first.
export function consolidateRouting(rows = []) {
  const byDc = new Map()
  for (const r of rows) {
    const dc = String(r.dc || '').trim()
    if (!dc) continue
    const partner = partnerForDc(dc)
    const key = `${partner}|${dc}`
    let g = byDc.get(key)
    if (!g) {
      g = {
        partner, dc, dcLabel: dcLabel(dc), key,
        memberPos: [], cartons: 0, units: 0,
        _weightRaw: 0, _cubicRaw: 0, cubicFeetRoundedSum: 0,
      }
      byDc.set(key, g)
    }
    const po = String(r.poNumber || '').trim()
    if (po && !g.memberPos.includes(po)) g.memberPos.push(po)
    g.cartons += intOf(r.cartons)
    g.units += intOf(r.units)
    g._weightRaw += numOf(r.weight)
    g._cubicRaw += numOf(r.cubicFeetRaw)
    g.cubicFeetRoundedSum += intOf(r.cubicFeetRounded)
  }

  const out = [...byDc.values()].map((g) => {
    const cubicFeet = Math.ceil(round2(g._cubicRaw)) // one clean round-up on the DC total
    return {
      partner: g.partner,
      dc: g.dc,
      dcLabel: g.dcLabel,
      key: g.key,
      memberPos: g.memberPos.slice().sort(),
      poCount: g.memberPos.length,
      cartons: g.cartons,
      units: g.units,
      weightLb: Math.ceil(round2(g._weightRaw)), // portals want whole pounds, rounded up
      cubicFeet,
      cubicFeetRoundedSum: g.cubicFeetRoundedSum,
      // If summing the feed's per-row rounded values disagrees with our single
      // round-up, the view surfaces it so Nima can eyeball the portal entry.
      cubicRoundingDiffers: g.cubicFeetRoundedSum !== cubicFeet,
      rawCubicFeet: round2(g._cubicRaw),
      showUnits: g.partner === 'Nordstrom', // Nordstrom's portal entry needs a unit count
    }
  })

  out.sort((a, b) => (a.partner < b.partner ? -1 : a.partner > b.partner ? 1 : b.cartons - a.cartons))
  return out
}

function numOf(v) {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
function intOf(v) {
  return Math.round(numOf(v))
}
// Guard against binary-float drift (2.7 + 1.4 = 4.0999…) before the ceil, so a
// clean 4.1 → 5, not 4.0999→5 by luck; round to cents first, then ceil.
function round2(n) {
  return Math.round(n * 100) / 100
}
