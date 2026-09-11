// src/model/partnerDocuments.js — where the governing documents live.
//
// Nima, 2026-09-11: "can we save these docs to the google drive and have them linked
// to if needed taht way we dont store everything."
//
// ⚠️ THE APP STORES RULES, NOT DOCUMENTS. A 49-page PDF copied into this repo would
// be stale the day it is superseded and unreadable by anything that needs to act on
// it. What the app keeps is the RULES, as data, each carrying its section and page —
// and a link back to the document those pages are in, so anyone can check.
//
// So this file is a registry of links and provenance. It holds no content.
//
// ⚠️ AND A DOCUMENT NOBODY HAS READ IS RECORDED AS SUCH. `rulesIn` says which module
// turned a document into rules; `null` means it exists in Drive and nothing in this
// app knows what is inside it. That distinction is the whole point — three partner
// guides sat in the Data folder for weeks while the app's rules for those partners
// were derived from observation, and I asked Nima to send me documents he already had.

// ⚠️ THEY ARE NOT ALL IN ONE FOLDER. This file first said "the Drive folder every
// one of these lives in" and pointed at Data — and 3 of the 8 are somewhere else.
// Every id below was read back from Drive's own metadata, never assumed.
export const FOLDERS = {
  data:    { id: '1LGuU2igYdmU0xEIh5L7qTcI14aPta0-a', label: 'Warehouse Documents / Data' },
  saks:    { id: '1n9KG8_LcyLinR_kwc2GpoVov5mNgnLgi', label: 'the older Saks folder' },
  nmg:     { id: '1_h_6EdxBd2wb-4inF_8_wdMFOPngVzPm', label: 'the NMG folder' },
}
/** Where a NEW guide should be dropped so this registry can find it. */
export const DROP_FOLDER = FOLDERS.data

export const folderUrl = (id) => (id ? `https://drive.google.com/drive/folders/${id}` : null)

export const driveUrl = (id) => (id ? `https://drive.google.com/file/d/${id}/view` : null)

/**
 * @typedef Document
 * @property partner    who it governs
 * @property kind       'routing guide' | 'vendor standards' | 'edi spec'
 * @property edition    the revision or date printed ON the document, not the file date
 * @property driveId    null when Drive has not indexed it yet — the file is still there
 * @property rulesIn    the module that holds its rules, or null if nobody has read it
 * @property supersededBy  a newer edition in this registry
 */
