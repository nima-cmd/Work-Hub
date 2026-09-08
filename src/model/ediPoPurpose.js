// src/model/ediPoPurpose.js — what an 850 SAYS IT IS, and when that needs a person.
//
// ── ⚠️ WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// On 2026-09-08 Nordstrom CANCELLED PO 50073678 — fourteen days after we shipped
// it, and after they had accepted nine ASNs and nine invoices for it. The
// cancellation arrived, was stored, and was invisible: it parsed to `0 units, 1
// line` with no stores, so every surface in the app read it as an empty order and
// nothing was raised. Nima found it by asking why one of the repeat 850s looked
// blank.
//
// It was never blank. The X12 said exactly what it was, in the first element of
// its first segment:
//
//   BEG*01*SA*0008928906**20260409     transactionSetPurposeCode = 01 = CANCELLATION
//   PO1_loop: [{ baselineItemData: [{ assignedIdentification: "1" }] }]
//
// A cancellation REFERENCES its lines rather than restating them, so having no
// quantity is correct and expected. The document was right; we were not reading
// the field that said so.
//
// ⚠️ THE SAME FIELD ALSO EXPLAINED THE THING WE HAD MIS-DIAGNOSED. The five
// "identical re-sends" of that PO all carry purpose 07 — DUPLICATE. Nordstrom was
// deliberately re-sending copies, and the delivery_status = PENDING we had blamed
// was a separate, real, but unrelated problem. One unread field made a
// cancellation look like nothing and a duplicate look like a mystery.
//
// This is the register's classic shape, one turn further on: not a field that
// LIES, but a field never read at all — so its absence looked like an absence of
// news. See src/model/fieldAssumptions.js.

/**
 * X12 BEG01 / transaction set purpose codes, as the 850 uses them.
 *
 * ⚠️ THIS MAP IS NOT A WHITELIST. An unrecognised code is reported with its raw
 * value and treated as NEEDING ATTENTION, never dropped — the whole failure this
 * module exists to prevent was a real code going unread. A partner inventing
 * `ZZ` must not read as "nothing to see".
 */
export const PURPOSE_CODES = {
  '00': { label: 'Original', revision: false },
  '01': { label: 'Cancellation', revision: true },
  '02': { label: 'Add', revision: true },
  '03': { label: 'Delete', revision: true },
  '04': { label: 'Change', revision: true },
  '05': { label: 'Replace', revision: true },
  '06': { label: 'Confirmation', revision: false },
  '07': { label: 'Duplicate', revision: false },
  '22': { label: 'Information Copy', revision: false },
}

/** Codes that CHANGE an order we may already be acting on. */
export const REVISION_CODES = Object.keys(PURPOSE_CODES).filter((c) => PURPOSE_CODES[c].revision)

const clean = (v) => String(v ?? '').trim()

/**
 * Describe one purpose code.
 *
 * @returns { code, label, revision, known }
 *   code     the raw value, always — a code we cannot name is still evidence
 *   revision does this document alter an order? (drives the warning)
 *   known    is it in the table above?
 */
export function describePurpose(raw) {
  const code = clean(raw)
  if (!code) {
    // ⚠️ ABSENT IS NOT "ORIGINAL". Defaulting a missing BEG01 to 00 would assert a
    // fact the document never carried — the [[default-is-not-an-answer]] rule. An
    // 850 with no purpose code is a parse we do not understand, so it is flagged.
    return { code: null, label: 'not stated', revision: false, known: false }
  }
  const hit = PURPOSE_CODES[code]
  if (hit) return { code, label: hit.label, revision: hit.revision, known: true }
  // ⚠️ Unknown codes are treated as revisions. Being wrong towards "look at this"
  // costs a glance; being wrong the other way is how the cancellation was missed.
  return { code, label: `unrecognised (${code})`, revision: true, known: false }
}

/**
 * Should a person look at this 850?
 *
 * @param purposeCode  BEG01 as transmitted
 * @param facts.shipped   have we shipped any of this PO?
 * @param facts.invoiced  have we invoiced any of it?
 *
 * ⚠️ THE SEVERITY COMES FROM WHAT WE ALREADY DID, NOT FROM THE CODE ALONE. A
 * cancellation on a PO still sitting in Pending Fulfillment is ordinary business
 * — you close the order and move on. The SAME code against freight already on a
 * truck and already invoiced is a money conversation, and the two must not read
 * alike. 50073678 was the second kind and the app said nothing at all.
 *
 * ⚠️ `shipped`/`invoiced` are INPUTS, never derived here. This module is pure so
 * it can be tested, and the shipped/invoiced facts live in Postgres — deriving
 * them here would put a second, disagreeing definition of "shipped" in the repo.
 */
export function purposeAlert(purposeCode, { shipped = false, invoiced = false } = {}) {
  const p = describePurpose(purposeCode)
  if (!p.revision) return null
  const acted = shipped || invoiced
  const did = [shipped && 'shipped', invoiced && 'invoiced'].filter(Boolean).join(' and ')
  return {
    ...p,
    severity: acted ? 'critical' : 'notice',
    // Written to be read by someone who has not seen this module. It names the
    // code, what it means, and why it matters HERE.
    message: acted
      ? `WARNING: purpose ${p.code} (${p.label}) received for a PO we have already ${did}. `
        + 'The partner is altering an order we have acted on — confirm before crediting or re-picking.'
      : `Purpose ${p.code} (${p.label}) — the partner is altering this PO. Nothing has shipped yet.`,
  }
}

/**
 * The rows worth surfacing, newest first.
 *
 * @param rows [{ id, businessNumber, createdAt, purposeCode, shipped, invoiced }]
 *
 * ⚠️ DUPLICATES AND ORIGINALS ARE DELIBERATELY NOT LISTED. Measured on the live
 * data 2026-09-08: PO 50073678 alone had five purpose-07 re-sends against one
 * purpose-01 cancellation. A list that includes the 07s buries the one row that
 * matters under the noise that caused the confusion in the first place.
 */
export function purposeAlerts(rows = []) {
  return rows
    .map((r) => {
      const alert = purposeAlert(r.purposeCode ?? r.po_purpose_code, {
        shipped: !!(r.shipped), invoiced: !!(r.invoiced),
      })
      return alert ? { ...alert, id: r.id, businessNumber: r.businessNumber ?? r.business_number, createdAt: r.createdAt ?? r.created_at } : null
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    })
}
