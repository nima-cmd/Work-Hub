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
