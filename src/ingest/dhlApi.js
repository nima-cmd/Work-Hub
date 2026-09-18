// src/ingest/dhlApi.js — the MyDHL API client. Rates today; shipments deliberately not.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ This talks to DHL Express directly, rather than going through ShipStation,  │
// │ for one reason: ShipStation does not know what is IN our boxes.             │
// │                                                                             │
// │ Nima, 2026-09-18: "i belive we purposely never sent item to shipstation to  │
// │ make it easier" — a deliberate simplification, not an oversight, and it is   │
// │ recorded here so nobody later reads it as a gap to fill.                    │
// │                                                                             │
// │ An international shipment needs a customs declaration: per line, a          │
// │ description, a tariff code, a country of origin, a quantity and a value.    │
// │ Work-Hub builds that (src/model/customsInvoice.js). Sending it through      │
// │ ShipStation would mean handing the declaration to a system that would       │
// │ reformat it on the way, with no way to see what DHL actually received.      │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ THIS FILE CANNOT BUY A LABEL, AND THAT IS THE DESIGN ─────────────────────
//
// There is no createShipment here yet. Rating is READ-ONLY: it asks a price and books
// nothing. Creating a shipment is billable, outward-facing and hard to undo, so it
// follows the ShipStation posture ([[shipstation-label-pipeline]]): the app prepares,
// a person commits. When it is added it will take an explicit confirmation argument
// rather than a default.
//
// ── ⚠️ AND THE ACCOUNT IS NEVER DEFAULTED ───────────────────────────────────────
//
// src/model/dhlAccount.js decides from the shipment's ORIGIN and refuses when it cannot.
// Both Naghedi accounts quote identically on the same lane (verified live: $247.95
// EXPRESS WORLDWIDE, Glendale → Lima, on each), so a wrong account is invisible in the
// response and only shows up on an invoice.

import { accountFor } from '../model/dhlAccount.js'

const BASE = {
  test: 'https://express.api.dhl.com/mydhlapi/test',
  production: 'https://express.api.dhl.com/mydhlapi',
}

/**
 * Credentials from the environment, with the failure modes named.
 *
 * ⚠️ A `#` IN THE SECRET MUST BE QUOTED IN .env.local, and getting it wrong is SILENT:
 * Node's env-file parser treats an unquoted `#` as the start of a comment, so the value
 * is TRUNCATED rather than rejected — and DHL answers "Invalid Credentials", which reads
 * as a wrong password rather than a mangled file. Verified 2026-09-18. Single or double
 * quotes both preserve it.
 */
export function dhlCreds(env = process.env) {
  const key = (env.DHL_API_KEY || '').trim()
  const secret = (env.DHL_API_SECRET || '').trim()
  const account = (env.DHL_ACCOUNT_NUMBER || '').trim() || null
  if (!key || !secret) {
    return {
      ok: false,
      configured: false,
      error: `DHL is not configured: ${!key ? 'DHL_API_KEY' : 'DHL_API_SECRET'} is not set`
        + (secret || key ? '' : ' (both are missing)'),
    }
  }
  return { ok: true, configured: true, key, secret, account }
}

const authHeader = (key, secret) => `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`

/**
 * Ask DHL what a shipment would cost. READ-ONLY — books nothing.
 *
 * @param origin      { countryCode, cityName, postalCode }
 * @param destination { countryCode, cityName, postalCode }
 * @param parcel      { weightLb, lengthIn, widthIn, heightIn }
 * @param environment 'test' | 'production'
 *
 * ⚠️ `isCustomsDeclarable` DEFAULTS TO TRUE and is not a detail. These are international
 * shipments of goods; a rate quoted as non-declarable is a different (cheaper, wrong)
 * product and would under-quote every job we actually do.
 */
export async function dhlRates({
  origin, destination, parcel, shipOn,
  environment = 'test', env = process.env, _fetch = fetch,
} = {}) {
  const creds = dhlCreds(env)
  if (!creds.ok) return creds

  const acct = accountFor(origin?.countryCode, { configured: creds.account })
  // ⚠️ A REFUSED ACCOUNT STOPS THE CALL. Rating on the wrong account returns a perfectly
  // plausible price — see the header note.
  if (!acct.ok) return { ok: false, configured: true, error: acct.why, needsConfirmation: acct.needsConfirmation || null }

  const base = BASE[environment]
  if (!base) return { ok: false, configured: true, error: `unknown DHL environment "${environment}" — expected test or production` }

  const q = new URLSearchParams({
    accountNumber: acct.account,
    originCountryCode: origin.countryCode,
    originCityName: origin.cityName,
    destinationCountryCode: destination.countryCode,
    destinationCityName: destination.cityName,
    weight: String(parcel.weightLb),
    length: String(parcel.lengthIn),
    width: String(parcel.widthIn),
    height: String(parcel.heightIn),
    plannedShippingDate: shipOn,
    isCustomsDeclarable: 'true',
    unitOfMeasurement: 'imperial',
  })
  if (origin.postalCode) q.set('originPostalCode', origin.postalCode)
  if (destination.postalCode) q.set('destinationPostalCode', destination.postalCode)

  let r
  try {
    r = await _fetch(`${base}/rates?${q}`, {
      headers: { Authorization: authHeader(creds.key, creds.secret), Accept: 'application/json' },
    })
  } catch (e) {
    return { ok: false, configured: true, error: `could not reach DHL: ${e.message}` }
  }
  const body = await r.json().catch(() => null)

  if (!r.ok) {
    // ⚠️ DHL'S OWN SENTENCE IS KEPT. "The account number is not found or invalid" and
    // "Invalid Credentials" are different problems with different fixes, and collapsing
    // them into "DHL error 400" is how an afternoon gets lost.
    const detail = body?.detail || body?.reasons?.[0]?.msg || body?.message || `HTTP ${r.status}`
    return { ok: false, configured: true, status: r.status, error: detail, account: acct.account }
  }

  return {
    ok: true,
    environment,
    account: acct.account,
    accountWhy: acct.why,
    // ⚠️ THE BILLED CURRENCY IS PREFERRED, not the first price in the list. DHL returns
    // several currency views of the same product (BILLC, PULCL, BASEC); taking [0] would
    // quote whichever DHL happened to order first.
    products: (body?.products || []).map((p) => {
      const billed = (p.totalPrice || []).find((x) => x.currencyType === 'BILLC') || (p.totalPrice || [])[0] || null
      return {
        code: p.productCode,
        name: p.productName,
        price: billed ? Number(billed.price) : null,
        currency: billed ? billed.priceCurrency : null,
        deliveryBy: p.deliveryCapabilities?.estimatedDeliveryDateAndTime || null,
      }
    }).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)),
  }
}
