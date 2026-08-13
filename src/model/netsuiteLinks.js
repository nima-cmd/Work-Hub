// src/model/netsuiteLinks.js — "open this document in NetSuite".
//
// Nima, 2026-08-13: *"we want links from our app to sales order and invoice and IF from
// our cards."* Every card already prints SO12446 / IF7480 / INV11358; opening one meant
// switching tabs, searching, and losing your place.
//
// ── ⚠️ THE PATH COMES FROM NETSUITE, NOT FROM THE NUMBER'S PREFIX ───────────────
//
// A NetSuite record URL needs three things: the account, the record TYPE's own page
// name, and the internal id. The tempting shortcut is to read the type off our prefix
// — SO → salesord.nl, IF → itemship.nl — but those prefixes are OUR naming convention
// (see src/model/netsuiteDocs.js, whose own header admits IR and IT were never verified
// against the live instance). A wrong page name produces a plausible URL that lands on
// an error, which is the worst kind of broken link: it looks like NetSuite's fault.
//
// One SuiteQL lookup returns BOTH the id and NetSuite's own `recordtype`, so the path
// is read rather than guessed. Verified live 2026-08-13:
//
//   SO12446  → 2840012 / salesorder        IF7480   → 2829557 / itemfulfillment
//   SO12394  → 2819291 / salesorder        IF7412   → 2814769 / itemfulfillment
//   INV11358 → 2819896 / invoice
//
// ⚠️ And when the recordtype is one we have no page name for, this returns null and the
// caller says so. It does NOT fall back to a guess — an honest "can't open that one"
// beats a link that breaks in a way nobody can diagnose.

// NetSuite's transaction page names, keyed on the `recordtype` its own SuiteQL returns.
// Lower-cased on lookup because NetSuite has not been consistent about case across
// endpoints (the REST record API answers `SalesOrd` where SuiteQL answers `salesorder`).
const RECORD_PAGES = {
  salesorder: 'salesord',
  itemfulfillment: 'itemship',
  invoice: 'custinvc',
  purchaseorder: 'purchord',
  itemreceipt: 'itemrcpt',
  transferorder: 'trnfrord',
  creditmemo: 'creditmemo',
  estimate: 'estimate',
  vendorbill: 'vendbill',
  cashsale: 'cashsale',
  salesord: 'salesord',
  itemship: 'itemship',
  custinvc: 'custinvc',
}

/** The page name for a NetSuite record type, or null when we do not know it. */
export function recordPage(recordtype) {
  const k = String(recordtype || '').trim().toLowerCase()
  return RECORD_PAGES[k] || null
}

/**
 * Build the URL. Returns null — never a guess — when anything is missing or the record
 * type has no page name we have verified.
 *
 * @param account NetSuite account id, e.g. '8513640'. A sandbox account arrives as
 *   `8513640_SB1`, which the host name spells with a hyphen; normalized here so a
 *   sandbox link is not silently pointed at production.
 */
export function netsuiteUrl({ account, recordtype, id } = {}) {
  const page = recordPage(recordtype)
  if (!account || !page || id == null || id === '') return null
  const host = String(account).trim().toLowerCase().replace(/_/g, '-')
  return `https://${host}.app.netsuite.com/app/accounting/transactions/${page}.nl?id=${encodeURIComponent(id)}`
}

// The document numbers this app prints on a card. Used to reject junk before spending a
// SuiteQL round trip on it — and, more importantly, so a query parameter coming off the
// wire can never reach the database as free text.
//
// ⚠️ Deliberately a SHAPE check, not a type lookup. It says "this looks like one of our
// document numbers", and NetSuite still decides what the thing actually is. Keeping
// those two jobs apart is the whole point of this module.
const DOC_SHAPE = /^[A-Z]{2,4}\d{1,12}$/

export function isDocNumber(doc) {
  return DOC_SHAPE.test(String(doc || '').trim().toUpperCase())
}

export function normalizeDoc(doc) {
  return String(doc || '').trim().toUpperCase()
}

/** Why a link could not be made — one reason per case, so a surface never lumps them. */
export const LINK_ERROR = {
  BAD_DOC: 'bad_doc', // not one of our document-number shapes
  NOT_CONFIGURED: 'not_configured', // no NetSuite credentials on this deploy
  LOOKUP_FAILED: 'lookup_failed', // NetSuite was asked and could not answer
  NOT_FOUND: 'not_found', // asked, answered, no such document
  UNKNOWN_TYPE: 'unknown_type', // found it, but we have no page name for its type
}

export const LINK_MESSAGE = {
  [LINK_ERROR.BAD_DOC]: 'That does not look like a NetSuite document number.',
  [LINK_ERROR.NOT_CONFIGURED]: 'NetSuite credentials are not set on this deploy.',
  [LINK_ERROR.LOOKUP_FAILED]: 'NetSuite could not be reached to look that up.',
  [LINK_ERROR.NOT_FOUND]: 'NetSuite has no transaction with that number.',
  [LINK_ERROR.UNKNOWN_TYPE]: 'Found it, but this app has no page name for that record type.',
}
