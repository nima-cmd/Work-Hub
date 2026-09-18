// src/model/dhlShipment.js — turning a fulfilment into a DHL shipment request.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ This assembles everything DHL needs to make a waybill and an electronic     │
// │ customs declaration, and REFUSES when a piece is missing rather than        │
// │ filling it in with something plausible.                                     │
// │                                                                             │
// │ It needs four things:                                                       │
// │   the box      length, width, height and weight — TYPED IN BY A PERSON      │
// │   the addresses  where it leaves from and goes to                           │
// │   the contents the customs declaration (built elsewhere, already correct)   │
// │   the terms    who pays duty, and on what trading terms                     │
// │                                                                             │
// │ Nima, 2026-09-18: "we would always want to put in the dimension ourselves." │
// │ So there is no code path anywhere that computes a box size. Not from item   │
// │ volumes, not from a previous shipment, not from a default carton.           │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ THE GOODS WEIGH LESS THAN THE PARCEL, AND THAT GAP IS MONEY ──────────────
//
// IF7702's item records sum to 12.75 lb. That is the MERCHANDISE. It excludes the
// carton, the dunnage and the tape, and DHL bills on the greater of actual and
// dimensional weight. Pre-filling the shipment weight from the item sum would quote and
// bill low on every parcel — so the item sum is offered as a REFERENCE (`goodsWeightLb`)
// and the shipping weight is entered, like the dimensions. `prefill` exists to save
// typing, never to supply a value nobody checked.
//
// ── ⚠️ THE TERMS ARE PER CONTACT AND LIVE IN DHL, NOT IN NETSUITE ───────────────
//
// The MyDHL address book holds these per customer — for Donna Monna / Patricia Canepa:
// bill transport to 885857720, duties and taxes to the RECEIVER, terms CFR. None of that
// is in our data. So `incoterm` and `dutyPaidBy` are required inputs with no defaults:
// a shipment that silently declared DDP when the customer pays duty would hand Naghedi a
// bill it never agreed to. [[default-is-not-an-answer]], with an invoice attached.

import { accountFor } from './dhlAccount.js'

/** Incoterms we will send. Anything else is refused rather than passed through. */
export const INCOTERMS = ['CFR', 'CIF', 'CIP', 'CPT', 'DAP', 'DDP', 'EXW', 'FCA']

/** Who settles duty and tax. DHL's own vocabulary. */
export const DUTY_PAID_BY = ['sender', 'receiver']

const num = (v) => (v == null || v === '' ? null : Number(v))
const positive = (v) => { const n = num(v); return Number.isFinite(n) && n > 0 ? n : null }

/**
 * Validate the box a person typed in.
 *
 * ⚠️ EVERY FIELD IS REQUIRED AND NONE HAS A DEFAULT. A missing height is not "assume a
 * flat box"; a missing weight is not "use the goods weight". Each one names itself so
 * the form can point at the field rather than saying "invalid".
 */
export function checkParcel(parcel = {}) {
  const missing = []
  const out = {}
  for (const [key, label] of [
    ['lengthIn', 'length'], ['widthIn', 'width'], ['heightIn', 'height'], ['weightLb', 'weight'],
  ]) {
    const v = positive(parcel[key])
    if (v == null) missing.push(label)
    else out[key] = v
  }
  if (missing.length) {
    return {
      ok: false, missing,
      why: `the box needs ${missing.join(', ')} — measured, not estimated`,
    }
  }
  return { ok: true, parcel: out }
}

/**
 * Build the MyDHL shipment request.
 *
 * @param declaration  the output of getCustomsInvoice — lines, problems, totals
 * @param shipper      { name, addressLine1, city, postalCode, countryCode, phone, email, stateCode }
 * @param receiver     same shape
 * @param parcel       { lengthIn, widthIn, heightIn, weightLb } — ENTERED
 * @param terms        { incoterm, dutyPaidBy }
 * @param productCode  the DHL service, from a rate quote
 *
 * @returns { ok, payload } or { ok: false, problems }
 *
 * ⚠️ IT REFUSES ON THE DECLARATION'S OWN PROBLEMS. `getCustomsInvoice` already blocks a
 * form when a line has no tariff code or no value; passing that through to DHL would
 * transmit electronically the exact declaration the paperwork gate exists to stop.
 */
