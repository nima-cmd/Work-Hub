// src/model/transferPurpose.js — what a transfer order is FOR.
//
// Nima, 2026-09-15: *"within the container and this data is where we can assign and give
// these TO purposes and a role and a future job if ones needed."* And, on the container
// work generally: *"otherwise impossible in netsuite."*
//
// ── ⚠️ NETSUITE ANSWERS THIS FOR SOME OF THEM AND GENUINELY CANNOT FOR THE REST ──
//
// The transfer order's DESTINATION is sometimes the purpose already. Measured across 181
// transfer orders (2026-09-15):
//
//     68  Virtual Warehouse              no purpose — a holding state
//     67  Warehouse                      no purpose — the general floor
//     15  Warehouse Bulk : Nordstrom     ⇦ earmarked for a partner
//     11  Warehouse Bulk : Bloomingdale's
//      8  Office
//      6  Warehouse Bulk : Shopbop
//      4  Consignment
//      1  Offsite Storage
//      1  Warehouse Bulk : Saint Bernard
//
// 33 of 181 name a partner in the destination. That is an OBSERVED purpose and must not
// be re-entered by hand — it is already true in NetSuite, and asking somebody to retype
// it is how the two copies start disagreeing.
//
// The other 135 land on a generic floor. For those NetSuite has no field that says what
// the units are for, which is precisely the gap Nima is describing.
//
// ── ⚠️ A GENERIC DESTINATION IS NOT A PURPOSE, AND MUST NOT BE DRAWN AS ONE ───────
//
// "Virtual Warehouse" is a holding state: Nima, 2026-09-15, "the transfer order is then
// fulfilled, usually to a ship state that way the units can't be used for any order in
// china and aren't in the LA warehouse either." Reporting that as the purpose would make
// 68 transfer orders look decided when not one of them is. They read as UNASSIGNED, and
// unassigned is a real answer — the same rule the delivery states follow.

/**
 * Destinations that are a holding state or the general floor rather than a purpose.
 * ⚠️ AN ENTERED LIST, NOT A PATTERN. `transferOrder.js` already records why: widening a
 * destination list is "a decision, never a guess".
 */
export const NOT_A_PURPOSE = new Set(['Virtual Warehouse', 'Warehouse', 'Warehouse Bulk', 'WIP', 'Damages', 'China'])

/** `Warehouse Bulk : Nordstrom` → `Nordstrom`. NetSuite's own hierarchy separator. */
export const PARTNER_PREFIX = 'Warehouse Bulk : '

export const PURPOSE_SOURCE = {
  DESTINATION: { key: 'destination', kind: 'observed', label: 'from the transfer destination' },
  ENTERED: { key: 'entered', kind: 'entered', label: 'set by a person' },
}

/**
 * What the destination alone says about why these units are moving.
 *
 * ⚠️ RETURNS null RATHER THAN THE DESTINATION'S NAME when the destination is a holding
 * state. A function that always answers is the temptation here, and it would fill 135
 * rows with "Warehouse" as though somebody had decided something.
 */
export function purposeFromDestination(destination) {
  const d = String(destination || '').trim()
  if (!d || NOT_A_PURPOSE.has(d)) return null
  if (d.startsWith(PARTNER_PREFIX)) {
    const partner = d.slice(PARTNER_PREFIX.length).trim()
    return partner ? { role: 'partner stock', partner, detail: `earmarked for ${partner}` } : null
  }
  // Office, Consignment, Offsite Storage, Sample Sale — real destinations that are their
  // own reason, carried through under their own name rather than mapped to a vocabulary
  // this module would have to keep in step with NetSuite's location tree.
  return { role: d.toLowerCase(), partner: null, detail: `going to ${d}` }
}

/**
 * The purpose of one transfer order.
 *
 * ⚠️ OBSERVED BEATS ENTERED HERE, WHICH IS THE OPPOSITE OF THE USUAL RULE — and it is
 * deliberate. Everywhere else in this app an entered value wins because it is a person
 * correcting a derivation (src/model/inboundShipment.js SOURCE_RANK). Here the
 * "derivation" is not a guess at all: the destination is a field somebody set in
 * NetSuite, and NetSuite is where the units actually move. A note in this app that
 * disagreed with it would be describing freight that went somewhere else.
 *
 * ⚠️ SO A DISAGREEMENT IS REPORTED, NEVER RESOLVED. If a person typed a purpose and the
 * destination later came to name a partner, both are returned and `conflict` is set —
 * the pattern from custody.js, where the badge stops claiming to know and names the
 * disagreement instead.
 */
export function purposeFor(to = {}) {
  const observed = purposeFromDestination(to.destination)
  const entered = String(to.purpose || '').trim() || null

  if (observed) {
    return {
      state: 'known',
      role: observed.role,
      partner: observed.partner,
      detail: observed.detail,
      source: PURPOSE_SOURCE.DESTINATION,
      destination: to.destination || null,
      entered,
      // ⚠️ Named, not hidden: somebody wrote a purpose and NetSuite says otherwise.
      conflict: entered && entered.toLowerCase() !== String(observed.partner || observed.role).toLowerCase()
        ? `noted as "${entered}" here, but NetSuite transfers it to ${to.destination}`
        : null,
    }
  }

  if (entered) {
    return {
      state: 'known',
      role: entered,
      partner: null,
      detail: to.purposeBy ? `${to.purposeBy}: ${entered}` : entered,
      source: PURPOSE_SOURCE.ENTERED,
      destination: to.destination || null,
      entered,
      by: to.purposeBy || null,
      conflict: null,
    }
  }

  return {
    state: 'unassigned',
    role: null,
    partner: null,
    // ⚠️ SAYS WHY IT IS UNKNOWN. "Virtual Warehouse" is where units sit so that nobody
    // can use them yet — that is a holding state, and calling it a purpose would report
    // 68 transfer orders as decided.
    detail: to.destination
      ? `going to ${to.destination}, which is a holding location rather than a purpose — nobody has said what these units are for`
      : 'no destination recorded and nobody has said what these units are for',
    source: null,
    destination: to.destination || null,
    entered: null,
    conflict: null,
  }
}

/**
 * Roll a container's transfer orders up into "what is this container FOR".
 *
 * ⚠️ IT DOES NOT PICK A WINNER. A container routinely carries stock for several
 * partners at once — the 59 spans six POs — so a single "purpose" for the container
 * would be a summary that erases the answer. The breakdown IS the answer.
 */
export function purposeBreakdown(transferOrders = []) {
  const byRole = new Map()
  let unassigned = 0
  for (const to of transferOrders) {
    const p = purposeFor(to)
    if (p.state !== 'known') { unassigned++; continue }
    const key = p.partner || p.role
    const e = byRole.get(key) || { role: key, partner: p.partner, units: 0, transferOrders: [], source: p.source }
    e.units += Number(to.units) || 0
    e.transferOrders.push(to.toNumber)
    byRole.set(key, e)
  }
  return {
    roles: [...byRole.values()].sort((a, b) => b.units - a.units),
    unassigned,
    // ⚠️ `assigned + unassigned === total` is the partition this must always satisfy;
    // a counter that does not add up to its own population is the shape check:counters
    // exists to catch.
    total: transferOrders.length,
  }
}
