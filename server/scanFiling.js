// scanFiling.js — server side of the Scanner→Drive feature. The client rasters
// the multi-page scan, decodes the QR on each page, and segments it into
// documents (a QR page + the QR-less pages that follow it, until the next QR).
// Here we AUTHORITATIVELY classify each document (using the live PO list to tell
// an old bare-PO label from a boutique QR), resolve the trading partner and the
// master BOL number, and file the splits to the same /Work-Hub BOLs/<partner>/
// <PO>/ tree the digital BOLs use (Nima, 2026-07-29 — signed paper next to the
// app's PDFs). See [[work-hub-edi-routing-bol]].

import { pool } from '../src/db.js'
import { parseDcToken, partnerForDc } from '../src/model/dc.js'
import { transferFilingFolder } from '../src/model/transferOrder.js'
import { uploadScannedPdf, DRIVE_ROOT_BOLS, DRIVE_ROOT_SLIPS } from '../src/ingest/googleDrive.js'
import { scanFilename, findFilingCollisions } from '../src/model/scanSegments.js'
import { filingTarget, filingNote, FILED_EVENT } from '../src/model/filing.js'
import { insertOrderEvent } from '../src/ingest/loadToDb.js'

// A Drive folder name can't carry a slash, and a customer name legitimately can
// ("Wexner: Joseph - Jackson"). Strip only what Drive/paths can't take, and keep
// the rest verbatim so the folder still reads like the customer.
const safeFolder = (s) => String(s || '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim()

// Partner for a PO with no DC on its tag (the old bare-PO labels): read it off
// the order's customer. EDI POs are Bloomingdale's unless the customer clearly
// says Nordstrom.
async function partnerForPo(po) {
  const { rows } = await pool.query(
    `SELECT customer FROM orders WHERE po_number = $1 AND customer IS NOT NULL LIMIT 1`, [po])
  const cust = rows[0]?.customer || ''
  if (/nordstrom/i.test(cust)) return 'Nordstrom'
  if (/bloomingdale/i.test(cust)) return "Bloomingdale's"
  return null // unknown — surfaced as a warning, filed under _Unresolved
}

// An IF number off the NetSuite packing slip's footer QR (2026-07-31).
//
// The slip is the SAME template for every channel, so the payload is deliberately
// just the fulfilment number and this is where the channel is decided.
// `fulfillment_dc` holds one row per IF and contains ONLY EDI fulfilments — 2,246
// rows, every one with a DC, zero boutique — because it is built from
// custbody_po_cd_identifier, which only EDI fulfilments carry. So presence in
// that table IS the channel test, and it needs no new field on the print template.
//
// ⚠️ That table is filled incrementally by the ~90-minute sync, so a fulfilment
// created and scanned within the same hour may not be there yet and would read as
// boutique. The caller surfaces that as a warning naming the fix (press Refresh
// NetSuite) rather than silently filing it to the wrong place.
async function resolveFulfilment(ifNumber) {
  const { rows } = await pool.query(
    'SELECT po_number, dc FROM fulfillment_dc WHERE if_number = $1', [ifNumber])
  if (!rows.length) return null
  const po = rows[0].po_number
  const dc = rows[0].dc || null
  // Partner from the PO's own customer first. partnerForDc is a shape heuristic
  // (digits → Nordstrom, else Bloomingdale's) and fulfillment_dc carries codes it
  // gets wrong — 'SBX2' is ShopBop but reads as Bloomingdale's. A null partner
  // files under _Unresolved with a warning, which beats a confident wrong folder.
  const partner = (await partnerForPo(po)) || (dc ? partnerForDc(dc) : null)
  return { kind: 'edi', po, dc, partner, ifNumber }
}

// Classify one QR payload with DB authority. DC:<po>:<abbrev> → per-DC EDI; a
// bare number that matches a known open PO → PO-level EDI; IF<n> → look up the
// channel; anything else → boutique (format still TBD).
async function classify(qr, knownPos) {
  const s = String(qr || '').trim()
  const dc = parseDcToken(s)
  if (dc) return { kind: 'edi', po: dc.poNumber, dc: dc.dc, partner: partnerForDc(dc.dc || '') }
  if (knownPos.has(s)) return { kind: 'edi', po: s, dc: null, partner: await partnerForPo(s) }
  // ⚠️ A BOL RESOLVES BY LOOKUP, NEVER BY PARSE. The tag carries only the BOL
  // number — deliberately, so the same code wedge-scans into NetSuite's BOL field
  // for the ASN — and `bol_registry` is the authority on which partner, PO and DC
  // that number was minted for. Parsing a PO out of the tag would re-create the
  // very guess this lookup removes.
  if (/^NB\d+$/i.test(s)) {
    const bolNumber = s.toUpperCase()
    const { rows } = await pool.query(
      `SELECT partner, dc, member_pos FROM bol_registry WHERE bol_number = $1`, [bolNumber])
    if (!rows.length) return { kind: 'bol', bolNumber, po: null, dc: null, partner: null, known: false }
    // ⚠️ member_pos CAN HOLD SEVERAL POs — a DC's BOL consolidates them. The FIRST
    // is the filing folder (that is how the digital BOL already files); the rest
    // ride along so nothing is lost, and the UI can show what else is covered.
    const memberPos = rows[0].member_pos || []
    return {
      kind: 'bol', bolNumber, known: true,
      po: memberPos[0] || null, dc: rows[0].dc || null,
      partner: rows[0].partner || (rows[0].dc ? partnerForDc(rows[0].dc) : null),
      memberPos,
    }
  }
  if (/^IF\d+$/i.test(s)) {
    const ifNumber = s.toUpperCase()
    const edi = await resolveFulfilment(ifNumber)
    if (edi) return edi
    // Known fulfilment, no EDI mapping → boutique. Named, not just "unknown QR".
    //
    // ⚠️ A TRANSFER'S PARENT IS NOT IN `orders`, so `customer` comes back null and the
    // filing guard below skips it — correctly, but uselessly. A transfer has a
    // DESTINATION instead, and Nima named where each one files:
    // Office → Boutiques/Naghedi, Consignment → Boutiques/Consignment.
    const { rows } = await pool.query(
      `SELECT f.so_number, o.customer, o.po_number, t.destination
         FROM fulfillments f
         LEFT JOIN orders o ON o.so_number = f.so_number
         LEFT JOIN transfer_order t ON t.to_number = f.so_number
        WHERE f.if_number = $1`, [ifNumber])
    const destination = rows[0]?.destination || null
    return {
      kind: 'boutique', raw: s, po: null, dc: null, partner: null,
      ifNumber,
      soNumber: rows[0]?.so_number || null,
      customer: rows[0]?.customer || null,
      customerPo: rows[0]?.po_number || null,
      // ⚠️ NOT written into `customer`. Naming a place as the customer is the kind of
      // field-that-lies this repo keeps paying for — the filing folder is its own
      // field, and null when the destination is one nobody has mapped.
      isTransfer: !!destination,
      destination,
      filingFolder: destination ? transferFilingFolder(destination) : null,
      known: rows.length > 0,
    }
  }
  return { kind: 'boutique', raw: s, po: null, dc: null, partner: null }
}

// Best-effort master BOL number for a set of covered POs: the routing_auth whose
// shipments' member POs overlap the scan the most. The user confirms/edits it in
// the UI (the master page has the number printed but carries no QR to read).
async function suggestMasterBol(coveredPos) {
  if (!coveredPos.length) return null
  const { rows } = await pool.query(
    `SELECT ra.master_bol_number AS bol, array_agg(DISTINCT p) AS pos
       FROM routing_auth ra
       JOIN routing_shipment rs ON rs.auth_number = ra.auth_number
       CROSS JOIN LATERAL unnest(rs.member_pos) AS p
      WHERE ra.master_bol_number IS NOT NULL
      GROUP BY ra.master_bol_number`)
  const want = new Set(coveredPos)
  let best = null
  for (const r of rows) {
    const overlap = r.pos.filter((p) => want.has(p)).length
    if (overlap > 0 && (!best || overlap > best.overlap)) best = { bol: r.bol, overlap }
  }
  return best?.bol || null
}

// Build the filing plan from the client's segmentation (no file bytes yet —
// small payload the UI renders for confirmation before any upload).
//   segments: [{ qr: string|null, pageNums: number[], orphan?: bool }]
// A leading orphan (QR-less pages before the first QR) is the signed Master BOL.
export async function planScanFiling(segments = []) {
  const { rows } = await pool.query(`SELECT DISTINCT po_number FROM orders WHERE po_number IS NOT NULL`)
  const knownPos = new Set(rows.map((r) => String(r.po_number)))

  const documents = []
  const warnings = []
  for (const seg of segments) {
    if (seg.orphan || !seg.qr) continue // handled as the master below
    const c = await classify(seg.qr, knownPos)
    if (c.kind === 'boutique') {
      // Boutique slips file to Packing Slips/<customer>/<SO>/ (Nima, 2026-07-31).
      // Customer first because that's how you'd go looking for one; the SO level
      // keeps a split shipment's fulfilments together (IF7441 and IF7452 for the
      // same order sit side by side).
      //
      // Filed only when we can NAME both levels. Anything else stays skipped
      // rather than inventing a folder — a slip in the wrong place is harder to
      // find than one that was never filed and said so.
      // A transfer files under the folder Nima named for its destination; everything
      // else under its customer. Both land in Boutiques/<folder>/<order>/.
      const folder = c.filingFolder || c.customer
      if (c.ifNumber && folder && c.soNumber) {
        documents.push({
          kind: 'slip', root: DRIVE_ROOT_SLIPS,
          partner: safeFolder(folder), pos: [c.soNumber],
          filename: `${c.ifNumber}.pdf`,
          customer: c.customer, soNumber: c.soNumber, ifNumber: c.ifNumber,
          isTransfer: !!c.isTransfer, destination: c.destination || null,
          customerPo: c.customerPo || null, pageNums: seg.pageNums, qr: seg.qr,
        })
        continue
      }
      if (c.ifNumber) {
        warnings.push(
          c.known
            ? (c.isTransfer
              // ⚠️ Names the real reason. "Couldn't resolve the customer" is nonsense
              // for a transfer — it has none — and would send someone hunting for one.
              ? `${c.ifNumber} — transfer to ${c.destination}, which has no filing folder mapped. Add it to transferFilingFolder rather than filing it somewhere wrong.`
              : `${c.ifNumber} — couldn't resolve ${!c.customer ? 'the customer' : 'its sales order'}, so it was skipped rather than filed somewhere wrong.`)
            : `${c.ifNumber} isn't in the app yet — if you just created it, press ↻ Refresh NetSuite and re-scan; otherwise check the number.`,
        )
      } else {
        warnings.push(`Unrecognised QR "${c.raw}" — skipped.`)
      }
      documents.push({
        kind: 'boutique', qr: seg.qr, raw: c.raw, pageNums: seg.pageNums, skip: true,
        ifNumber: c.ifNumber || null, soNumber: c.soNumber || null,
        customer: c.customer || null, customerPo: c.customerPo || null, known: c.known ?? null,
      })
      continue
    }
    if (c.kind === 'bol') {
      // ⚠️ AN UNKNOWN BOL IS NEVER FILED ON THE STRENGTH OF ITS OWN TAG. `NB…` is a
      // shape, not proof: a mis-keyed or hand-written number would otherwise mint a
      // folder for a shipment that does not exist. The registry is the only thing
      // that can say a BOL is ours.
      if (!c.known || !c.po) {
        warnings.push(`${c.bolNumber} isn't in the BOL registry — skipped rather than filed under a PO we'd be guessing at.`)
        documents.push({ kind: 'bol', qr: seg.qr, bolNumber: c.bolNumber, pageNums: seg.pageNums, skip: true, known: false })
        continue
      }
      if (!c.partner) warnings.push(`${c.bolNumber}: couldn't resolve partner — will file under _Unresolved.`)
      documents.push({
        kind: 'bol', bolNumber: c.bolNumber,
        po: c.po, dc: c.dc, partner: c.partner || '_Unresolved', pos: [c.po],
        filename: scanFilename({ po: c.po, dc: c.dc, bolNumber: c.bolNumber }),
        root: DRIVE_ROOT_BOLS, memberPos: c.memberPos || [],
        // The carrier's own tracking number, read off the same page. Carried to the
        // UI for confirmation — never written as fact from a barcode alone.
        proNumbers: seg.proNumbers || [],
        pageNums: seg.pageNums, qr: seg.qr,
      })
      continue
    }
    if (!c.partner) warnings.push(`PO ${c.po}: couldn't resolve partner — will file under _Unresolved.`)
    const partner = c.partner || '_Unresolved'
    // The IF goes IN the name — PO+DC is only the folder, and one PO/DC pair
    // carries several fulfilments (see scanFilename). Without it, PO 7776940's
    // 15 slips shared 5 names and would have overwritten each other silently.
    const filename = scanFilename({ po: c.po, dc: c.dc, ifNumber: c.ifNumber })
    documents.push({
      kind: 'edi', po: c.po, dc: c.dc, partner, pos: [c.po], filename,
      root: DRIVE_ROOT_BOLS,
      pageNums: seg.pageNums, qr: seg.qr, ifNumber: c.ifNumber || null,
    })
  }

  // Master BOL = the leading orphan pages. Covers every EDI PO in the scan; a
  // copy is filed into each of those PO folders.
  const orphan = segments.find((s) => s.orphan || !s.qr)
  let master = null
  if (orphan && orphan.pageNums?.length) {
    const coveredPos = [...new Set(documents.filter((d) => d.kind === 'edi').map((d) => d.po))]
    const partners = [...new Set(documents.filter((d) => d.kind === 'edi').map((d) => d.partner))]
    const partner = partners.length === 1 ? partners[0] : (partners[0] || '_Unresolved')
    const suggestedBol = await suggestMasterBol(coveredPos)
    master = {
      pageNums: orphan.pageNums,
      coveredPos,
      pos: coveredPos,
      partner,
      suggestedBol,
      filename: suggestedBol ? `${suggestedBol} master BOL.pdf` : null,
    }
    if (partners.length > 1) warnings.push('Master BOL spans multiple partners — filing under ' + partner + '.')
    if (!suggestedBol) warnings.push('No matching master BOL number found — enter it from the page before filing.')
  }

  // Two documents aiming at one path would overwrite each other and BOTH report
  // success. Catch it before any bytes move, and mark the later ones so the
  // upload refuses them — a lost slip that looked filed is the worst outcome
  // here, worse than a slip that says it needs attention.
  for (const clash of findFilingCollisions(documents)) {
    const [keep, ...rest] = clash.documents
    for (const d of rest) {
      d.skip = true
      d.collision = clash.filename
    }
    warnings.push(
      `${clash.documents.length} documents resolve to the same file "${clash.filename}" — ` +
      `filing the first (${keep.qr || keep.ifNumber || 'page ' + keep.pageNums?.[0]}) and holding the rest ` +
      `rather than overwriting. Check whether the same slip was scanned twice.`,
    )
  }

  return { documents, master, warnings }
}

// Upload one already-resolved split to Drive. Called once per document so each
// stays well under the JSON body limit and the UI can show per-file progress.
//   { partner, pos: [poFolders], filename, pdfBase64, ifNumber, soNumber, po, dc }
//
// The identity fields are the ones `planScanFiling` already resolved and handed
// the client; they come back so the filing can be recorded against the right
// document. They are re-checked here rather than trusted — see recordFiling.
export async function fileScannedDoc({ partner, pos, filename, pdfBase64, root, ...doc }) {
  if (!partner || !pos?.length || !filename || !pdfBase64) {
    throw new Error('partner, pos, filename and pdfBase64 are required')
  }
  // Only the two known trees — never a caller-supplied path.
  const target = root === DRIVE_ROOT_SLIPS ? DRIVE_ROOT_SLIPS : DRIVE_ROOT_BOLS
  const buffer = Buffer.from(pdfBase64, 'base64')
  const result = await uploadScannedPdf({ partner, pos, filename, buffer, root: target })
  // ⚠️ ONLY on a real success. uploadScannedPdf SOFT-FAILS — it returns
  // `{ ok:false, … }` instead of throwing (that's the #25 resilience layer), so
  // an `await` that didn't throw is NOT evidence the bytes landed. Recording a
  // filing off a soft failure would mark a shipment done and remove it from the
  // very queue meant to catch it. This is the "grep the callers for
  // else-assumes-success" trap from [[packing-slip-qr]], one round later.
  if (result?.ok) {
    const filed = await recordFiling({ ...doc, partner, pos, filename })
    if (filed) result.filed = filed
    const pro = await recordProNumber(doc)
    if (pro) result.pro = pro
  }
  return result
}

/**
 * Attach the carrier's tracking number to the shipment its BOL belongs to.
 *
 * ⚠️ NEVER OVERWRITES ONE WE ALREADY HOLD. A PRO is the number you quote to chase
 * freight; if the stored one and a freshly-read one disagree, a barcode read off a
 * photocopy is not automatically the better answer. It fills a blank and otherwise
 * reports the conflict, which is a person's call.
 *
 * ⚠️ Never throws, for the same reason recordFiling doesn't: the paper is already
 * in Drive, and a bookkeeping miss must not turn a successful filing red.
 */
async function recordProNumber({ bolNumber, proNumbers } = {}) {
  try {
    const bol = String(bolNumber || '').trim().toUpperCase()
    const pros = (proNumbers || []).map((p) => String(p || '').trim().toUpperCase()).filter(Boolean)
    if (!bol || pros.length !== 1) {
      // ⚠️ TWO CANDIDATES IS NOT A NUMBER. A page carrying two unknown barcodes
      // gives no basis to prefer one, and guessing puts a wrong tracking number on
      // a real shipment. Say nothing rather than pick.
      return pros.length > 1 ? { bolNumber: bol, ambiguous: pros } : null
    }
    const { rows } = await pool.query(
      `UPDATE routing_shipment
          SET pro_number = $2, pro_source = 'scan', pro_captured_at = now(), updated_at = now()
        WHERE bol_number = $1 AND pro_number IS NULL
        RETURNING pro_number`, [bol, pros[0]])
    if (rows.length) return { bolNumber: bol, proNumber: pros[0], stored: true }
    const cur = await pool.query('SELECT pro_number FROM routing_shipment WHERE bol_number = $1', [bol])
    if (!cur.rows.length) return null
    const held = cur.rows[0].pro_number
    return held === pros[0]
      ? { bolNumber: bol, proNumber: held, stored: false }
      : { bolNumber: bol, proNumber: held, conflict: pros[0] }
  } catch { return null }
}

// Write the FILED event for one uploaded document.
//
// Never throws: the paper is already in Drive by the time we get here, and a
// bookkeeping failure must not turn a successful upload into a red row the user
// will re-scan. A missed event shows up as a still-unfiled shipment, which is
// the safe direction to be wrong in.
async function recordFiling(doc) {
  try {
    const target = filingTarget(doc)
    if (!target) return null // master BOL, or a document with no resolvable identity
    // Don't invent a document. The client supplies these, and while the server
    // resolved them a moment ago in planScanFiling, an event pointing at an IF
    // that doesn't exist would sit in the ledger forever with nothing to join to.
    if (target.docType === 'IF') {
      const { rows } = await pool.query(
        'SELECT so_number FROM fulfillments WHERE if_number = $1', [target.docNumber])
      if (!rows.length) return null
      target.soNumber = target.soNumber || rows[0].so_number || null
    }
    // One FILED per document, ever. Re-filing a corrected scan overwrites the
    // Drive file (and the UI says "replaced an existing file"), but the paper
    // was already filed — a second event would just double-count the day's work.
    const exists = await pool.query(
      `SELECT 1 FROM order_events WHERE event_type = $1 AND doc_type = $2 AND doc_number = $3`,
      [FILED_EVENT, target.docType, target.docNumber],
    )
    if (exists.rowCount) return { ...target, repeat: true }
    const event = await insertOrderEvent({
      eventType: FILED_EVENT,
      docType: target.docType,
      docNumber: target.docNumber,
      soNumber: target.soNumber,
      note: filingNote(doc),
      source: 'scan',
    })
    return { ...target, occurredAt: event.occurredAt }
  } catch {
    return null
  }
}