export const DOCUMENTS = [
  {
    key: 'exemplar-standards-2026-08',
    partner: 'Exemplar Luxury Group',
    also: ['Saks Fifth Avenue', 'Neiman Marcus', 'Bergdorf Goodman', 'Saks Global'],
    kind: 'vendor standards',
    title: 'ELG Vendor Standards [8.6.26].pdf',
    folder: 'data',
    edition: 'August 2026',
    pages: 49,
    // ⚠️ NO DRIVE ID YET, AND NOT FOR WANT OF LOOKING. The file IS in the Data
    // folder (4,789,155 bytes, confirmed on the local Drive mount) but the connector
    // has not indexed it, so no id can be READ — and an id that is not read is not
    // written here. Its download attribute names 1RINyEhGsLH4kDBXbLqioZNag2nGyuhE1,
    // an outside share link that this account can no longer open, so that is the
    // document's origin and NOT a usable link to our copy.
    // Fill this in from Drive once it appears; do not reconstruct it.
    driveId: null,
    localPath: 'Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data/ELG Vendor Standards [8.6.26].pdf',
    // ⚠️ "_thap" IS THE AUTHORITATIVE COPY. Nima, 2026-09-11: "use the _thap its
    // latest off their site" and "it was a conversion cause the original document
    // wouldn't let me save it, i used something to convert it."
    //
    // So: the latest pull from Exemplar's site arrived SAVE-RESTRICTED, and the
    // _thap file is that same document with the restriction removed (via 4pdf.net,
    // which is what its download attribute records). Same edition, readable copy.
    // exemplarStandards.js reads it, which is correct.
    //
    // Noted because I first read the download attribute as evidence of an unknown
    // third-party document and flagged the fee table as unverified. It is not a
    // re-OCR — an unlock preserves the existing text layer — and the provenance is
    // now on the record so nobody re-opens it from the same attribute.
    readFrom: 'ELG Vendor Standards [8.6.26]_thap.pdf — the site\'s latest, unlocked so it could be saved',
    alsoOnDisk: 'ELG Vendor Standards [8.6.26].pdf (4,789,155 bytes) — the restricted original',
    rulesIn: 'src/model/exemplarStandards.js',
    editionDate: '2026-08-06',
    // Nima confirmed on 2026-09-11 that this is the latest from Exemplar's site.
    lastChecked: '2026-09-11',
    governs: 'Incorporates the routing guides by reference and governs where they overlap',
  },
  {
    key: 'saks-routing-rev11',
    partner: 'Exemplar Luxury Group',
    also: ['Saks.com', 'Saks Fifth Avenue', 'Neiman Marcus', 'Bergdorf Goodman'],
    kind: 'routing guide',
    title: '_Saks Global Routing Guide_REV.11.4.pdf',
    edition: 'Revision 11, last updated 2026-06-01',
    // ⚠️ THE ORIGINAL, not the copy. Drive holds two byte-identical copies
    // (5,594,501 each) and I first linked the WRONG one: 1tWoIt… is titled
    // "… (1).pdf" and was created 2026-06-23, four days after this one. Harmless
    // for content, but a link should point at the file people already have open.
    driveId: '1Sfdx66Q8GyFJ3F9V1-7JsWH8vOMUZp6h',
    folder: 'data',
    duplicateOf: '1tWoItc9qEkvZDNLSVKfU7RPPEDM2rQsd',
    rulesIn: 'src/model/saksRouting.js',
    // ⚠️ The file is named REV.11.4 and the cover page says "Revision: 11". Recorded
    // as both rather than picking one, because the next edition will have to be told
    // apart from this one and a guessed version number makes that impossible.
    note: 'Filename says 11.4; the cover page says Revision 11.',
    editionDate: '2026-06-01',
    // ⚠️ Nima re-supplied this on 2026-09-11 as "…REV.11.4 current.pdf" at
    // 5,594,501 bytes — BYTE-IDENTICAL to this entry. Same document renamed, not a
    // new revision, so the rename does not read as an uncatalogued edition.
    alsoNamed: '_Saks Global Routing Guide_REV.11.4 current.pdf',
    lastChecked: '2026-09-11',
  },
  {
    key: 'saks-standards-2024-06',
    partner: 'Saks Fifth Avenue',
    kind: 'vendor standards',
    title: 'Saks Vendor Standards Manual - June 10 2024.pdf',
    folder: 'saks',
    edition: 'June 2024',
    driveId: '1IQNbDP-1JhCokAy4SoBbR-gaaI6M46xG',
    rulesIn: null,
    supersededBy: 'exemplar-standards-2026-08',
  },
  {
    key: 'nmg-routing',
    partner: 'Neiman Marcus Group',
    kind: 'routing guide',
    title: 'NMGOPS Routing Guide.pdf',
    folder: 'nmg',
    edition: 'unknown — file dated 2024-07-19',
    driveId: '1_s-xkXm5idrDYyzTgsZWVmgSSFqJeFnU',
    rulesIn: null,
    supersededBy: 'saks-routing-rev11',
  },
  {
    key: 'sfa-routing-2024-07',
    partner: 'Saks Fifth Avenue',
    kind: 'routing guide',
    title: 'SFA US Routing Guide 07.25.24.pdf',
    folder: 'saks',
    edition: '2024-07-25',
    driveId: '1RKwu4Of-YBHi16cRt9YLDL7TH-_I_qFP',
    rulesIn: null,
    supersededBy: 'saks-routing-rev11',
  },
  // ── The three that were here all along ────────────────────────────────────
  // ⚠️ I ASKED HIM TO SEND ME DOCUMENTS HE ALREADY HAD. On 2026-09-10 I told him I
  // could not build a rules registry for Nordstrom, ShopBop or Bloomingdale's without
  // their guides — and all three were sitting in this folder. The app's rules for
  // those partners are still derived from observation and from things he told me,
  // with no page citations, because nobody had read these.
  {
    key: 'macys-routing',
    partner: "Bloomingdale's",
    also: ['Macy\'s Inc'],
    kind: 'routing guide',
    title: 'macy routing Guide.pdf',
    folder: 'data',
    edition: 'unknown — file dated 2026-07-22; code cites "rev 4/14/26"',
    driveId: '1CXnkOnGCs9vgrOfIpMzegIND9IOmrS1t',
    rulesIn: null,
    citedLooselyIn: ['src/model/bolAddresses.js §13.1, §9.1'],
  },
  {
    key: 'shopbop-vendor-ops',
    partner: 'ShopBop (BOP LLC)',
    kind: 'vendor standards',
    title: 'Shopbop Vendor Operation .pdf',
    folder: 'data',
    edition: 'unknown — file dated 2026-07-27; code cites "July 2026, §7.3 / §5.4"',
    driveId: '1GiMRZRFl7WvaZUG_bL2rDxJRotoCWBIj',
    rulesIn: null,
    citedLooselyIn: ['src/model/parcelLane.js §7.3', 'src/model/dc.js §5.4'],
  },
  {
    key: 'nordstrom-edi',
    partner: 'Nordstrom',
    kind: 'edi spec',
    title: 'Nordstrom Electronic Data Interchange (EDI).pdf',
    folder: 'data',
    edition: 'unknown — file dated 2026-08-10',
    driveId: '1UZoCV2nsYQgVx8lRR4Bp33lR3jVUuZRu',
    rulesIn: null,
  },
  // ── Supplied by Nima 2026-09-11: "We are providing you everything we have." ──
  {
    key: 'saks-servicing-dc-list',
    partner: 'Exemplar Luxury Group',
    also: ['Neiman Marcus', 'Saks Fifth Avenue', 'Bergdorf Goodman', 'Saks OFF 5th'],
    kind: 'store/DC list',
    title: 'Saks Global Store Servicing DC List -6_10_26.pdf',
    alsoNamed: 'Saks Global Store Servicing DC List -6_10_26 current.pdf',
    edition: '2026-06-10',
    editionDate: '2026-06-10',
    lastChecked: '2026-09-11',
    // 80,718 bytes, byte-identical to the "current"-renamed copy Nima sent.
    driveId: '1RdwO9ZzmTiSjCAwIbLM2AjPhAFOt8CSs',
    folder: 'data',
    rulesIn: 'src/model/exemplarStores.js',
    // ⚠️ THE MOST CONSEQUENTIAL DOCUMENT IN THIS REGISTRY. It is the only
    // authoritative store→servicing-DC map, and it disagrees with NetSuite's
    // custentity_dc_location on 18 of 33 Neiman stores. Freight routed on NetSuite
    // goes to the wrong building.
    governs: 'which DC services each store — supersedes NetSuite on this question',
  },
  {
    key: 'saks-edi-store-dc-codes',
    partner: 'Exemplar Luxury Group',
    kind: 'store/DC list',
    title: 'Saks Global EDI Store and DC codes_04-21-2026 Current.pdf',
    edition: '2026-04-21',
    editionDate: '2026-04-21',
    lastChecked: '2026-09-11',
    // ⚠️ 76,314 bytes on disk and NOT in the connector's index, so no id can be read.
    driveId: null,
    folder: 'data',
    rulesIn: 'src/model/exemplarStores.js',
    governs: 'DC addresses, store addresses, and the EDI 852 reporting-only codes',
    // ⚠️ IT CONFLICTS WITH THE NEWER SERVICING LIST ON STORE 0694. This one puts the
    // Saks Photo Studio at 250 Vesey Street, 22nd Floor; the 2026-06-10 list puts it
    // at 611 5th Ave, 10th Floor. The newer document wins, and exemplarStores.js
    // carries 611 5th Ave — but it is worth confirming with Exemplar, because
    // saksRouting.js DCS still holds the Vesey address from the Routing Guide.
    conflicts: ['store 0694 address vs saks-servicing-dc-list (newer) and saks-routing-rev11'],
  },
  {
    key: 'saks-edi-5010',
    partner: 'Exemplar Luxury Group',
    kind: 'edi spec',
    title: 'Saks Global EDI 5010 Mapping Specs.pdf',
    edition: 'X12 version 5010',
    editionDate: null,
    pages: 82,
    driveId: null,
    folder: 'data',
    rulesIn: null,
    // The version we will need when we leave non-EDI. Not yet read.
    governs: 'the 5010 maps for 850/856/810 once we go EDI with Exemplar',
  },
  {
    key: 'saks-edi-4050',
    partner: 'Exemplar Luxury Group',
    kind: 'edi spec',
    title: 'Saks Global EDI_4050 Mapping Specs.pdf',
    edition: 'X12 version 4050',
    editionDate: null,
    pages: 93,
    driveId: null,
    folder: 'data',
    rulesIn: null,
    governs: 'the 4050 maps — which of 4050/5010 Exemplar expects from us is an open question',
  },
  {
    key: 'saks-vendor-pickup-entry',
    partner: 'Exemplar Luxury Group',
    kind: 'routing guide',
    title: 'Saks  Global - Vendor Pickup Entry Guide -1.2.5U.pdf',
    edition: 'v1.2.5U',
    editionDate: '2026-05-22',
    driveId: '1AcNpQRKZnqaT_rYVYWs_2f_ONMwn2HJm',
    folder: 'data',
    rulesIn: null,
    // ⚠️ FOUND WHILE LOOKING FOR SOMETHING ELSE, AND IT MAY BE THE MISSING PIECE.
    // Nothing in this app has read it, and "how a pickup is entered" is exactly the
    // gap blocking the BOL for PO 8928906.
    governs: 'how a vendor books the pickup — unread, and likely relevant to the open TMS question',
  },  // ── Bloomingdale's, supplied 2026-09-11 ───────────────────────────────────
  //
  // ⚠️ THE GAP THAT MATTERED THE SAME DAY. Four Bloomingdale's orders shipped short
  // on PO 1236143 (IF7692, IF7678, IF7681, IF7689) and I could not tell Nima what a
  // short ship costs there — Exemplar's §12.3 is Exemplar's, and fee schedules do not
  // transfer between partners. These are the documents that answer it, and until one
  // of them is READ the answer is still unknown.
  {
    key: 'bloomingdales-routing',
    partner: "Bloomingdale's",
    also: ["Macy's Inc"],
    kind: 'routing guide',
    title: 'Bloomingdales Routing Guide.pdf',
    edition: 'unknown — supplied 2026-09-11, 1,429,760 bytes',
    editionDate: null,
    driveId: null,
    folder: 'data',
    rulesIn: null,
    governs: 'how Bloomingdale\'s freight is routed and what non-compliance costs',
    // ⚠️ This is a DIFFERENT document from 'macys-routing' already in this registry
    // (macy routing Guide.pdf, 1,095,654 bytes). Both are unread; do not assume one
    // supersedes the other without comparing them.
    note: 'Distinct from macys-routing — different file, different size, both unread.',
  },
  {
    key: 'bloomingdales-vendor-standards',
    partner: "Bloomingdale's",
    kind: 'vendor standards',
    title: 'Vendor Standards.pdf',
    // ⚠️ IT IS A MACY'S DOCUMENT, AND IT NAMES ITS OWN EDITION. Every page footer
    // reads "Macy's 2023 Vendor Standards". Bloomingdale's is a Macy's division, so
    // it governs both — but the edition is 2023 while this repo's Macy's routing
    // rules cite "rev 4/14/26". Confirm it is current before quoting a figure.
    edition: "Macy's 2023 Vendor Standards",
    editionDate: '2023-01-01',
    lastChecked: '2026-09-11',
    driveId: null,
    folder: 'data',
    rulesIn: 'src/model/macysStandards.js',
    // ⚠️ THEY ARE NOT CALLED CHARGEBACKS. Macy's term is EXPENSE OFFSET, and the
    // schedule (Appendix H, pages 57-60) never uses the other word — so searching
    // for "chargeback" finds passing portal references and misses everything priced.
    governs: 'Appendix H — Expense Offsets: what non-compliance costs, including short shipments',
    // ⚠️ A file called exactly "Vendor Standards.pdf" already exists elsewhere in
    // Drive (1ZtsPuKBLI8JCwg-TSSCTS1FXh91OciK5, 1,294,548 bytes, 2024-03-15) and is a
    // DIFFERENT document. Matching this one by title alone would pick the wrong file.
    note: 'A different "Vendor Standards.pdf" exists in Drive at 1,294,548 bytes — match on size, not title.',
  },
  {
    key: 'macys-store-dc-listing',
    partner: "Bloomingdale's",
    also: ["Macy's Inc", "Bloomingdale's Outlet"],
    kind: 'store/DC list',
    title: 'Shipping_-_Store_to_DC_Listing_for_Small_Ticket_Merchandise.xls',
    // The workbook dates itself: its "Summary of Changes" tab logs amendments, the
    // newest 2026-07-28. That is a firmer edition date than the file's mtime.
    edition: 'newest logged change 2026-07-28',
    editionDate: '2026-07-28',
    lastChecked: '2026-09-11',
    driveId: null,
    folder: 'data',
    rulesIn: null,
    governs: "store → servicing DC for Macy's, Bloomingdale's and Bloomingdale's Outlet",
    // ⚠️ FOUR TABS, AND THE STORE LISTS ARE PER BANNER: Summary of Changes (684
    // rows), Macy's (516), Bloomingdale's (40 stores), Bloomingdale's Outlet.
    // Extracted 2026-09-11: 40 Bloomingdale's stores across NINE DC codes —
    // SC 13, CI 8, JP 6, ST 5, CL 2, HA 2, CG 2, TU 1, HI 1.
    //
    // ⚠️ TWO OF THOSE CODES ARE NOT IN src/model/dc.js. DC_ABBREV knows SC, ST, JP,
    // CI, CL, CG and HA — it does not know TU (Bloomies University Village, Seattle)
    // or HI (Hawaii Pool Stock, c/o City of Industry). A shipment to either store
    // would abbreviate to nothing on a cargo tag.
    findings: [
      '40 Bloomingdale\'s stores, 9 DC codes: SC 13, CI 8, JP 6, ST 5, CL 2, HA 2, CG 2, TU 1, HI 1',
      'TU and HI are NOT in src/model/dc.js DC_ABBREV',
      'This is the Bloomingdale\'s equivalent of saks-servicing-dc-list and nothing reads it yet',
    ],
  },
  {
    key: 'saint-bernard-routing',
    partner: 'Saint Bernard',
    kind: 'routing guide',
    title: 'Saint Bernard Routing Guide.pdf',
    folder: 'data',
    edition: 'unknown — file dated 2026-05-25',
    driveId: '175_UUnuxE7jnBdIANA4eYFGboGj11cTe',
    rulesIn: null,
  },
]

