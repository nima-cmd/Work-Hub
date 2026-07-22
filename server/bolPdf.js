// server/bolPdf.js — VICS Bill of Lading laid out to match the Macy's Routing
// Guide examples (§13.2 rev 4/14/26). One form serves both roles:
//   kind 'final'  — one BOL per final destination DC; ship-to names the DC and
//                   addresses the assigned 1:1 Merge Center; transmitted on the
//                   EDI 856.
//   kind 'master' — one Master BOL per authorization to the merge center,
//                   aggregating every underlying DC's POs; the Master BOL number
//                   is NOT transmitted on the 856 and its Special Instructions
//                   say "MASTER BOL – SEE UNDERLYING BOL'S FOR EACH FINAL DC".
// Nordstrom ships direct to its DC (kind 'final', no merge center).
//
// Freight terms are COLLECT (or 3rd Party for RXO/XLTL) per the guide — never
// prepaid. buildBolPdf(shipment) → Promise<Buffer>; renderBolTo(res, shipment).

import PDFDocument from 'pdfkit'
import { dcLabel } from '../src/model/dc.js'
import { SHIP_FROM, COMMODITY, shipToFor } from '../src/model/bolAddresses.js'

const M = 24
const RED = '#c00'

const L = {
  liability: 'NOTE: Liability Limitation for loss or damage in this shipment may be applicable. See 49 U.S.C. 14706(c)(1)(A) and (B).',
  received: 'RECEIVED, subject to individually determined rates or contracts that have been agreed upon in writing between the carrier and shipper, if applicable, otherwise to the rates, classifications and rules that have been established by the carrier and are available to the shipper, on request, and to all applicable state and federal regulations.',
  carrierDelivery: 'The carrier shall not make delivery of this shipment without payment of freight and all other lawful charges.',
  shipperCert: 'This is to certify that the above named materials are properly classified, described, packaged, marked and labeled, and are in proper condition for transportation according to the applicable regulations of the U.S. DOT.',
  carrierCert: 'Carrier acknowledges receipt of packages and required placards. Carrier certifies emergency response information was made available and/or carrier has the U.S. DOT emergency response guidebook or equivalent documentation in the vehicle. Property described above is received in good order, except as noted.',
  value: 'Where the rate is dependent on value, shippers are required to state specifically in writing the agreed or declared value of the property as follows: "The agreed or declared value of the property is specifically stated by the shipper to be not exceeding ______ per ______."',
  masterNote: "MASTER BOL – SEE UNDERLYING BOL'S FOR EACH FINAL DC",
  finalFoot: 'Final destination Bill of Lading (BOL) — BOL number to final destination DC must be transmitted on EDI 856 (ASN). "Ship To" Name must match the format noted above.',
  masterFoot: 'Master Bill of Lading (BOL) — BOL number for Master BOL to routing destination is NOT TRANSMITTED on EDI 856 (ASN). "Ship To" Name must match the format noted above.',
}

export function buildBolPdf(shipment, opts = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: M })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      render(doc, shipment, opts.kind || shipment.kind || 'final')
      doc.end()
    } catch (e) { reject(e) }
  })
}

export async function renderBolTo(res, shipment, opts = {}) {
  const pdf = await buildBolPdf(shipment, opts)
  res.setHeader('Content-Type', 'application/pdf')
  const tag = (opts.kind || shipment.kind) === 'master' ? 'MASTER' : shipment.dc
  res.setHeader('Content-Disposition', `inline; filename="BOL_${shipment.bolNumber || 'draft'}_${tag}.pdf"`)
  res.send(pdf)
}

