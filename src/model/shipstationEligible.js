// src/model/shipstationEligible.js — may this fulfilment be pushed to ShipStation,
// and if so at what service level (Nima, 2026-08-06).
//
// It is a model and not a query-layer ternary for the reason labelGap.js records: the
// one rule that decides whether we act on a shipment must be testable. Here the cost
// of being wrong is money, not noise — a wrongly pushed order invites a SECOND label
// on a carton that already has one, and a guessed service level buys the wrong
// service on the wholesale account.
//
// ── ⚠️ THE SCOPE WAS EXACTLY INVERTED ───────────────────────────────────────
//
// Nima, 2026-08-06: *"We want the shipstation to only pick up our picked not packed —
// if it's packed ShipStation done its job or the label was created elsewhere."*
//
// pushToShipstation filtered on `status ILIKE 'packed'`, which is the set whose
// labels ALREADY EXIST. Measured the day this was written: 9 pushed, all 9 wrong (8
// carried a NetSuite tracking number already); 4 UPS `Picked` fulfilments that
// genuinely needed labels were absent. The view showed him what he had already made
// instead of what he still had to make.
//
// So `Picked` is the queue and `Packed` is the done pile. A label that exists is
// checked SEPARATELY and independently of status, because the two disagree in the
// wild: IF7412 is Packed with no label at all.
//
// ── ⚠️ ONLY DOMESTIC UPS IS SET UP IN SHIPSTATION ───────────────────────────
//
// Nima, same day: *"For right now we may want to avoid anything that isn't domestic
// UPS as it's not set up in shipstation yet."* So everything else is HELD with a
// reason rather than pushed and silently mis-shipped. Live, that catches:
//   • IF7450 — FedEx/USPS/More
//   • IF7452 — FedEx/USPS/More, and the customer is Gee Beauty CANADA (held twice)
//
// ── ⚠️ THE SERVICE LEVEL IS AN OPAQUE ID, AND WE DO NOT GUESS IT ────────────
//
// `transaction.shipmethod` is readable but resolves to an ID, not a name: `shipitem`
// and every sibling table return EMPTY on the bot role (not an error — empty, the
// NOT_EXPOSED signature this repo has been caught by before). Method `4` is the
// entire live UPS set, so it is mapped, and any OTHER UPS method is HELD rather than
// shipped as Ground. Buying Ground for a customer who asked for 2nd Day is a
// mis-ship we would only discover from the customer.
//
// ── ⚠️ THIRD-PARTY BILLING CANNOT BE AUTOMATED YET ──────────────────────────
//
// Nima asked for the third party to be used when the customer or the fulfilment names
// one, automated if possible. It is NOT possible today: `thirdpartyacct`,
// `thirdpartycarrier`, `thirdpartyzipcode` and `thirdpartycountry` all PARSE and then
// return zero rows on this role — NOT_EXPOSED. So we cannot read whether a boutique
// order should bill a third party.
//
// His stated fallback is what is built: *"if it requires manual entry we would like a
// safeguard and warning."* An order whose freight terms SAY third-party while no
// account is readable is HELD, because the failure mode of guessing is the one
// src/model/upsRates.js exists to prevent — billing Naghedi for freight a partner
// agreed to pay, or billing the ecom account for wholesale. Unset billing defaults to
// UPS 18GE01, so "we couldn't tell" must never become "push it anyway".

// The UPS ship-method IDs we can name. Deliberately an allow-list, not a default:
// an unrecognised method is held, never shipped as Ground.
//
// ⚠️ SUPERSEDED BY UPS_SERVICE_BY_NAME — kept only because the id path is still what
// SuiteQL can see, and a caller with no REST access falls back to it.
export const UPS_SERVICE_BY_METHOD = {
  4: 'ups_ground',
}

