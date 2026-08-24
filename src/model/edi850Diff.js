// src/model/edi850Diff.js — what actually changed between two versions of an 850.
//
// ⚠️ THE QUESTION THIS ANSWERS IS "DO I HAVE TO REDO THE WORK?"
//
// Nima, 2026-08-24: "we have two nordstrom PO's we are currently working on and now
// we have a new 850 from nordstrom for the ones we already created IF for. Can you
// tell me what changed?" — and then, decisively: "can you tell me if we need to make
// IF for the new 850 or if we can use the if we have".
//
// Answering it by hand meant fetching both message bodies and diffing 930 fields.
// The result was worth having and the method was not repeatable, so it is here.
//
// ── ⚠️ NINE OF EVERY TEN DIFFERENCES ARE NOISE, AND MUST STILL BE COUNTED ────
//
// Measured on the real pair (PO 50073678, 17 Aug vs 21 Aug): 10 of 930 fields
// differed. NINE were envelope metadata — interchange date/time, three separate
// control numbers, the href. Exactly one was substantive: the ship-not-before date.
//
// So the envelope is suppressed from the headline — but it is COUNTED AND REPORTED,
// never silently dropped. "10 fields changed" with no breakdown invites someone to
// go looking for nine changes that do not exist; "1 real change, 9 control numbers"
// is the same fact and answers the question.
//
// ⚠️ SUPPRESSION IS AN ALLOW-LIST OF NOISE, NOT A FILTER OF THE RECOGNISED. An
// unknown field path is ALWAYS substantive. Getting this backwards — showing only
// fields we have labels for — is how a changed ship-to address or a new line item
// would vanish from a diff whose whole job is to catch exactly that. It is the same
// trap as a counter that reports only the cases it was taught about.

/** X12 BEG02. The code the partner uses to say what this transmission IS. */
export const PURPOSE_CODES = {
  '00': 'Original',
  '01': 'Cancellation',
  '04': 'Change',
  '05': 'Replace',
  '06': 'Confirmation',
  '07': 'Duplicate',
  '22': 'Information copy',
}

// ⚠️ A CHANGE OR A REPLACE CAN INVALIDATE WORK ALREADY DONE. A duplicate cannot —
// the partner is restating the same order. This drives the headline verdict, and it
// is the difference between "use the fulfilments you have" and "check every line".
const REWORK_PURPOSES = new Set(['01', '04', '05'])

/** X12 DTM01 qualifiers seen on real partner 850s.
 *  ⚠️ 037 is the one Nordstrom actually sends — db/schema.sql documented only 064.
 *  src/ingest/orderfulDates.js accepts 064, 037 and 010, in that order. */
export const DATE_QUALIFIERS = {
  '001': 'cancel after',
  '010': 'requested ship',
  '037': 'ship not before',
  '064': 'do not deliver before',
  '002': 'delivery requested',
}

// Paths whose changing means nothing about the goods. Matched as prefixes/suffixes
// on the flattened path, so a new control field inside the same envelope object is
// covered without being individually listed.
const ENVELOPE_PATTERNS = [
  /^interchangeControlHeader\./,
  /^functionalGroupHeader\./,
  /^href$/,
  /transactionSetControlNumber$/,
  /^transactionSets\.\d+\.transactionSetTrailer\./,
  // The 850's own header date — when the document was cut, not a ship date.
  /^transactionSets\.\d+\.beginningSegmentForPurchaseOrder\.\d+\.date$/,
]

const isEnvelope = (path) => ENVELOPE_PATTERNS.some((re) => re.test(path))

/** Flatten to `a.0.b` → value. Arrays become numeric segments, so a line moving
 *  position shows up as a change — which it is, for a PO read by position. */
export function flattenBody(o, prefix = '', out = {}) {
  if (o === null || o === undefined || typeof o !== 'object') {
    out[prefix] = o === undefined ? null : o
    return out
  }
  for (const [k, v] of Object.entries(o)) flattenBody(v, prefix ? `${prefix}.${k}` : k, out)
  return out
}

/**
 * A business label for a changed path, read from the BODY rather than from the
 * path's position.
 *
 * ⚠️ THE DATE'S MEANING IS IN ITS QUALIFIER, NOT ITS INDEX. `dateTimeReference.1`
 * is ship-not-before on these two POs and would be something else on the next
 * partner. Labelling by index is the positional assumption this repo keeps paying
 * for, so the qualifier is looked up beside the value.
 */
