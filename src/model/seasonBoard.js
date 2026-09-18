// src/model/seasonBoard.js — the open POs, grouped by the season they are buying for.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ This builds the Seasons screen. It takes every purchase order that still    │
// │ owes us goods and sorts them into piles by which season they were bought    │
// │ for, then asks one question of each pile: will this arrive before that      │
// │ season launches?                                                            │
// │                                                                             │
// │ Three facts get combined, each from somewhere different:                    │
// │   WHICH SEASON  from the items on the PO (each item carries a season)       │
// │   WHICH LANE    from the PO's final destination (see poLane.js)             │
// │   WHICH DEADLINE from the marketing calendar's launch dates                 │
// │                                                                             │
// │ Three counting rules that are easy to get wrong, and why they matter:       │
// │                                                                             │
// │ 1. "Units" here means units ORDERED, not units still owed. We only know the │
// │    season totals per PO, so we cannot honestly split "what is still owed"   │
// │    by season. Showing one number and letting you assume the other would be  │
// │    a lie of omission, so the two sit in separate columns.                   │
// │                                                                             │
// │ 2. A PO often buys for several seasons at once. It appears under each one,  │
// │    but only with THAT season's share of the units — never its full total,   │
// │    or one 840-unit PO would look like 1,680 units of stock.                 │
// │                                                                             │
// │ 3. A season whose launch has already passed gets NO verdict. Stock arriving │
// │    for a launch that happened in February is a restock, not a late          │
// │    delivery. Calling it "late" would be shouting about nothing, and would   │
// │    train you to ignore the real warnings.                                   │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Nima's ask (2026-09-18): *"a season view — POs grouped by season + year, with lane and
// deadline."* Every input already existed and nothing put them on one screen:
//
//   season   po_item_season   (custitem_season_year, per PO — src/ingest/seasonSync.js)
//   lane     purchase_orders.destination  (custbody_acs_final_destination)
//   deadline season_drop      (the marketing calendar — the AUTHORITY on dates)
//
// ── ⚠️ THE UNITS ARE ORDERED UNITS, NOT REMAINING, AND THAT IS NOT INTERCHANGEABLE ──
//
// `po_item_season.units` is `SUM(tl.quantity)` off the PO line — what was BOUGHT.
// `purchase_orders.qty_remaining` is what is still owing. A season's figure here is the
// former, because the season mix is only cached per (PO, season) and there is no local
// item→season map to split "remaining" along. Reporting 6,547 Holiday units as though
// they were all still coming would be exactly the arithmetic-field bug this repo keeps
// finding ([[field-assumption-register]]), so the two numbers are carried SEPARATELY and
// labelled — `units` is ordered, `remaining` is per PO and never summed by season.
//
// ── ⚠️ A PO SPANS SEASONS, SO IT APPEARS IN EACH — WITH ITS OWN UNITS EACH TIME ────
//
// 46% of POs carry more than one season. A PO shows up under every season it buys for,
// and the units credited to each are THAT season's slice from the mix — never the PO's
// total, which would count 1,330 units five times over and make every season look full.
//
// ── ⚠️ "Core" IS NOT A SEASON AND GETS ITS OWN GROUP ───────────────────────────────
//
// 14,593 of the units on open POs are Core — evergreen stock belonging to no drop, and
// the single biggest bucket on the board. Sorting it in among the seasons would put a
// restock at the top of a launch screen; dropping it would hide 14,593 units. It is kept
// as a group that is explicitly NOT a drop and carries no deadline.

import { parseSeason, EVERGREEN } from './poSeason.js'
import { dropFor, dropRisk, suggestReason } from './seasonDrops.js'
import { poLane, laneBreakdown } from './poLane.js'

/**
 * Group open POs by the season their items belong to.
 *
 * @param pos [{ poNumber, destination, vendor, status, expectedReceipt, qtyOrdered,
 *               qtyRemaining, mix: [{season, units}], confirmed, orderLinks, types }]
 * @param drops   season_drop rows, as seasonDrops.dropsFrom shapes them
 * @param today
 */