const withUrl = (d) => ({
  ...d,
  url: driveUrl(d.driveId),
  folderUrl: folderUrl(FOLDERS[d.folder]?.id),
  folderLabel: FOLDERS[d.folder]?.label ?? null,
})

/** Every document, newest-governing first, each with its link. */
export const documents = () => DOCUMENTS.map(withUrl)

/** The documents that govern one partner, superseded editions last. */
export function documentsFor(partner) {
  const p = String(partner || '').toLowerCase()
  return DOCUMENTS
    .filter((d) => [d.partner, ...(d.also || [])].some((n) => String(n).toLowerCase().includes(p)
      || p.includes(String(n).toLowerCase())))
    .map(withUrl)
    .sort((a, b) => (a.supersededBy ? 1 : 0) - (b.supersededBy ? 1 : 0))
}

/** The document a rules module was built from — for a "source" link on a screen. */
export const documentForModule = (modulePath) =>
  DOCUMENTS.filter((d) => d.rulesIn === modulePath).map(withUrl)[0] ?? null

/**
 * ⚠️ THE GAP REPORT, because it is the useful half. A document with no `rulesIn` is
 * one the app cannot act on — and a rule the app enforces with no document behind it
 * is worse, because it looks authoritative.
 */
export function unreadDocuments() {
  return DOCUMENTS
    .filter((d) => !d.rulesIn && !d.supersededBy)
    .map((d) => ({
      ...withUrl(d),
      why: d.citedLooselyIn
        ? `Cited without page numbers in ${d.citedLooselyIn.join(', ')} — the rules exist but cannot be checked against the source.`
        : 'No rules in this app come from this document.',
    }))
}

