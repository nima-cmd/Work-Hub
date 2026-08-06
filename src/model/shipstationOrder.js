// src/model/shipstationOrder.js — our shipments → ShipStation orders.
//
// Pure and testable on purpose: every rule below was learned the hard way against
// the live API on 2026-08-05, and a rule you cannot test is one that regresses.
//
// ── WHAT ACTUALLY PRINTS ON THE LABEL ───────────────────────────────────────
//
// Nima's ShipStation is configured with Label Message #1 = [Order #] and Message #2
// = [Custom Field 2], and message #1 is NOT to be touched (retail labels depend on
// it). So exactly TWO things reach a printed label:
//
//     orderNumber     -> UPS Trx Ref No 1
//     customField2    -> UPS Trx Ref No 2
//
// customField1 and 3 are storage only — useful for searching in ShipStation, never
// printed. Anything that must be on the box goes in the two fields above, and each
// is limited to 26 CHARACTERS by ShipStation.
//
// ── BILLING: TWO MUTUALLY EXCLUSIVE MODES ───────────────────────────────────
//
//   third_party      -> billToAccount + billToPostalCode (Macy's 5R12Y0 / 30083)
//   my_other_account -> billToMyOtherAccount = a shippingProviderId
//
// ⚠️ Setting billToMyOtherAccount FORCES my_other_account mode and will not release
// it — verified live: a third_party order silently became my_other_account and
// started billing us instead of Macy's. So the two are never sent together.
//
// ⚠️ Unspecified billing defaults to UPS 18GE01 ("Small"/ecom), NOT the wholesale
// Big Box account. Same hazard src/model/upsRates.js exists to prevent, now on the
// label side. Naghedi's own wholesale freight must name BIG_BOX explicitly.
//
// ── IDENTITY vs DISPLAY ─────────────────────────────────────────────────────
//
// ⚠️ orderKey is the STABLE identity; orderNumber is a display value that changes.
// Conflating them cost real time: changing the printed number changed the key,
// which forced delete-and-recreate — and ShipStation REFUSES to re-create a
// previously deleted key, answering 404 with an empty body. With a stable key every
// revision is an in-place upsert and nothing is ever deleted.

// ShipStation shippingProviderIds for Naghedi's two UPS connections.
export const UPS_ACCOUNTS = {
  bigBox: 698098,   // C6J610 — wholesale. Tracking reads 1Z C6J610 …
  small: 697942,    // 18GE01 — ecom. The API DEFAULT, which is why it must be named.
}

export const FIELD_LIMIT = 26

// "IF7409" already says IF, so `IF ${ifNumber}` printed "IF IF7409" on a real label.
// Idempotent: prefix only what is not already prefixed.
export function withPrefix(prefix, value) {
  const v = String(value ?? '').trim()
  if (!v) return ''
  return new RegExp(`^${prefix}`, 'i').test(v) ? v : `${prefix} ${v}`
}

// Trim to what ShipStation will accept, without a silent midway truncation that
// turns one PO number into a different-looking one.
export function fit(s, limit = FIELD_LIMIT) {
  const t = String(s ?? '').trim()
  return t.length <= limit ? t : t.slice(0, limit)
}

// ── EDI (Bloomingdale's DC-direct) ──────────────────────────────────────────
//
// One order per CARTON — a parcel is one label, and one master label for a DC is a
// freight concept that does not exist in small package.
//
// Line 1 is PO + store, because a DC shipment has ONE address and many stores: the
// PO/store pair is the only thing distinguishing otherwise identical labels, and
// it is what the DC cross-docks on. Line 2 is the routing authorization.
export function buildEdiOrder({ shipment, line, storeId, now = new Date() }) {
  const w = shipment.labels
  const cartonsOnIf = w.lines.filter((l) => l.ifNumber === line.ifNumber).length
  return {
    // IF + carton is the carton's real identity and never changes.
    orderKey: `WH-${line.ifNumber}-${line.cartonNo || line.seq}`,
    // "NofM" only when there IS more than one — an earlier version used the
    // worksheet sequence, so three single-carton boxes read 1, 2, 3 and looked like
    // cartons of a set they were not part of.
    orderNumber: fit(cartonsOnIf > 1
      ? `${line.poNumber}-${line.storeNumber}-${line.cartonNo}of${cartonsOnIf}`
      : `${line.poNumber}-${line.storeNumber}`),
    orderDate: isoStamp(now),
    orderStatus: 'awaiting_shipment',
    billTo: { name: 'Naghedi' },
    shipTo: shipToOf(w.shipTo),
    items: [{ sku: `PO-${line.poNumber}`, name: `PO ${line.poNumber} · Store ${line.storeNumber}`, quantity: 1 }],
    // EDI cartons are already weighed and measured in NetSuite, so they ship with
    // real figures rather than being boxed in ShipStation.
    weight: { value: line.weightLb, units: 'pounds' },
    dimensions: line.lengthIn
      ? { units: 'inches', length: line.lengthIn, width: line.widthIn, height: line.heightIn }
      : undefined,
    carrierCode: 'ups',
    serviceCode: 'ups_ground',
    packageCode: 'package',
    advancedOptions: {
      storeId,
      ...billing({ terms: w.freightTerms, account: w.billToAccount, zip: w.billToZip }),
      customField1: fit(`PO ${line.poNumber}`),
      customField2: fit(`AUTH ${shipment.authNumber || ''}`),   // the printed line 2
      customField3: fit(`Store ${line.storeNumber}`),
    },
  }
}

