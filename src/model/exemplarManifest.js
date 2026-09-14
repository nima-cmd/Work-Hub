// src/model/exemplarManifest.js — the Master Manifest & Packing List, as data.
//
// Nima, 2026-09-14: "in addition i believe we need an Manifest prefilled".
//
// ⚠️ THIS IS THE DOCUMENT WE HAVE NEVER PRODUCED. `documentsRequired()` has named it
// as required since 09-09 with the line from the guide beside it — "Master Manifest &
// Packing List — Required for all shipments. Must provide the manifest to the carrier
// at pick-up" (p13) — and nothing generated one. It is the only one of the four
// required documents with no generator at all.
//
// ⚠️ IT GOES TO THE CARRIER AT PICK-UP, NOT TO THE DC. That is what makes it a
// different document from the packing slip (which is emailed ahead and pouched to a
// carton) and from the BOL (which is the contract of carriage). Printing it and
// leaving it in the pouch satisfies nothing.
//
// ⚠️ ONE PER BANNER, EACH LABELLED WITH THE BANNER NAME AND THE SHIP-TO DC (p13).
// Exemplar is four banners behind one vendor portal — Saks Fifth Avenue, Saks OFF
// 5th, Neiman Marcus, Bergdorf Goodman — and a single sheet covering two of them is
// not the document the guide asks for. So this returns a LIST of manifests, even when
// a shipment turns out to have exactly one.

import { BANNERS, servicingDc } from './exemplarStores.js'

export const SOURCE = {
  guide: 'Saks Global US Routing Guide',
  revision: '11',
  page: 13,
  rule: 'Master Manifest & Packing List — Required for all shipments. Must provide the manifest to the carrier at pick-up.',
  perBanner: 'One manifest per banner, each labelled with the banner name and ship-to DC',
  mustContain: ['store numbers', 'carton counts', 'PO numbers', 'banner name', 'ship-to DC'],
}

const int = (v) => Math.max(0, Math.trunc(Number(v) || 0))

/**
 * Build the manifests for one shipment.
 *
 * @param cartons  [{ carton, units, store, po }] — one entry per physical carton.
 * @param opts.dc  the ship-to DC code on the shipment, used only to CHECK the stores
 *                 agree with it. It is never used to fill one in.
 *
 * ⚠️ THE STORE'S OWN SERVICING DC IS THE AUTHORITY, AND A DISAGREEMENT IS REPORTED.
 * exemplarStores records that NetSuite is wrong about where 18 stores ship. A manifest
 * that silently prints the shipment's DC for a store routed elsewhere hands the driver
 * a sheet that disagrees with the freight.
 */
export function buildManifests(cartons = [], { dc = null } = {}) {
  const problems = []
  const byBanner = new Map()

  for (const c of cartons) {
    const store = String(c.store ?? '').trim()
    const po = String(c.po ?? '').trim()
    if (!store) { problems.push(`carton ${c.carton}: no store number — a manifest is a per-store document`); continue }
    if (!po) { problems.push(`carton ${c.carton}: no PO number`); continue }

    const s = servicingDc(store)
    if (!s) { problems.push(`store ${store} is not in Exemplar's DC List — its banner and servicing DC are unknown`); continue }
    if (dc && String(s.dc) !== String(dc).replace(/^0+/, '')) {
      problems.push(`store ${store} is serviced by DC ${s.dc} (${s.name}) but this shipment is going to DC ${dc}`)
    }

    // ⚠️ THE BANNER CODE IS TRANSLATED, AND AN UNKNOWN ONE IS NOT GUESSED. "SFA" on a
    // sheet handed to a driver means nothing; inventing a name for a code we do not
    // hold would be worse.
    const code = s.banner || null
    const name = code ? BANNERS[code] : null
    if (code && !name) problems.push(`store ${store} has banner code "${code}", which is not one of ${Object.keys(BANNERS).join(', ')}`)
    const key = code || '(unknown)'

    if (!byBanner.has(key)) {
      byBanner.set(key, {
        bannerCode: code, bannerName: name || null,
        dc: s.dc, dcName: s.name,
        stores: new Map(), pos: new Set(), cartons: 0, units: 0,
      })
    }
    const m = byBanner.get(key)
    if (!m.stores.has(store)) m.stores.set(store, { store, storeName: s.storeName || null, cartons: 0, units: 0, pos: new Set() })
    const st = m.stores.get(store)
    st.cartons += 1; st.units += int(c.units); st.pos.add(po)
    m.cartons += 1; m.units += int(c.units); m.pos.add(po)
  }

  const manifests = [...byBanner.values()].map((m) => ({
    bannerCode: m.bannerCode, bannerName: m.bannerName,
    dc: m.dc, dcName: m.dcName,
    pos: [...m.pos].sort(),
    totalCartons: m.cartons, totalUnits: m.units,
    stores: [...m.stores.values()]
      .map((s) => ({ ...s, pos: [...s.pos].sort() }))
      .sort((a, b) => a.store.localeCompare(b.store)),
  })).sort((a, b) => String(a.bannerName).localeCompare(String(b.bannerName)))

  return {
    source: SOURCE,
    manifests,
    problems,
    // ⚠️ A MANIFEST WITH A PROBLEM IS NOT PRINTED. It is handed to a driver at pick-up
    // and travels with the freight; a sheet that names the wrong DC for a store is
    // worse than no sheet, because it looks authoritative.
    printable: problems.length === 0 && manifests.length > 0,
  }
}

/**
 * ⚠️ DOES THE MANIFEST AGREE WITH THE FREIGHT ACTUALLY LEAVING?
 *
 * The carton rows come from NetSuite's package records and the shipment totals come
 * from the routing feed. They are two reads of the same thing, and a manifest whose
 * carton count differs from the BOL's is a discrepancy the DC raises against us.
 */
export function manifestAgreesWith({ manifests = [] }, { cartons, units } = {}) {
  const mc = manifests.reduce((a, m) => a + m.totalCartons, 0)
  const mu = manifests.reduce((a, m) => a + m.totalUnits, 0)
  const notes = []
  if (cartons != null && mc !== int(cartons)) notes.push(`the manifests total ${mc} cartons, the shipment says ${cartons}`)
  if (units != null && mu !== int(units)) notes.push(`the manifests total ${mu} units, the shipment says ${units}`)
  return { agrees: notes.length === 0, notes, cartons: mc, units: mu }
}