function render(doc, shipment, kind) {
  const W = doc.page.width - M * 2
  const half = W / 2
  const rX = M + half
  const isMaster = kind === 'master'
  const label = dcLabel(shipment.dc)
  const { block: shipTo, missing } = shipToFor(shipment.partner, shipment.dc, label, {
    kind, mergeCenter: shipment.mergeCenter || 'CA',
  })
  // Freight terms: Collect, unless the carrier is RXO (XLTL) → 3rd Party.
  const term = /XLTL|RXO/i.test(`${shipment.scac || ''} ${shipment.carrier || ''}`) ? '3rd' : 'Collect'
  let y = M

  // ── Header ──────────────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(7).fillColor('#000')
    .text(shipment.shipDate ? `Date: ${String(shipment.shipDate).slice(0, 10)}` : 'Date:', M, y + 3)
  doc.font('Helvetica-Bold').fontSize(9).text('Page ______', rX, y + 3, { width: half, align: 'right' })
  y += 16

  // ── Ship From | Bill of Lading Number + barcode ─────────────────────────
  const topH = 66
  blackBar(doc, M, y, half, 'SHIP FROM')
  boxOutline(doc, M, y + 11, half, topH - 11)
  addrLines(doc, M, y + 13, half, SHIP_FROM, [])
  fob(doc, M + half - 42, y + topH - 12)
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('SID#', M + 3, y + topH - 12)
  boxOutline(doc, rX, y + 11, half, topH - 11)
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#000').text('Bill of Lading Number:', rX + 4, y + 15)
  doc.font('Helvetica-Bold').fontSize(12).fillColor(RED).text(shipment.bolNumber || '—', rX + 4, y + 24)
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#ccc').text('B A R   C O D E   S P A C E', rX + 4, y + 46, { width: half - 8, align: 'center' })
  y += topH + 3

  // ── Ship To | Carrier block ─────────────────────────────────────────────
  const midH = 78
  blackBar(doc, M, y, half, 'SHIP TO')
  boxOutline(doc, M, y + 11, half, midH - 11)
  addrLines(doc, M, y + 13, half, shipTo, missing, true)
  fob(doc, M + half - 42, y + midH - 12)
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('CID#', M + 3, y + midH - 12)
  boxOutline(doc, rX, y + 11, half, midH - 11)
  const carr = [['CARRIER NAME:', shipment.carrier || '', true], ['Trailer number:', shipment.trailerNumber || ''], ['Seal number(s):', shipment.sealNumber || ''], ['SCAC:', shipment.scac || '', true], ['Pro number:', '']]
  let cy = y + 14
  for (const [lab, val, red] of carr) {
    doc.font('Helvetica').fontSize(6.5).fillColor('#000').text(lab, rX + 4, cy, { continued: true })
    doc.font('Helvetica-Bold').fontSize(8).fillColor(red && val ? RED : '#000').text('  ' + (val || ''))
    cy += 12
  }
  y += midH + 3

  // ── Third party bill-to | Freight charge terms ───────────────────────────
  const tpH = 54
  blackBar(doc, M, y, half, 'THIRD PARTY FREIGHT CHARGES BILL TO')
  boxOutline(doc, M, y + 11, half, tpH - 11)
  doc.font('Helvetica').fontSize(6.5).fillColor('#000')
    .text('Name:', M + 4, y + 15).text('Address:', M + 4, y + 27).text('City/State/Zip:', M + 4, y + 41)
  boxOutline(doc, rX, y + 11, half, tpH - 11)
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text('Freight Charge Terms:', rX + 4, y + 14, { continued: true })
    .font('Helvetica-Oblique').fontSize(6).text('  (freight charges are prepaid unless marked otherwise)')
  const box3 = (x, on, lab) => {
    doc.rect(x, y + 27, 7, 7).lineWidth(0.6).stroke('#000')
    if (on) doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text('X', x + 1.3, y + 27.5)
    doc.font('Helvetica').fontSize(7).fillColor('#000').text(lab, x + 9, y + 27.5)
    return x + 9 + doc.widthOfString(lab) + 12
  }
  let bx = box3(rX + 4, term === 'Prepaid', 'Prepaid')
  bx = box3(bx, term === 'Collect', 'Collect')
  box3(bx, term === '3rd', '3rd Party')
  doc.rect(rX + 4, y + 40, 7, 7).lineWidth(0.6).stroke('#000')
  if (isMaster) doc.font('Helvetica-Bold').fontSize(7).text('X', rX + 5.3, y + 40.5)
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('Master Bill of Lading: with attached underlying Bills of Lading', rX + 14, y + 40, { width: half - 18 })
  y += tpH + 3

  // ── Special Instructions ─────────────────────────────────────────────────
  const siH = isMaster ? 34 : 24
  boxOutline(doc, M, y, W, siH)
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000').text('SPECIAL INSTRUCTIONS:', M + 4, y + 3)
  doc.font('Helvetica-Bold').fontSize(9).fillColor(RED)
    .text(`Macy's Auth / Appt # ${shipment.authNumber || '________'}`, M + 4, y + 12)
  if (isMaster) doc.font('Helvetica-Bold').fontSize(8).fillColor(RED).text(L.masterNote, M + 4, y + 23)
  y += siH + 3

  // ── Customer Order Information ────────────────────────────────────────────
  const items = (shipment.lineItems && shipment.lineItems.length)
    ? shipment.lineItems
    : (shipment.memberPos || []).map((po) => ({ po, cartons: '', weight: '' }))
  const rowsN = Math.max(items.length, 3)
  sectionBar(doc, M, y, W, 'CUSTOMER ORDER INFORMATION')
  const cCols = [W * 0.42, W * 0.08, W * 0.14, W * 0.20, W * 0.16]
  gridHeader(doc, M, y + 11, cCols, ['CUSTOMER ORDER NUMBER', '# PKGS', 'WEIGHT', 'PALLET / SLIP (CIRCLE ONE)', 'ADDITIONAL SHIPPER INFO'])
  let ry = y + 11 + 15
  for (let i = 0; i < rowsN; i++) {
    const it = items[i]
    gridRow(doc, M, ry, cCols, [it ? String(it.po) : '', it ? String(it.cartons ?? '') : '', it ? String(it.weight ?? '') : '', it ? 'Y        N' : '', ''], false, RED)
    ry += 15
  }
  gridRow(doc, M, ry, cCols, ['GRAND TOTAL', String(shipment.cartons ?? ''), String(shipment.weightLb ?? ''), '', ''], true, RED)
  y = ry + 15 + 3

  // ── Carrier Information ───────────────────────────────────────────────────
  sectionBar(doc, M, y, W, 'CARRIER INFORMATION')
  const kCols = [W * 0.08, W * 0.08, W * 0.08, W * 0.09, W * 0.10, W * 0.07, W * 0.34, W * 0.16]
  gridHeader(doc, M, y + 11, kCols, ['H.U. QTY', 'TYPE', 'PKG QTY', 'TYPE', 'WEIGHT', 'H.M.(X)', 'COMMODITY DESCRIPTION', 'LTL ONLY  NMFC# / CLASS'])
  const kr = y + 11 + 15
  gridRow(doc, M, kr, kCols, ['', '', String(shipment.cartons ?? ''), 'Cartons', String(shipment.weightLb ?? ''), '', COMMODITY.description, `${COMMODITY.nmfc || ''} / ${COMMODITY.class}`], false, RED)
  gridRow(doc, M, kr + 15, kCols, ['', '', String(shipment.cartons ?? ''), '', String(shipment.weightLb ?? ''), 'GRAND TOTAL', `Cubic ft ${shipment.cubicFeet ?? '—'}  ·  Units ${shipment.units ?? '—'}`, ''], true, RED)
  y = kr + 30 + 3

  // ── Value / COD ───────────────────────────────────────────────────────────
  const vH = 34
  boxOutline(doc, M, y, half, vH)
  doc.font('Helvetica').fontSize(5).fillColor('#000').text(L.value, M + 3, y + 3, { width: half - 6 })
  boxOutline(doc, rX, y, half, vH)
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text('COD Amount: $ ____________________', rX + 4, y + 4)
  // Draw real checkboxes (the ☐ glyph isn't in pdfkit's base font).
  const chk = (x, yy, lab) => {
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#000').text(lab, x, yy, { continued: false })
    const bx = x + doc.widthOfString(lab) + 2
    doc.rect(bx, yy, 6, 6).lineWidth(0.5).stroke('#000')
    return bx + 12
  }
  const fx = chk(rX + 4, y + 16, 'Fee Terms:  Collect:')
  chk(fx, y + 16, 'Prepaid:')
  chk(rX + 4, y + 26, 'Customer check acceptable:')
  y += vH + 2

  // ── Liability note band ───────────────────────────────────────────────────
  boxOutline(doc, M, y, W, 12)
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000').text(L.liability, M + 3, y + 3, { width: W - 6 })
  y += 14

  // ── Received / carrier delivery ─────────────────────────────────────────
  const rcH = 26
  boxOutline(doc, M, y, half, rcH)
  doc.font('Helvetica').fontSize(4.6).fillColor('#000').text(L.received, M + 3, y + 2, { width: half - 6 })
  boxOutline(doc, rX, y, half, rcH)
  doc.font('Helvetica').fontSize(5.2).fillColor('#000').text(L.carrierDelivery, rX + 4, y + 2, { width: half - 8 })
  doc.font('Helvetica').fontSize(5).fillColor('#000').text('____________________  Shipper Signature', rX + 4, y + rcH - 8)
  y += rcH + 2

  // ── Signature blocks ──────────────────────────────────────────────────────
  const sH = 56
  const q = W / 4
  for (let i = 0; i < 4; i++) boxOutline(doc, M + i * q, y, q, sH)
  doc.font('Helvetica-Bold').fontSize(6).fillColor('#000').text('SHIPPER SIGNATURE / DATE', M + 3, y + 3, { width: q - 6 })
  doc.font('Helvetica').fontSize(4.3).fillColor('#333').text(L.shipperCert, M + 3, y + 13, { width: q - 6 })

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#000').text('Trailer Loaded:', M + q + 3, y + 3)
  checkRow(doc, M + q + 3, y + 14, 'By Shipper', true)
  checkRow(doc, M + q + 3, y + 26, 'By Driver', false)

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#000').text('Freight Counted:', M + 2 * q + 3, y + 3)
  checkRow(doc, M + 2 * q + 3, y + 14, 'By Shipper', true)
  checkRow(doc, M + 2 * q + 3, y + 25, 'By Driver/pallets said to contain', false)
  checkRow(doc, M + 2 * q + 3, y + 36, 'By Driver/Pieces', false)

  doc.font('Helvetica-Bold').fontSize(6).fillColor('#000').text('CARRIER SIGNATURE / PICKUP DATE', M + 3 * q + 3, y + 3, { width: q - 6 })
  doc.font('Helvetica').fontSize(4).fillColor('#333').text(L.carrierCert, M + 3 * q + 3, y + 16, { width: q - 6 })
  y += sH + 3

  // ── Footer note ───────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#000')
    .text(isMaster ? L.masterFoot : L.finalFoot, M, y, { width: W })
  if (missing.length) {
    doc.fillColor(RED).font('Helvetica-Bold').fontSize(6)
      .text(`! Ship-to ${missing.join(', ')} not on file — confirm before shipping.`, M, doc.y + 2, { width: W })
  }
}

