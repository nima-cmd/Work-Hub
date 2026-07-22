// server/bolPdf.js — per-DC VICS Bill of Lading, generated with pdfkit, laid out
// to mirror Nima's real BOL template (the "Master Bol" tab of the Bloomingdales
// / Nordstrom sheets): same sections, field labels, freight-terms boxes, and
// the VICS legal + certification language. One BOL per shipment (= one DC,
// rolling up its POs). Ship-from Naghedi; ship-to the Bloomingdale's MEGA-MERGE
// consolidator or the Nordstrom DC. Commodity is always Polyester Handbags,
// class 100, on pallets.
//
// buildBolPdf(shipment) → Promise<Buffer>; renderBolTo(res, shipment) streams it.
// shipment may carry `lineItems: [{ po, cartons, weight }]` for the per-PO rows
// of the Customer Order Information table; without it the totals still print.

import PDFDocument from 'pdfkit'
import { dcLabel } from '../src/model/dc.js'
import { SHIP_FROM, COMMODITY, shipToFor } from '../src/model/bolAddresses.js'

const PAGE = { size: 'LETTER', margin: 24 }
const INK = '#000'
const HEAD_FILL = '#e8e8e8'
const RED = '#b00'

// VICS language, transcribed from the template so the BOL reads the same.
const L = {
  prepaidNote: '(freight charges are prepaid unless marked collect)',
  master: 'Master Bill of Lading: with attached underlying Bills of Lading',
  received:
    'RECEIVED, subject to the rates, classifications and rules that have been established by the Carrier and are available on request to the Shipper ' +
    '(Shipper defined in 49 U.S.C.A. § 13102(13)(c)), and to all applicable state and federal regulations. Shipper 1) warrants it has read all applicable ' +
    'contract(s) or Carrier’s applicable tariff(s) and the limitation of liability provisions set forth therein; and 2) has actual knowledge of and accepts ' +
    'the applicable contract or tariff terms, including the limits on carrier liability. Carriers’ tariff(s), including OD Rules 100, take precedence in the ' +
    'event of any terms or conditions conflicts.',
  value:
    'Where the rate is dependent on value, shippers are required to state specifically in writing the agreed or declared value of the property as follows: ' +
    'Noting a value is not a request for Additional Cargo Liability under OD Rules 100, Item 574. “The agreed or declared value of the property is ' +
    'specifically stated by the shipper to be not exceeding ______ per ______.”',
  liability: 'NOTE - Liability Limitation applies. See OD Rules 100, Items 574 and 594.',
  carrierDelivery: 'The carrier shall not make delivery of this shipment without payment of freight and all other lawful charges.',
  shipperCert:
    'This is to certify that the above named materials are properly classified, described, packaged, marked and labeled, and are in proper condition for ' +
    'transportation according to the applicable regulations of the U.S. DOT.',
  carrierCert:
    'Carrier acknowledges receipt of packages and required placards. Carrier certifies emergency response information was made available and/or carrier has ' +
    'the U.S. DOT emergency response guidebook or equivalent documentation in the vehicle.',
  goodOrder: 'Property described above is received in good order, except as noted.',
}

export function buildBolPdf(shipment) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: PAGE.size, margin: PAGE.margin })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      render(doc, shipment)
      doc.end()
    } catch (e) {
      reject(e)
    }
  })
}