/** Documents that exist in Drive but whose link we cannot yet produce. */
export const unlinkedDocuments = () => DOCUMENTS.filter((d) => !d.driveId).map(withUrl)


// ── ⚠️ HOW OLD IS IT, AND WHEN DID WE LAST CHECK? ───────────────────────────
//
// Nima, 2026-09-11: "we want to have a folder like we have for if scan for the
// guides so there all stored together in the same place and so we can date them and
// check how old they are too."
//
// TWO DIFFERENT AGES, and conflating them is the trap:
//
//   editionDate  what is printed ON the document. A 2024 routing guide is stale no
//                matter how recently someone looked at it.
//   lastChecked  when WE last confirmed it is still the current published version.
//                A 2026 guide checked eight months ago may have been reissued twice.
//
// The Routing Guide puts the duty on us in writing — "It is the responsibility of
// each vendor to regularly monitor this site" — so an unchecked document is an open
// exposure, not a filing problem. Every fee in exemplarStandards.js is assessed
// against whatever the CURRENT version says.
//
// ⚠️ A DOCUMENT WITH NO lastChecked IS "NEVER CHECKED", NOT "FINE". It reports
// overdue from its edition date. [[default-is-not-an-answer]] — the alternative is a
// registry that goes quiet about the documents nobody has ever verified.