// ── Boutique ────────────────────────────────────────────────────────────────
//
// Nima, 2026-08-05: the order arrives with NO package information and the box is
// chosen in ShipStation, exactly like the retail flow. So no weight and no
// dimensions are sent — and that is deliberate, not missing data.
//
// "if a PO number doesn't exist we reference the sales order number". So line 1 is
// the customer's PO when there is one (10 of 14 live have none), else our SO.
//
// ⚠️ Line 2 is NOT the item number. A boutique fulfilment carries 31–58 item lines,
// so no SKU list fits in 26 characters and picking one of forty would be arbitrary.
// It carries the OTHER document reference instead, so the label shows both without
// repeating itself.
//
// `serviceCode` comes from the fulfilment's REQUESTED ship method, resolved by
// src/model/shipstationEligible.js — it is NOT defaulted here. It used to be
// hardcoded `ups_ground`, which silently downgraded anyone who asked for a faster
// service; an order whose service we cannot name is now held rather than pushed, so
// by the time this runs the code is known.
export function buildBoutiqueOrder({ order, fulfilment, address, storeId, serviceCode, upsAccount = UPS_ACCOUNTS.bigBox, now = new Date() }) {
  if (!serviceCode) throw new Error(`buildBoutiqueOrder: no serviceCode for ${fulfilment?.ifNumber} — eligibility must resolve it before the order is built`)
  const po = order.poNumber || null
  return {
    orderKey: `WH-${fulfilment.ifNumber}`,
    orderNumber: fit(po || order.soNumber),
    orderDate: isoStamp(now),
    orderStatus: 'awaiting_shipment',
    billTo: { name: 'Naghedi' },
    shipTo: shipToOf(address),
    items: [{ sku: order.soNumber, name: `${order.soNumber} · ${order.customer || ''}`.trim(), quantity: 1 }],
    // No weight/dimensions ON PURPOSE — boxed in ShipStation.
    carrierCode: 'ups',
    serviceCode, // the REQUESTED service, never a default — see above.
    packageCode: 'package',
    advancedOptions: {
      storeId,
      // Naghedi's own wholesale freight, so the Big Box account must be NAMED —
      // left unset, ShipStation bills the ecom account instead. A boutique that
      // needs third-party billing gets it from the shipment override, same as EDI.
      ...(order.billToAccount
        ? billing({ terms: order.freightTerms || 'Third Party Bill', account: order.billToAccount, zip: order.billToZip })
        : { billToParty: 'my_other_account', billToMyOtherAccount: upsAccount }),
      customField1: fit(order.soNumber),
      // ⚠️ Prefixed only when the number does not already carry one: soNumber is
      // "SO12374" and ifNumber is "IF7409", so the naive `IF ${ifNumber}` printed
      // "IF IF7409" on line 2 of a real label (Nima, 2026-08-05). Fixed at the
      // source, because a printed label is the one place it is permanent.
      customField2: fit(po ? withPrefix('SO', order.soNumber) : withPrefix('IF', fulfilment.ifNumber)),  // printed line 2
      customField3: fit(order.customer || ''),
    },
  }
}

// The two billing modes, never mixed. See the header for why.
export function billing({ terms, account, zip }) {
  if (account) {
    return {
      billToParty: 'third_party',
      billToAccount: account,
      billToPostalCode: zip || null,
      billToCountryCode: 'US',
    }
  }
  return { billToParty: 'my_account' }
}

// NetSuite's addr1 sometimes repeats the whole address ("6 Spencer Pl, Scarsdale,
// NY 10583"). Strip a trailing ", City, ST ZIP" when it merely duplicates the
// structured fields — left alone it prints twice on the label.
export function cleanStreet(street, { city, state, zip } = {}) {
  const s = String(street || '').trim()
  if (!city) return s
  const re = new RegExp(`,\\s*${escapeRe(city)}\\s*,?\\s*${escapeRe(state || '')}\\s*${escapeRe(zip || '')}\\s*$`, 'i')
  const out = s.replace(re, '').trim().replace(/,$/, '')
  return out || s
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function shipToOf(a) {
  if (!a) return null
  return {
    name: a.name || a.addressee || '',
    company: a.company || a.name || a.addressee || '',
    street1: cleanStreet(a.street || a.addr1, { city: a.city, state: a.state, zip: a.zip }),
    city: a.city, state: a.state, postalCode: a.zip, country: a.country || 'US',
    phone: a.phone || null,
  }
}

const isoStamp = (d) => new Date(d).toISOString().slice(0, 19) + '.0000000'