// The REAL service map, keyed on the sales order's `shipMethod` NAME as NetSuite
// spells it — including the ® — because that is the only place the service level is
// legible (the id resolves nowhere on this role).
//
// ⚠️ STILL AN ALLOW-LIST. "Fedex" and "DHL Express" are deliberately ABSENT rather
// than mapped to a UPS code: neither is set up in ShipStation, and an order we cannot
// name a service for is held, never guessed. Add a line here as each carrier goes live.
export const UPS_SERVICE_BY_NAME = {
  'ups® ground': 'ups_ground',
  'ups ground': 'ups_ground',
}

// Normalise for lookup without losing the distinction between two real services.
export function serviceKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export const HOLD = {
  ALREADY_LABELLED: 'ALREADY_LABELLED',
  NOT_PICKED: 'NOT_PICKED',
  // ⚠️ Its own kind on purpose. `Packed` is supposed to MEAN the label exists, and
  // this is the row where that premise fails — packed, and no tracking number
  // anywhere. Lumping it under NOT_PICKED would report "only Picked need a label"
  // about the one fulfilment that is packed and still owes one. Live: IF7412, which
  // is also the board's entire label nag and is FedEx, so it can't be pushed either
  // way — but it needs a human, not a filter.
  PACKED_NO_LABEL: 'PACKED_NO_LABEL',
  CARRIER_NOT_SET_UP: 'CARRIER_NOT_SET_UP',
  NOT_DOMESTIC: 'NOT_DOMESTIC',
  UNKNOWN_SERVICE: 'UNKNOWN_SERVICE',
  THIRD_PARTY_UNREADABLE: 'THIRD_PARTY_UNREADABLE',
  // A third-party account with no postal code: UPS validates third-party billing on
  // the account's zip, so pushing without it either fails at label time or falls back
  // to billing US — and the fallback is the expensive direction.
  THIRD_PARTY_NO_ZIP: 'THIRD_PARTY_NO_ZIP',
  // ⚠️ A FAILED READ MUST NEVER READ AS "NO THIRD PARTY". Absent billing data defaults
  // to Naghedi's account, so a network blip would quietly move someone else's freight
  // cost onto us. Unknown is held, not assumed.
  SHIP_DETAIL_UNREADABLE: 'SHIP_DETAIL_UNREADABLE',
  NO_ADDRESS: 'NO_ADDRESS',
}

