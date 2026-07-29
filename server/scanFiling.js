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
import { uploadScannedPdf } from '../src/ingest/googleDrive.js'

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

// Classify one QR payload with DB authority. DC:<po>:<abbrev> → per-DC EDI; a
// bare number that matches a known open PO → PO-level EDI; anything else →
// boutique (format still TBD — passed through for the caller to flag).
async function classify(qr, knownPos) {
  const s = String(qr || '').trim()
  const dc = parseDcToken(s)
  if (dc) return { kind: 'edi', po: dc.poNumber, dc: dc.dc, partner: partnerForDc(dc.dc || '') }
  if (knownPos.has(s)) return { kind: 'edi', po: s, dc: null, partner: await partnerForPo(s) }
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
      warnings.push(`Boutique QR "${c.raw}" — boutique filing not built yet, skipped.`)
      documents.push({ kind: 'boutique', qr: seg.qr, raw: c.raw, pageNums: seg.pageNums, skip: true })
      continue
    }
    if (!c.partner) warnings.push(`PO ${c.po}: couldn't resolve partner — will file under _Unresolved.`)
    const partner = c.partner || '_Unresolved'
    const filename = c.dc ? `${c.po}-${c.dc}.pdf` : `${c.po}.pdf`
    documents.push({ kind: 'edi', po: c.po, dc: c.dc, partner, pos: [c.po], filename, pageNums: seg.pageNums, qr: seg.qr })
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

  return { documents, master, warnings }
}

// Upload one already-resolved split to Drive. Called once per document so each
// stays well under the JSON body limit and the UI can show per-file progress.
//   { partner, pos: [poFolders], filename, pdfBase64 }
export async function fileScannedDoc({ partner, pos, filename, pdfBase64 }) {
  if (!partner || !pos?.length || !filename || !pdfBase64) {
    throw new Error('partner, pos, filename and pdfBase64 are required')
  }
  const buffer = Buffer.from(pdfBase64, 'base64')
  return uploadScannedPdf({ partner, pos, filename, buffer })
}