export async function renderBolTo(res, shipment) {
  const pdf = await buildBolPdf(shipment)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="BOL_${shipment.bolNumber || 'draft'}_${shipment.dc}.pdf"`)
  res.send(pdf)
}

function render(doc, shipment) {
  const M = PAGE.margin
  const W = doc.page.width - M * 2
  const label = dcLabel(shipment.dc)
  const { block: shipTo, missing } = shipToFor(shipment.partner, shipment.dc, label)
  const half = (W - 6) / 2
  const rightX = M + half + 6
  let y = M

  // ── Header ────────────────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(8).fillColor(INK)
    .text(shipment.shipDate ? `Date: ${String(shipment.shipDate).slice(0, 10)}` : 'Date:', M, y + 4)
  doc.font('Helvetica-Bold').fontSize(17).text('BILL OF LADING', M, y, { width: W, align: 'center' })
  doc.font('Helvetica').fontSize(6.5).text('Bill Of Lading Number', rightX, y, { width: half, align: 'right' })
  doc.font('Helvetica-Bold').fontSize(13).text(shipment.bolNumber || '—', rightX, y + 9, { width: half, align: 'right' })
  doc.font('Helvetica').fontSize(7).fillColor('#555')
    .text(`${shipment.partner}  ·  DC ${shipment.dc} (${label})`, rightX, y + 26, { width: half, align: 'right' })
  y += 42

  // ── Ship From (left) | Carrier block (right) ────────────────────────────────
  const topH = 92
  addrBox(doc, M, y, half, topH, 'Ship From', SHIP_FROM, 'SID#')
  labeledBox(doc, rightX, y, half, topH, [
    ['Carrier Name', shipment.carrier || ''],
    ['Trailer Number', ''],
    ['Seal number(s)', ''],
    ['SCAC', shipment.scac || ''],
    ['Pro Number', ''],
  ])
  y += topH + 5

  // ── Ship To (left) | Freight charge terms (right) ───────────────────────────
  const midH = 92
  addrBox(doc, M, y, half, midH, 'Ship To', shipTo, 'CID#', missing)
  freightTermsBox(doc, rightX, y, half, midH)
  y += midH + 5

  // ── Third party bill-to (left) | Special instructions (right) ───────────────
  const tpH = 42
  addrBox(doc, M, y, half, tpH, 'Third Party Freight Charges Bill To', { name: '', street: '', city: '', state: '', zip: '' })
  box(doc, rightX, y, half, tpH, 'Special Instructions')
  y += tpH + 5

  // ── Customer Order Information ──────────────────────────────────────────────
  const lineItems = (shipment.lineItems && shipment.lineItems.length)
    ? shipment.lineItems
    : (shipment.memberPos || []).map((po) => ({ po, cartons: '', weight: '' }))
  const coRows = Math.max(lineItems.length, 3)
  // 14 (section header band) + 13 (column header) + data rows + 13 (grand total)
  const coH = 27 + (coRows + 1) * 13
  sectionHeader(doc, M, y, W, 'Customer Order Information')
  const cCols = [W * 0.46, W * 0.14, W * 0.16, W * 0.12, W * 0.12]
  tableHeader(doc, M, y + 14, cCols, ['Customer Order Number', '# PKGS', 'Weight', 'Pallet / Slip (Y/N)', 'Add’l Shipper Info'])
  let ry = y + 14 + 13
  for (let i = 0; i < coRows; i++) {
    const it = lineItems[i]
    tableRow(doc, M, ry, cCols, [
      it ? String(it.po) : '', it ? String(it.cartons ?? '') : '', it ? String(it.weight ?? '') : '',
      it ? 'Y' : '', '',
    ])
    ry += 13
  }
  tableRow(doc, M, ry, cCols, ['Grand Total', String(shipment.cartons ?? ''), String(shipment.weightLb ?? ''), '', ''], true)
  boxOutline(doc, M, y, W, coH)
  y += coH + 5

  // ── Carrier Information (commodity) ─────────────────────────────────────────
  const kH = 27 + 2 * 13
  sectionHeader(doc, M, y, W, 'Carrier Information')
  const kCols = [W * 0.09, W * 0.09, W * 0.09, W * 0.09, W * 0.12, W * 0.08, W * 0.32, W * 0.12]
  tableHeader(doc, M, y + 14, kCols, ['H.U. Qty', 'H.U. Type', 'Pkg Qty', 'Pkg Type', 'Weight', 'H.M.', 'Commodity Description', 'NMFC / Class'])
  tableRow(doc, M, y + 14 + 13, kCols, [
    '1', 'PLT', String(shipment.cartons ?? ''), 'CTN', String(shipment.weightLb ?? ''), '',
    COMMODITY.description, `${COMMODITY.nmfc || '—'} / ${COMMODITY.class}`,
  ])
  tableRow(doc, M, y + 14 + 26, kCols, ['', '', String(shipment.cartons ?? ''), '', String(shipment.weightLb ?? ''), 'Grand Total', `Cubic ft ${shipment.cubicFeet ?? '—'} · Units ${shipment.units ?? '—'}`, ''], true)
  boxOutline(doc, M, y, W, kH)
  y += kH + 5

  // ── Legal block ─────────────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(5.6).fillColor(INK)
  doc.text(L.value, M, y, { width: half, align: 'justify' })
  doc.text(L.liability, M, doc.y + 1, { width: half })
  const leftAfter = doc.y
  labeledBox(doc, rightX, y, half, 42, [['COD Amount: $', ''], ['Fee Terms', 'Prepaid / Collect']])
  doc.font('Helvetica').fontSize(5.6).fillColor(INK).text(L.carrierDelivery, rightX, y + 44, { width: half })
  y = Math.max(leftAfter, y + 60) + 3

  doc.font('Helvetica').fontSize(5.8).fillColor(INK).text(L.received, M, y, { width: W, align: 'justify' })
  y = doc.y + 4

  // ── Signatures ──────────────────────────────────────────────────────────────
  const sH = 66
  boxOutline(doc, M, y, W, sH)
  const sHalf = W / 2
  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK).text('SHIPPER SIGNATURE / DATE', M + 4, y + 4)
  doc.font('Helvetica').fontSize(5).fillColor('#333').text(L.shipperCert, M + 4, y + 13, { width: sHalf - 8 })
  doc.moveTo(M + 4, y + sH - 8).lineTo(M + sHalf - 8, y + sH - 8).lineWidth(0.5).stroke(INK)

  doc.font('Helvetica-Bold').fontSize(6.5).fillColor(INK).text('CARRIER SIGNATURE / PICKUP DATE', M + sHalf + 4, y + 4)
  doc.font('Helvetica').fontSize(5).fillColor('#333').text(L.carrierCert, M + sHalf + 4, y + 13, { width: sHalf - 8 })
  doc.font('Helvetica-Oblique').fontSize(5).fillColor('#333').text(L.goodOrder, M + sHalf + 4, y + sH - 16, { width: sHalf - 8 })
  doc.moveTo(M + sHalf + 4, y + sH - 8).lineTo(M + W - 4, y + sH - 8).stroke(INK)
  doc.moveTo(M + sHalf, y).lineTo(M + sHalf, y + sH).stroke(INK)
  y += sH + 3

  doc.font('Helvetica').fontSize(5.5).fillColor('#999')
    .text(`Generated ${new Date().toISOString().slice(0, 10)} · Naghedi Work-Hub · app-assigned BOL, unique & never reused`, M, y, { width: W, align: 'center' })
}

// ── drawing helpers ──────────────────────────────────────────────────────────
function boxOutline(doc, x, y, w, h) { doc.lineWidth(0.8).rect(x, y, w, h).stroke(INK) }

function box(doc, x, y, w, h, title) {
  boxOutline(doc, x, y, w, h)
  if (title) {
    doc.save().rect(x, y, w, 12).fill(HEAD_FILL).restore()
    doc.rect(x, y, w, 12).stroke(INK)
    doc.fillColor(INK).fontSize(6.5).font('Helvetica-Bold').text(title, x + 3, y + 3.5, { width: w - 6 })
  }
  return y + 14
}

function sectionHeader(doc, x, y, w, title) {
  doc.save().rect(x, y, w, 12).fill('#d8d8d8').restore()
  doc.rect(x, y, w, 12).lineWidth(0.8).stroke(INK)
  doc.fillColor(INK).fontSize(7).font('Helvetica-Bold').text(title, x + 4, y + 3, { width: w - 8 })
}

function addrBox(doc, x, y, w, h, title, a, idLabel, missing = []) {
  const iy = box(doc, x, y, w, h, title)
  const line2 = [a.city, a.state].filter(Boolean).join(', ')
  const lines = [
    ['Name:', a.name || ''],
    ['Address:', a.street || (missing.includes('street') ? '(confirm street)' : '')],
    ['City/State/Zip:', (line2 || (missing.length ? '(confirm city/state)' : '')) + (a.zip ? ` ${a.zip}` : missing.includes('zip') ? ' (confirm ZIP)' : '')],
  ]
  let ly = iy + 2
  for (const [lab, val] of lines) {
    doc.font('Helvetica').fontSize(6).fillColor('#555').text(lab, x + 4, ly)
    doc.font('Helvetica-Bold').fontSize(8).fillColor(/\(confirm/.test(val) ? RED : INK).text(val || ' ', x + 62, ly - 1, { width: w - 66 })
    ly += 15
  }
  if (idLabel) doc.font('Helvetica').fontSize(6).fillColor('#555').text(idLabel, x + 4, y + h - 10)
}

function labeledBox(doc, x, y, w, h, rows) {
  boxOutline(doc, x, y, w, h)
  const rh = (h - 2) / rows.length
  rows.forEach(([lab, val], i) => {
    const ry = y + 2 + i * rh
    if (i) doc.moveTo(x, ry).lineTo(x + w, ry).lineWidth(0.3).stroke('#bbb')
    doc.font('Helvetica').fontSize(5.8).fillColor('#555').text(lab, x + 4, ry + 2)
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(val || ' ', x + 4, ry + 9, { width: w - 8 })
  })
}

function freightTermsBox(doc, x, y, w, h) {
  const iy = box(doc, x, y, w, h, 'Freight Charge Terms')
  doc.font('Helvetica').fontSize(5.6).fillColor('#555').text(L.prepaidNote, x + 4, iy)
  const opts = [['Prepaid', true], ['Collect', false], ['3rd Party', false]]
  let ox = x + 4
  doc.fontSize(8)
  opts.forEach(([lab, on]) => {
    doc.rect(ox, iy + 12, 8, 8).lineWidth(0.6).stroke(INK)
    if (on) doc.font('Helvetica-Bold').fillColor(INK).text('X', ox + 1.5, iy + 12.5)
    doc.font('Helvetica').fontSize(8).fillColor(INK).text(lab, ox + 11, iy + 12.5)
    ox += 11 + doc.widthOfString(lab) + 14
  })
  doc.font('Helvetica').fontSize(6).fillColor('#333').text(L.master, x + 4, iy + 30, { width: w - 8 })
}

function tableHeader(doc, x, y, cols, labels) {
  doc.save().rect(x, y, cols.reduce((a, b) => a + b, 0), 13).fill('#f0f0f0').restore()
  let cx = x
  doc.font('Helvetica-Bold').fontSize(5.6).fillColor(INK)
  cols.forEach((cw, i) => {
    doc.rect(cx, y, cw, 13).lineWidth(0.4).stroke('#999')
    doc.text(labels[i], cx + 2, y + 3.5, { width: cw - 4 })
    cx += cw
  })
}

function tableRow(doc, x, y, cols, vals, bold = false) {
  let cx = x
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(INK)
  cols.forEach((cw, i) => {
    doc.rect(cx, y, cw, 13).lineWidth(0.3).stroke('#ccc')
    doc.text(vals[i] || '', cx + 2, y + 3, { width: cw - 4 })
    cx += cw
  })
}