export function seasonBoard({ pos = [], drops = [], today = new Date() } = {}) {
  /** label → group */
  const groups = new Map()

  const groupFor = (label, parsed) => {
    if (groups.has(label)) return groups.get(label)
    // ⚠️ THE DROP IS LOOKED UP ONCE PER GROUP, not per PO. dropFor returns `assumed`
    // when a season has two drops and nothing says which — carried through rather than
    // resolved, because picking one would invent a deadline.
    const drop = parsed?.kind === 'season' ? dropFor(label, null, drops) : null
    const g = {
      label,
      kind: parsed?.kind || 'unknown',
      season: parsed?.season || null,
      year: parsed?.year ?? null,
      program: parsed?.program || null,
      drop: drop ? { number: drop.drop, on: drop.on, title: drop.title, assumed: !!drop.assumed, single: !!drop.single } : null,
      units: 0,
      pos: [],
    }
    groups.set(label, g)
    return g
  }

  for (const po of pos) {
    const lane = poLane(po.destination)
    const mix = (po.mix || []).filter((m) => (Number(m.units) || 0) > 0)
    for (const m of mix) {
      const units = Number(m.units) || 0
      const parsed = parseSeason(m.season)
      // ⚠️ UNSEASONED UNITS ARE A GROUP, NOT A DISCARD. Items carrying no season at all
      // are real stock on a real PO — PO1761 is 720 of them. Dropping the row would make
      // the board's total quietly disagree with the POs it is built from.
      const label = parsed ? parsed.label : 'No season on the items'
      const g = groupFor(label, parsed)
      g.units += units
      g.pos.push({
        poNumber: po.poNumber,
        vendor: po.vendor || null,
        status: po.status || null,
        expectedReceipt: po.expectedReceipt || null,
        // ⚠️ THIS season's slice of the PO, not the PO's total.
        units,
        // Carried, never summed into the season — see the header note.
        remaining: po.qtyRemaining ?? null,
        ordered: po.qtyOrdered ?? null,
        lane,
        confirmed: po.confirmed || null,
        orderLinks: po.orderLinks || [],
        types: po.types || [],
      })
    }
  }

  const out = [...groups.values()].map((g) => {
    // ⚠️ THE LANE BREAKDOWN IS BUILT FROM THIS SEASON'S SLICES, so a season that is
    // mostly Nordstrom reads that way even when the POs also carry retail stock for
    // another season entirely.
    const lanes = laneBreakdown(g.pos.map((p) => ({ destination: p.lane.destination, units: p.units })))
    // ⚠️ THE RISK IS PER PO, NOT PER SEASON, because the arrival date is. A season is
    // "at risk" when one of its POs is — and the PO is named, so the finding is
    // actionable rather than a colour on a heading.
    const risks = g.pos.map((p) => {
      // ⚠️ THE REASON MUST BE INFERRED WHEN NOBODY HAS CONFIRMED ONE, and leaving it
      // null was a 45-false-positive bug caught on live data the first time this ran.
      //
      // dropRisk refuses to judge a restock against a launch — that guard is the whole
      // reason PO1820 does not read "138 days late". But it keys on `reason`, and
      // `reason` came only from doc_seasons, which holds ONE row for the entire
      // database. So the guard was UNREACHABLE for 79 of 80 POs, and the board reported
      // every PO of every past season as late: Spring 2026 twelve times over, against a
      // drop that happened 227 days ago. Stock bought for a launch that is long gone is
      // replenishment; calling it late is the unreachable-branch counter bug aimed at a
      // deadline ([[counter-truth-audit]], shape 1).
      //
      // ⚠️ AND THE SUGGESTION IS CARRIED AS A SUGGESTION. `reasonSuggested` says the
      // calendar answered rather than a person, and suggestReason's own `confident` flag
      // rides along — stock arriving after its drop is USUALLY a restock and can equally
      // be a launch that slipped, which is the difference between "we sold out" and "we
      // missed the date". A person still settles it; the app stops shouting meanwhile.
      const hint = p.confirmed?.reason
        ? null
        : suggestReason({
          seasonLabel: g.kind === 'season' ? g.label : null,
          drop: g.drop?.number ?? null,
          evergreen: g.kind === 'evergreen',
          hasOrderLink: (p.orderLinks || []).length > 0,
          drops,
          today,
        })
      const reason = p.confirmed?.reason || hint?.reason || null

      // ⚠️ A DUE DATE THAT HAS PASSED IS NOT AN EXPECTED ARRIVAL, and feeding it to
      // dropRisk as one produced a reassuring sentence about freight nobody has seen.
      // PO1747 is due 2026-07-01 and still owes 18 units; the board announced "expected
      // 2026-07-01, 104 days before Hoilday Launch" — arithmetic on a date that went by
      // 79 days ago. 34 of the 80 open POs are past due, 7,535 units, some by TWO YEARS
      // (PO1326 is 735 days over).
      //
      // So a passed due date is withheld from the verdict rather than restated as a
      // prediction: dropRisk then answers "needed by <drop> and nothing says when it
      // arrives", which is the truth. The date itself is still carried and the overdue
      // days are named, because "we do not know" plus "it was due in July" is a far
      // stronger prompt than either alone.
      const dueDays = p.expectedReceipt
        ? Math.round((new Date(p.expectedReceipt) - new Date(today)) / 86400000)
        : null
      const overdue = dueDays != null && dueDays < 0 ? -dueDays : null
      return {
        poNumber: p.poNumber,
        reason,
        reasonSuggested: !p.confirmed?.reason && !!hint?.reason,
        reasonConfident: p.confirmed?.reason ? true : !!hint?.confident,
        reasonWhy: p.confirmed?.reason ? null : hint?.why || null,
        overdue,
        risk: dropRisk({
          seasonLabel: g.kind === 'season' ? g.label : null,
          drop: g.drop?.number ?? null,
          reason,
          expectedOn: overdue ? null : p.expectedReceipt,
          drops,
          today,
        }),
      }
    })
    const late = risks.filter((r) => r.risk.state === 'late')
    const tight = risks.filter((r) => r.risk.state === 'tight')
    return {
      ...g,
      lanes: lanes.lanes,
      arriving: lanes.arriving,
      poCount: g.pos.length,
      risks,
      late,
      tight,
      // ⚠️ A SEASON WITH NO DROP HAS NO VERDICT, and says so rather than reading "ok".
      // Past seasons, programs, Core and the unseasoned group all land here — none of
      // them is late, and none of them is fine either; there is simply no deadline.
      //
      // ⚠️ AND A SEASON WHOSE DROP HAS ALREADY HAPPENED IS THE SAME CASE, which this
      // got wrong on its first live run. Spring 2026 has a drop — 2026-02-04, 227 days
      // gone — so `g.drop` is truthy, no PO is late (they are all restocks), and the
      // board announced "ok". That is a counter whose label does not match what it
      // counted: "ok" reads as "this season will make its launch", about a launch
      // nobody can still miss. The verdicts decide, not the mere existence of a date.
      state: !g.drop ? 'no-deadline'
        : late.length ? 'late'
          : tight.length ? 'tight'
            : risks.length && risks.every((r) => r.risk.state === 'no-deadline') ? 'no-deadline'
              : risks.some((r) => r.risk.state === 'ok') ? 'ok' : 'unknown',
      daysToDrop: g.drop ? Math.round((new Date(g.drop.on) - new Date(today)) / 86400000) : null,
    }
  })

  // ⚠️ SORTED BY DEADLINE, NEAREST FIRST — the whole point of the screen. Groups with no
  // drop sort after every group that has one, and among themselves by units, so Core's
  // 14,593 lead the no-deadline tail instead of an empty program group.
  out.sort((a, b) => {
    if (a.drop && b.drop) return new Date(a.drop.on) - new Date(b.drop.on) || b.units - a.units
    if (a.drop) return -1
    if (b.drop) return 1
    return b.units - a.units
  })

  return {
    seasons: out,
    totals: {
      groups: out.length,
      units: out.reduce((s, g) => s + g.units, 0),
      pos: new Set(pos.map((p) => p.poNumber)).size,
      late: out.reduce((s, g) => s + g.late.length, 0),
      tight: out.reduce((s, g) => s + g.tight.length, 0),
      // ⚠️ NAMED SO NOBODY READS IT AS "UNITS IN STOCK". This is what has been BOUGHT
      // for seasons that still have a launch ahead of them.
      withDeadline: out.filter((g) => g.drop).reduce((s, g) => s + g.units, 0),
      // ⚠️ POs whose due date has already gone by, counted ONCE however many seasons
      // they appear under — the arrival nobody can predict any more.
      overdue: new Set(out.flatMap((g) => g.risks.filter((r) => r.overdue).map((r) => r.poNumber))).size,
    },
    evergreenLabel: EVERGREEN,
  }
}