export function buildShipment({
  declaration, shipper, receiver, parcel, terms = {}, productCode,
  shipOn, environment = 'test', account = null,
} = {}) {
  const problems = []

  if (!declaration) problems.push('no customs declaration was built for this fulfilment')
  else if ((declaration.problems || []).length) {
    // ⚠️ CARRIED THROUGH VERBATIM. The declaration already says exactly what is wrong.
    problems.push(...declaration.problems)
  }
  if (!declaration?.lines?.length) problems.push('the declaration has no lines — there is nothing to declare')

  const box = checkParcel(parcel)
  if (!box.ok) problems.push(box.why)

  for (const [who, a] of [['shipper', shipper], ['receiver', receiver]]) {
    if (!a) { problems.push(`no ${who} address`); continue }
    for (const [f, label] of [['addressLine1', 'street'], ['city', 'city'], ['countryCode', 'country']]) {
      if (!String(a[f] || '').trim()) problems.push(`the ${who} address has no ${label}`)
    }
    // ⚠️ THE NAME IS CHECKED FOR BEING A NAME. NetSuite holds
    // "contact: patricia@donnamonnatw.com" as the addressee on SO12576 — an email in the
    // name field. DHL would accept it and print it on the waybill.
    const name = String(a.name || '').trim()
    if (!name) problems.push(`the ${who} has no name`)
    else if (name.includes('@')) problems.push(`the ${who} name looks like an email address ("${name}") — a waybill needs a person or company`)
  }

  const incoterm = String(terms.incoterm || '').trim().toUpperCase()
  if (!incoterm) problems.push('no incoterm — the trading terms are per customer and live in the DHL address book, not in NetSuite')
  else if (!INCOTERMS.includes(incoterm)) problems.push(`"${incoterm}" is not an incoterm this app will send`)

  const dutyPaidBy = String(terms.dutyPaidBy || '').trim().toLowerCase()
  if (!dutyPaidBy) problems.push('nobody is named to pay duty and tax — sender or receiver')
  else if (!DUTY_PAID_BY.includes(dutyPaidBy)) problems.push(`duty must be paid by sender or receiver, not "${dutyPaidBy}"`)

  if (!productCode) problems.push('no DHL service chosen — rate the shipment first and pick a product')
  if (!shipOn) problems.push('no planned shipping date')

  const acct = accountFor(shipper?.countryCode, { configured: account })
  if (!acct.ok) problems.push(acct.why)

  if (problems.length) return { ok: false, problems }

  const addr = (a) => ({
    postalAddress: {
      addressLine1: a.addressLine1,
      cityName: a.city,
      countryCode: a.countryCode,
      ...(a.postalCode ? { postalCode: a.postalCode } : {}),
      ...(a.stateCode ? { provinceCode: a.stateCode } : {}),
    },
    contactInformation: {
      companyName: a.name,
      fullName: a.contactName || a.name,
      ...(a.phone ? { phone: a.phone } : {}),
      ...(a.email ? { email: a.email } : {}),
    },
  })

  return {
    ok: true,
    account: acct.account,
    payload: {
      plannedShippingDateAndTime: shipOn,
      pickup: { isRequested: false },
      productCode,
      accounts: [{ typeCode: 'shipper', number: acct.account }],
      customerDetails: { shipperDetails: addr(shipper), receiverDetails: addr(receiver) },
      content: {
        // ⚠️ ONE PACKAGE. Multi-box shipments are a real case and NOT guessed at here —
        // splitting a declaration across cartons is a packing decision, not arithmetic.
        packages: [{
          weight: box.parcel.weightLb,
          dimensions: { length: box.parcel.lengthIn, width: box.parcel.widthIn, height: box.parcel.heightIn },
        }],
        isCustomsDeclarable: true,
        declaredValue: declaration.totalValue ?? declaration.lines.reduce((n, l) => n + l.lineTotal, 0),
        declaredValueCurrency: 'USD',
        incoterm,
        unitOfMeasurement: 'imperial',
        description: declaration.lines.map((l) => l.names?.[0]).filter(Boolean).slice(0, 3).join(', ') || 'Merchandise',
        exportDeclaration: {
          exportReason: 'permanent',
          lineItems: declaration.lines.map((l, i) => ({
            number: i + 1,
            description: l.description,
            price: l.unitPrice,
            quantity: { value: l.qty, unitOfMeasurement: 'PCS' },
            // ⚠️ THE ITEM'S OWN CODE, exactly as NetSuite holds it — dots and all.
            commodityCodes: [{ typeCode: 'outbound', value: l.hsCode }],
            manufacturerCountry: l.coo,
            weight: { netValue: l.weightLb, grossValue: l.weightLb },
          })),
        },
      },
    },
    // Not part of the payload — shown to a person before they commit.
    summary: {
      units: declaration.lines.reduce((n, l) => n + l.qty, 0),
      lines: declaration.lines.length,
      goodsWeightLb: Math.round(declaration.lines.reduce((n, l) => n + l.weightLb, 0) * 100) / 100,
      shippingWeightLb: box.parcel.weightLb,
      incoterm,
      dutyPaidBy,
      environment,
    },
  }
}
