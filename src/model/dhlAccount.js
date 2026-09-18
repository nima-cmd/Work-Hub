// src/model/dhlAccount.js — which DHL account a shipment bills to, decided by ORIGIN.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ Naghedi has two DHL Express accounts and they are not interchangeable:      │
// │                                                                             │
// │   885857720   shipments going out of LA (our Glendale/NY warehouses)        │
// │   940296615   shipments going out of China                                  │
// │                                                                             │
// │ Nima, 2026-09-18: "885857720 is for coming out of LA the other number is    │
// │ for when they ship from china i believe."                                   │
// │                                                                             │
// │ The origin country decides which one. Everything this app ships today is    │
// │ US origin, so 885857720 is the answer in practice — but 129 orders sit at    │
// │ location "China" (8 still open), so the other case is real, not             │
// │ hypothetical.                                                               │
// │                                                                             │
// │ ⚠️ The China account is NOT wired up, on purpose. Nima said "i believe",     │
// │ and a billing account is not something to assume. A China-origin shipment   │
// │ makes this stop and ask rather than quietly bill LA.                        │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ── ⚠️ THIS IS THE UPS RULE AGAIN, AND IT COST REAL MONEY THE FIRST TIME ─────────
//
// src/model/upsRates.js exists because two UPS accounts — C6J610 wholesale and 18GE01
// ecom — are not interchangeable, the API defaults to the wrong one, and anything that
// does not NAME an account gets it. The same shape is here: two DHL accounts, and
// nothing in a rate request makes the wrong one look wrong. Both accounts even quote
// IDENTICALLY on the Glendale → Lima lane (verified live 2026-09-18, $247.95 EXPRESS
// WORLDWIDE on each), so price can never reveal a mistake. The difference is WHO IS
// BILLED, which no API response will ever tell us.

/** The accounts we know, and what each one is for. */
export const DHL_ACCOUNTS = {
  '885857720': { key: '885857720', origin: 'US', label: 'LA (Glendale / NY)', verified: true },
  // ⚠️ RECORDED, NOT ENABLED. `verified: false` is why accountFor refuses to return it:
  // the purpose came with "i believe" attached, and nobody has confirmed it bills what
  // we think it bills.
  '940296615': { key: '940296615', origin: 'CN', label: 'China origin', verified: false },
}

/**
 * Which account bills this shipment?
 *
 * @param originCountryCode  two-letter country the goods DEPART from
 * @param configured         the account from the environment, if any
 *
 * ⚠️ IT REFUSES RATHER THAN DEFAULTS. Returning the LA account for a China-origin
 * shipment would be [[default-is-not-an-answer]] with an invoice attached — and unlike
 * a wrong date, nobody sees it until an unexpected bill arrives at the wrong entity.
 */
export function accountFor(originCountryCode, { configured = null } = {}) {
  const cc = String(originCountryCode || '').trim().toUpperCase()
  if (!cc) {
    return { ok: false, account: null, why: 'no origin country on the shipment — cannot tell which DHL account bills it' }
  }
  if (cc === 'US') {
    // ⚠️ The configured value WINS but is CHECKED. An env var that quietly disagrees
    // with the rule is worth surfacing, not silently honouring or silently ignoring.
    const acct = configured || DHL_ACCOUNTS['885857720'].key
    const known = DHL_ACCOUNTS[acct]
    if (!known) {
      return {
        ok: true, account: acct, unknown: true,
        why: `shipping from ${cc} on account ${acct}, which is not an account this app recognises — check DHL_ACCOUNT_NUMBER`,
      }
    }
    if (known.origin !== 'US') {
      return {
        ok: false, account: null,
        why: `DHL_ACCOUNT_NUMBER is ${acct}, which is the ${known.label} account, but this shipment leaves ${cc}`,
      }
    }
    return { ok: true, account: acct, why: `shipping out of ${cc} on the ${known.label} account` }
  }
  const match = Object.values(DHL_ACCOUNTS).find((a) => a.origin === cc)
  if (match && !match.verified) {
    return {
      ok: false, account: null, needsConfirmation: match.key,
      why: `this ships from ${cc}, which looks like account ${match.key} (${match.label}) — that account has never been confirmed, so nothing will be billed to it until somebody says so`,
    }
  }
  return {
    ok: false, account: null,
    why: `no DHL account is recorded for shipments leaving ${cc}`,
  }
}