// `status`       — the NetSuite fulfilment status ('Picked' | 'Packed' | …).
// `labelCount`   — carrier tracking numbers already on the fulfilment.
// `carrier`      — transaction.shipcarrier ('UPS' | 'FedEx/USPS/More' | …).
// `shipMethod`   — transaction.shipmethod, an opaque id.
// `country`      — ship-to country from the address record.
// `freightTerms` — when it names a third party we cannot read, hold (see header).
// `hasAddress`   — a label to nowhere is worse than a missing one.
export function shipstationEligibility({
  status, labelCount = 0, carrier, shipMethod, shipMethodName, country, freightTerms, hasAddress = true,
  thirdPartyAcct = null, thirdPartyZip = null, readFailed = false, deadLabelCount = 0,
} = {}) {
  const hold = (kind, reason) => ({ push: false, serviceCode: null, billTo: null, hold: kind, reason })

  // A label that already exists ends it, whatever the status says — the two disagree
  // in the wild and the label is the harder evidence.
  if (labelCount > 0) return hold(HOLD.ALREADY_LABELLED, `already has ${labelCount} label${labelCount === 1 ? '' : 's'} — ShipStation's job is done`)
  if (!/^picked$/i.test(String(status || ''))) {
    if (/^packed$/i.test(String(status || ''))) {
      // ⚠️ …UNLESS a human has declared this box's label dead. PACKED_NO_LABEL means
      // "the premise failed and this needs a human" — and a dead_label row IS that
      // human, having already written down which number is unusable and why. Holding
      // here would refuse the one case the marker was built for: IF7486, packed, with
      // a wrong NetSuite label that NetSuite will not replace (Nima, 2026-08-13).
      //
      // Safe by construction, not by judgement: reaching this line at all requires
      // labelCount === 0, so there is no live label to double up on.
      if (deadLabelCount > 0) {
        // fall through to the carrier/billing checks — the same ones a Picked row faces
      } else {
        return hold(HOLD.PACKED_NO_LABEL, 'marked Packed but carries no label anywhere — the label was expected to exist by now')
      }
    } else {
      return hold(HOLD.NOT_PICKED, `${status || 'no status'} — only Picked fulfilments still need a label`)
    }
  }
  if (!hasAddress) return hold(HOLD.NO_ADDRESS, 'no ship-to address in NetSuite')

  // ⚠️ A read failure is NOT "no third party" — see HOLD.SHIP_DETAIL_UNREADABLE.
  if (readFailed) {
    return hold(HOLD.SHIP_DETAIL_UNREADABLE, 'could not read the service or billing from NetSuite — pushing would default the freight to our own account')
  }

  // The SERVICE NAME decides, not the carrier group. `shipcarrier` is a group:
  // "FedEx/USPS/More" covers both Fedex and DHL Express, so it can neither confirm
  // nor deny UPS. When the name is available it is authoritative; the group is only a
  // fallback for callers with no REST access.
  const named = shipMethodName != null && String(shipMethodName).trim() !== ''
  if (named) {
    if (!/ups/i.test(String(shipMethodName))) {
      return hold(HOLD.CARRIER_NOT_SET_UP, `${shipMethodName} is not set up in ShipStation yet — make this label manually`)
    }
  } else if (!/ups/i.test(String(carrier || ''))) {
    return hold(HOLD.CARRIER_NOT_SET_UP, `${carrier || 'no carrier'} is not set up in ShipStation yet — make this label manually`)
  }
  // Absent country is treated as domestic: US is the unstated default in this data,
  // and holding every US order on a missing field would empty the queue.
  if (country && !/^(us|usa|united states)$/i.test(String(country).trim())) {
    return hold(HOLD.NOT_DOMESTIC, `ships to ${country} — only domestic UPS is set up in ShipStation`)
  }
  // ── WHO PAYS ────────────────────────────────────────────────────────────
  //
  // Resolvable now (the sales order's thirdPartyAcct + the customer's
  // thirdPartyZipCode), so this no longer holds on principle — it BILLS correctly.
  // ⚠️ An account with no zip is still held: UPS validates third-party billing on the
  // account's postal code, and the failure direction is us paying.
  let billTo = null
  if (thirdPartyAcct) {
    if (!thirdPartyZip) {
      return hold(HOLD.THIRD_PARTY_NO_ZIP, `third-party account ${thirdPartyAcct} has no postal code on the customer — set the billing manually`)
    }
    billTo = { party: 'third_party', account: String(thirdPartyAcct), zip: String(thirdPartyZip) }
  } else if (/third\s*party/i.test(String(freightTerms || ''))) {
    // Terms say someone else pays but no account is readable — never fall back to
    // ours, which is what unset billing does.
    return hold(HOLD.THIRD_PARTY_UNREADABLE, 'freight terms name a third party but no account is readable — set the billing manually')
  }

  const serviceCode = named
    ? UPS_SERVICE_BY_NAME[serviceKey(shipMethodName)]
    : UPS_SERVICE_BY_METHOD[Number(shipMethod)]
  if (!serviceCode) {
    const what = named ? `"${shipMethodName}"` : `method ${shipMethod ?? '(none)'}`
    return hold(HOLD.UNKNOWN_SERVICE, `UPS ${what} is not mapped to a service — pushing it would guess the service level`)
  }
  return { push: true, serviceCode, billTo, hold: null, reason: null }
}

// Split a candidate list into what to push and what to warn about, preserving the
// reason per row so the warning names the fix rather than a count (the never-lump
// rule). Callers pass their own row shape through `read`.
export function partitionForShipstation(rows = [], read = (r) => r) {
  const push = [], held = []
  for (const r of rows) {
    const v = shipstationEligibility(read(r))
    if (v.push) push.push({ row: r, serviceCode: v.serviceCode, billTo: v.billTo })
    else held.push({ row: r, hold: v.hold, reason: v.reason })
  }
  return { push, held }
}