/** Default review cadence. Partner guides are reissued without notice. */
export const REVIEW_EVERY_DAYS = 90

const DAY = 86_400_000
const asDate = (v) => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null }

/**
 * @returns editionAgeDays · sinceCheckedDays (null if never) · overdue · why
 */
export function reviewStatus(doc = {}, now = Date.now()) {
  const edition = asDate(doc.editionDate)
  const checked = asDate(doc.lastChecked)
  const every = doc.reviewEveryDays ?? REVIEW_EVERY_DAYS
  const days = (t) => (t === null ? null : Math.floor((now - t) / DAY))

  const editionAgeDays = days(edition)
  const sinceCheckedDays = days(checked)

  // Superseded editions are not chased — nobody should be reading them at all.
  if (doc.supersededBy) {
    return { state: 'superseded', editionAgeDays, sinceCheckedDays, overdue: false,
      why: `Superseded by ${doc.supersededBy}; kept for history only.` }
  }
  if (checked === null) {
    return { state: 'never-checked', editionAgeDays, sinceCheckedDays: null, overdue: true,
      why: editionAgeDays === null
        ? 'No edition date and never verified against the partner\'s site.'
        : `Never verified against the partner's site; the edition is ${editionAgeDays} days old.` }
  }
  const overdue = sinceCheckedDays > every
  return {
    state: overdue ? 'overdue' : 'current',
    editionAgeDays, sinceCheckedDays, overdue, dueInDays: every - sinceCheckedDays,
    why: overdue
      ? `Last verified ${sinceCheckedDays} days ago; the cadence is ${every}.`
      : `Verified ${sinceCheckedDays} days ago; next check in ${every - sinceCheckedDays} days.`,
  }
}

/** Everything that needs looking at, worst first. */
export function needsReview(now = Date.now()) {
  return DOCUMENTS
    .map((d) => ({ ...withUrl(d), review: reviewStatus(d, now) }))
    .filter((d) => d.review.overdue)
    .sort((a, b) => (b.review.sinceCheckedDays ?? Infinity) - (a.review.sinceCheckedDays ?? Infinity))
}

/**
 * Where the guides live together, mirroring the scan-filing convention in
 * src/ingest/googleDrive.js (a named root, partner subfolders via ensureFolder).
 *
 * ⚠️ NOT CREATED YET. Creating folders and moving files in a shared Drive is
 * Nima's call, not a side effect of reading a registry — and the files are
 * currently spread across three folders (see FOLDERS above), so "putting them
 * together" MOVES documents other people may be linking to.
 */
export const GUIDES_ROOT = {
  name: 'Vendor Guides',
  layout: '<root>/<partner>/<document> — partner subfolder per banner group',
  mirrors: 'src/ingest/googleDrive.js DRIVE_ROOT_BOLS / DRIVE_ROOT_SLIPS',
  created: false,
}
