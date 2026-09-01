// src/model/poDcIdentifier.js — reading a fulfilment's PO-DC when NetSuite has not
// written one, WITHOUT ever claiming to have written it.
//
// ── ⚠️ WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// `custbody_po_cd_identifier` is the field the routing feed keys on: it says which PO
// and which DC a carton belongs to, which is what lets cartons be grouped onto a BOL.
// On 2026-09-01 eleven Bloomingdale's fulfilments were packed — 13 cartons, 111 units,
// physically on the floor — and every one had that field NULL, so Routing could not see
// a single one of them. Nothing in the app was broken; the field was simply empty.
//
// ── ⚠️ AND IT IS NOT OURS TO WRITE ───────────────────────────────────────────
//
// Nima, 2026-09-01: "we use it for a lot of things i think so we have to be careful …
// that po dc identifier though is also how the ASN is generated."
//
// That makes this field load-bearing for the 856, not just for our board. So:
//
//   1. NOTHING HERE IS EVER PUSHED TO NETSUITE. This is a read-side fallback only.
//   2. THE REAL FIELD ALWAYS WINS. We derive only when NetSuite's value is absent.
//   3. A DERIVED VALUE IS MARKED AS DERIVED and stays distinguishable from an observed
//      one, all the way to the surface — the standing rule about entered vs derived.
//   4. ⚠️ DERIVING IS NOT FIXING. If the field is empty in NetSuite, the ASN still has
//      nothing to build from. Restoring our own visibility must never be mistaken for
//      having solved that, so a derived row carries a WARNING, not a silent success.
//
// ── ⚠️ THE RULE, AND WHAT IT WAS MEASURED AGAINST ────────────────────────────
//
//   identifier = <sales order's PO number> + "-" + <customer's DC location>
//
// Checked against every fulfilment that HAS the field and could be joined to both
// halves — 2,352 of them:
//
//     before 2026     1,398 match, 160 MISMATCH
//     Jan–May 2026      559 match,   0 mismatch
//     since Jun 1       235 match,   0 mismatch
//
// ⚠️ 794 fulfilments this year, ZERO disagreements — and the 160 old ones are explained
// rather than tolerated. Bloomingdale's reassigned stores between DCs: 0011 Chestnut
// Hill and 0046 Norwalk moved SW→SC, while 0016 King of Prussia, 0017 Willow Grove and
// 0024 Bridgewater moved SC→JP. Old ShopBop fulfilments carry no DC at all
// ("POJ00368602-" against today's "POJ00368602-SBX2"). In every case the old record was
// stamped with the DC that was right THEN and the customer now holds today's one. The
// rule is correct for live work and wrong only against history — the same
// moving-destination trap as the ShopBop FC change. So this is deliberately used ONLY
// to fill a gap on current, unshipped freight, never to re-interpret a shipped record.

const clean = (v) => String(v ?? '').trim()

/**
 * Derive the identifier from the two halves.
 *
 * ⚠️ Returns null unless BOTH are present. A half-built key ("1071913-" or "-SC") is
 * exactly the junk that `splitPoDc` already has to defend against, and inventing one
 * here would put a freight destination on a shipment nobody routed.
 */
export function derivePoDc(poNumber, dcLocation) {
  const po = clean(poNumber)
  const dc = clean(dcLocation)
  if (!po || !dc) return null
  return `${po}-${dc}`
}

/**
 * Resolve one fulfilment's PO-DC, saying where the answer came from.
 *
 * @param row  { po_dc, so_po, cust_dc } as the live query returns it
 * @returns    { poDc, derived, missingNetsuiteField }
 */
export function resolvePoDc(row = {}) {
  // ⚠️ "-" IS AN ABSENT VALUE, NOT A VALUE. Boutique fulfilments carry a literal "-"
  // because the field renders for every fulfilment whether or not it has a PO or a DC.
  // Treating it as present would leave the row unroutable AND unexplained.
  const actual = clean(row.po_dc ?? row.poDc)
  const usable = actual && actual !== '-' ? actual : null
  if (usable) return { poDc: usable, derived: false, missingNetsuiteField: false }

  const poDc = derivePoDc(row.so_po ?? row.soPo, row.cust_dc ?? row.custDc)
  // ⚠️ `missingNetsuiteField` is true whenever NetSuite's own value is absent — even
  // when we could not derive one either. It is the ASN warning, and it must not be
  // conditional on our own success at guessing.
  return { poDc, derived: !!poDc, missingNetsuiteField: true }
}

/**
 * Fold the live rows into one row per fulfilment, resolving the identifier.
 *
 * ⚠️ THE SO JOIN CAN RETURN A FULFILMENT TWICE. An item fulfilment reachable from more
 * than one sales order comes back once per link, and two links can disagree about the
 * PO. When they do this REFUSES to derive rather than picking the first — an arbitrary
 * winner here is a carton grouped onto the wrong BOL, which is precisely the failure
 * this whole feed exists to prevent.
 */
export function resolveFulfilmentRows(rows = []) {
  const byId = new Map()
  for (const r of rows) {
    const id = clean(r.id)
    if (!id) continue
    const prev = byId.get(id)
    if (!prev) { byId.set(id, { ...r, _poCandidates: new Set([clean(r.so_po ?? r.soPo)].filter(Boolean)) }); continue }
    const po = clean(r.so_po ?? r.soPo)
    if (po) prev._poCandidates.add(po)
    // Keep NetSuite's own value if any duplicate row carries one.
    if (!clean(prev.po_dc) && clean(r.po_dc)) prev.po_dc = r.po_dc
  }

  const out = []
  for (const r of byId.values()) {
    const ambiguous = r._poCandidates.size > 1
    const resolved = resolvePoDc(ambiguous ? { po_dc: r.po_dc } : r)
    out.push({
      id: r.id,
      tranid: r.tranid,
      status: r.status,
      po_dc: resolved.poDc,
      poDcDerived: resolved.derived,
      missingNetsuiteField: resolved.missingNetsuiteField,
      // Named so a person reading the row can see WHY nothing was derived.
      ambiguousPo: ambiguous && !resolved.poDc ? [...r._poCandidates].sort() : null,
    })
  }
  return out
}

/**
 * The fulfilments whose NetSuite identifier is missing — the ASN warning list.
 *
 * ⚠️ This is the point of the whole module. Routing showing the freight again is the
 * convenience; this list is the thing that actually matters, because the 856 is built
 * from the field these rows do not have.
 *
 * ⚠️ IT COVERS EDI FREIGHT ONLY, and that distinction is the difference between a
 * warning and noise. Every BOUTIQUE fulfilment has an empty identifier too — the field
 * renders "-" for all of them because they have no PO and no DC and never will. Run
 * live on 2026-09-01 the unfiltered list was 18 rows: the 11 real ones plus 7 boutique
 * orders that are not EDI at all. A list that is 39% one lane is describing that lane,
 * not the fault — so a row counts only when both halves EXIST (we could derive) or the
 * two halves disagree (ambiguous). Either way it is freight that should have had an
 * identifier and does not.
 */
export const missingIdentifier = (rows = []) =>
  rows.filter((r) => r.missingNetsuiteField && (r.poDcDerived || r.ambiguousPo))
    .map((r) => ({ ifNumber: r.tranid, poDc: r.po_dc, derived: r.poDcDerived, ambiguousPo: r.ambiguousPo }))
