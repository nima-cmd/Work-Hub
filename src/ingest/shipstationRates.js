// src/ingest/shipstationRates.js — live UPS rate quotes, per ACCOUNT.
//
// The whole reason this uses V2 and not V1: V1 /shipments/getrates accepts only a
// `carrierCode`, and both Naghedi UPS accounts are "ups", so V1 cannot be pointed
// at one. It silently quotes the primary (18GE01) — verified, the numbers come back
// identical to an explicit 18GE01 V2 quote. V2 addresses carriers by a unique
// `carrier_id`, which is the only way to ask the wholesale account specifically.
//
// Rating is a READ — ShipStation does not charge for a quote and nothing here buys
// a label. `/v2/labels` is never called from this file.
//
// This is written to work the moment Nima reconnects the Big Box carrier: nothing
// about the code assumes the failure. checkConnection() rate-tests rather than
// trusting /v2/carriers, because the broken carrier still reports 23 healthy-looking
// services from cache — see src/model/upsRates.js.
import { UPS_ACCOUNTS, WHOLESALE_ACCOUNT, ORIGIN, liveFigure } from '../model/upsRates.js'

const V2 = 'https://api.shipstation.com'

export const ratesConfigured = () => Boolean(process.env.SHIPSTATION_API_KEY_V2)

const headers = () => ({ 'API-Key': process.env.SHIPSTATION_API_KEY_V2, 'Content-Type': 'application/json', Accept: 'application/json' })

// Build the V2 shipment body for one box. Residential matters — UPS charges a
// residential surcharge, and boutiques are commercial, so guessing wrong here moves
// the number by several dollars.
export function rateRequest({ box, destination, carrierId, residential = false }) {
  return {
    rate_options: { carrier_ids: [carrierId] },
    shipment: {
      ship_from: {
        name: 'Naghedi', phone: '5551234567',
        address_line1: ORIGIN.street1, city_locality: ORIGIN.city, state_province: ORIGIN.state,
        postal_code: ORIGIN.postalCode, country_code: ORIGIN.country, address_residential_indicator: 'no',
      },
      ship_to: {
        name: destination.name || 'Consignee', phone: destination.phone || '5551234567',
        address_line1: destination.street1 || 'Address on file',
        city_locality: destination.city, state_province: destination.state,
        postal_code: destination.postalCode, country_code: destination.country || 'US',
        address_residential_indicator: residential ? 'yes' : 'no',
      },
      packages: [{
        weight: { value: Number(box.weightLb), unit: 'pound' },
        ...(box.lengthIn && box.widthIn && box.heightIn
          ? { dimensions: { unit: 'inch', length: Number(box.lengthIn), width: Number(box.widthIn), height: Number(box.heightIn) } }
          : {}),
      }],
    },
  }
}

// Quote one box on one named account. Returns { ok, figures[] } or { ok:false,
// error } — a broken carrier connection surfaces as ok:false with UPS's own
// message, which is what the UI shows Nima so the cause is never a mystery.
export async function quoteAccount({ account, box, destination, residential = false }) {
  const acct = UPS_ACCOUNTS[String(account || '').toUpperCase()]
  if (!acct) return { ok: false, error: `unknown UPS account ${account}` }
  if (!ratesConfigured()) return { ok: false, configured: false, error: 'SHIPSTATION_API_KEY_V2 not set' }
  if (!Number(box?.weightLb)) return { ok: false, error: 'box has no weight' }
  if (!destination?.postalCode) return { ok: false, error: 'destination has no postal code' }

  let res
  try {
    res = await fetch(`${V2}/v2/rates`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify(rateRequest({ box, destination, carrierId: acct.carrierId, residential })),
    })
  } catch (e) {
    return { ok: false, account: acct.account, error: `network: ${e.message}` }
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) return { ok: false, account: acct.account, error: `HTTP ${res.status}${body?.errors?.[0]?.message ? ` — ${body.errors[0].message}` : ''}` }

  const rr = body?.rate_response || {}
  // A 200 with status "error" is the broken-connection case. It is NOT an empty
  // result — reporting it as "no rates" would hide a fixable configuration fault.
  if (rr.status === 'error' || (!rr.rates?.length && rr.errors?.length)) {
    return { ok: false, account: acct.account, carrierId: acct.carrierId, error: rr.errors?.map((e) => e.message).join('; ') || 'carrier returned no rates' }
  }

  const asOf = new Date().toISOString().slice(0, 10)
  const figures = (rr.rates || []).map((r) =>
    liveFigure({
      account: acct.account, serviceCode: r.service_code,
      shippingAmount: r.shipping_amount?.amount, otherAmount: r.other_amount?.amount, asOf,
    }))
  figures.sort((a, b) => a.total - b.total)
  return { ok: true, account: acct.account, carrierId: acct.carrierId, figures }
}

// Is the wholesale carrier actually usable right now? Rate-tests with a small real
// shipment, because cached carrier metadata lies. Cheap (a quote is free) and it is
// the single check that tells Nima whether the reconnect worked.
export async function checkConnection(account = WHOLESALE_ACCOUNT) {
  const r = await quoteAccount({
    account,
    box: { weightLb: 10, lengthIn: 18, widthIn: 14, heightIn: 10 },
    destination: { city: 'Burbank', state: 'CA', postalCode: '91502', country: 'US' },
  })
  return r.ok
    ? { account, healthy: true, services: r.figures.length }
    : { account, healthy: false, error: r.error }
}