// ── drawing helpers ───────────────────────────────────────────────────────
function boxOutline(doc, x, y, w, h) { doc.lineWidth(0.8).rect(x, y, w, h).stroke('#000') }
function blackBar(doc, x, y, w, title) {
  doc.save().rect(x, y, w, 11).fill('#111').restore()
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7).text(title, x, y + 2.5, { width: w, align: 'center' })
}
function sectionBar(doc, x, y, w, title) {
  doc.save().rect(x, y, w, 11).fill('#111').restore()
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7).text(title, x, y + 2.5, { width: w, align: 'center' })
}
function fob(doc, x, y) {
  doc.font('Helvetica').fontSize(6).fillColor('#000').text('FOB:', x, y + 0.5)
  doc.rect(x + 20, y, 7, 7).lineWidth(0.6).stroke('#000')
}
function addrLines(doc, x, y, w, a, missing, boldName = false) {
  const line2 = [a.city, a.state].filter(Boolean).join(', ')
  const nameLines = String(a.name || '').split('\n')
  const rows = [
    ['Name:', nameLines],
    ['Address:', [a.street || (missing.includes('street') ? '(confirm street)' : '')]],
    ['City/State/Zip:', [(line2 || (missing.includes('city') ? '(confirm city/state)' : '')) + (a.zip ? ` ${a.zip}` : missing.includes('zip') ? ' (confirm ZIP)' : '')]],
  ]
  let ly = y
  for (const [lab, vals] of rows) {
    doc.font('Helvetica').fontSize(6).fillColor('#000').text(lab, x + 3, ly + 1)
    for (const v of vals) {
      doc.font(boldName ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(/\(confirm/.test(v) ? RED : (boldName ? RED : '#000')).text(v || ' ', x + 62, ly, { width: w - 66 })
      ly += 9.5
    }
    ly += 2
  }
}
function gridHeader(doc, x, y, cols, labels) {
  let cx = x
  doc.save().rect(x, y, cols.reduce((a, b) => a + b, 0), 15).fill('#f0f0f0').restore()
  doc.font('Helvetica-Bold').fontSize(5.2).fillColor('#000')
  cols.forEach((cw, i) => { doc.rect(cx, y, cw, 15).lineWidth(0.4).stroke('#999'); doc.text(labels[i], cx + 2, y + 3, { width: cw - 4, align: 'center' }); cx += cw })
}
function gridRow(doc, x, y, cols, vals, bold, color) {
  let cx = x
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 7 : 8).fillColor(bold ? '#000' : (color || '#000'))
  cols.forEach((cw, i) => { doc.rect(cx, y, cw, 15).lineWidth(0.3).stroke('#ccc'); doc.text(vals[i] || '', cx + 2, y + 4, { width: cw - 4, align: i === 0 ? 'left' : 'center' }); cx += cw })
}
function checkRow(doc, x, y, lab, on) {
  doc.rect(x, y, 6, 6).lineWidth(0.5).stroke('#000')
  if (on) doc.font('Helvetica-Bold').fontSize(6.5).fillColor(RED).text('X', x + 0.8, y + 0.3)
  doc.font('Helvetica').fontSize(5).fillColor('#000').text(lab, x + 9, y + 0.8, { width: 90 })
}