export function labelFor(path, body) {
  const dtm = path.match(/^transactionSets\.(\d+)\.dateTimeReference\.(\d+)\.date$/)
  if (dtm) {
    const q = body?.transactionSets?.[+dtm[1]]?.dateTimeReference?.[+dtm[2]]?.dateTimeQualifier
    const name = DATE_QUALIFIERS[q]
    return name ? `${name} (DTM ${q})` : q ? `date, qualifier ${q} — UNRECOGNISED` : 'a date'
  }
  if (/transactionSetPurposeCode$/.test(path)) return 'transmission purpose'
  if (/purchaseOrderNumber$/.test(path)) return 'PO number'
  if (/\.quantity$/.test(path)) return 'quantity'
  if (/unitPrice$/.test(path)) return 'unit price'
  if (/\.address|City|State|PostalCode|locationNumber/i.test(path)) return 'ship-to / location'
  return null
}

/** An X12 CCYYMMDD to something readable, and left alone when it is not one. */
export const x12Date = (v) =>
  (/^\d{8}$/.test(String(v || '')) ? `${String(v).slice(0, 4)}-${String(v).slice(4, 6)}-${String(v).slice(6, 8)}` : v)

/**
 * @param oldBody  the earlier /message body
 * @param newBody  the later one
 * @returns { identical, substantive[], envelope[], purpose, verdict, reworkLikely, counts }
 */
export function diff850(oldBody, newBody) {
  const A = flattenBody(oldBody || {})
  const B = flattenBody(newBody || {})
  const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()

  const substantive = []
  const envelope = []
  for (const path of keys) {
    if (JSON.stringify(A[path]) === JSON.stringify(B[path])) continue
    const row = { path, from: x12Date(A[path]) ?? null, to: x12Date(B[path]) ?? null }
    if (isEnvelope(path)) envelope.push(row)
    else substantive.push({ ...row, label: labelFor(path, newBody) })
  }

  // The purpose code, whether or not it changed — it is the headline either way.
  const purposeOf = (b) => b?.transactionSets?.[0]?.beginningSegmentForPurchaseOrder?.[0]?.transactionSetPurposeCode ?? null
  const from = purposeOf(oldBody)
  const to = purposeOf(newBody)
  const purpose = {
    from, to,
    fromLabel: PURPOSE_CODES[from] || (from ? `unknown code ${from}` : null),
    toLabel: PURPOSE_CODES[to] || (to ? `unknown code ${to}` : null),
    changed: from !== to,
  }

  // ⚠️ REWORK IS FLAGGED BY EITHER SIGNAL, NOT BOTH. A partner can send a
  // "duplicate" that moves a quantity — Nordstrom sent one that moved a date. So the
  // purpose code is not trusted alone; a substantive change to anything other than a
  // date counts too. An UNKNOWN purpose code also counts, because "we do not know
  // what they meant" must never resolve to "nothing to do".
  //
  // ⚠️ BUT THE PURPOSE FIELD ITSELF IS NOT ONE OF THOSE CHANGES, and getting that
  // wrong made this tool fail on the second of the two POs it was written for. PO
  // 50073688 went Original -> Duplicate, which is the REASSURING signal; counting it
  // as "a non-date change" flagged rework on an order that needed none. Its meaning
  // is interpreted above, by REWORK_PURPOSES — reading it twice, once as data and
  // once as an unexplained diff, is double-counting the one field we understand best.
  const rework = (s) => !/^transactionSets\.\d+\.beginningSegmentForPurchaseOrder\.\d+\.transactionSetPurposeCode$/.test(s.path)
    && (s.label === null || !/date|DTM/i.test(s.label))
  const nonDateChange = substantive.some(rework)
  const reworkLikely = REWORK_PURPOSES.has(to) || (to != null && !PURPOSE_CODES[to]) || nonDateChange

  return {
    identical: substantive.length === 0 && envelope.length === 0,
    substantive,
    envelope,
    purpose,
    reworkLikely,
    // Said out loud so nobody hunts for differences that were suppressed.
    counts: { fields: keys.length, substantive: substantive.length, envelope: envelope.length },
  }
}

/** One line a card can show without anyone reading the table. */
export function diff850Headline(d) {
  if (!d) return null
  if (d.identical) return 'Identical — not one field differs'
  const noise = d.counts.envelope ? `, ${d.counts.envelope} control-number field${d.counts.envelope === 1 ? '' : 's'} hidden` : ''
  if (!d.substantive.length) return `Nothing substantive changed${noise}`
  const what = d.substantive.map((s) => s.label || s.path).filter((v, i, a) => a.indexOf(v) === i)
  const lead = d.purpose.toLabel ? `${d.purpose.toLabel}: ` : ''
  return `${lead}${what.length} change${what.length === 1 ? '' : 's'} — ${what.slice(0, 3).join(', ')}${noise}`
}
