// server/bolPdf.js — per-DC VICS Bill of Lading, generated with pdfkit (already
// a dependency, same engine as the cargo tags). One BOL per shipment (= one DC,
// rolling up its POs). Ship-from Naghedi; ship-to the Bloomingdale's MEGA-MERGE
// consolidator or the Nordstrom DC. Commodity is always Polyester Handbags,
// NMFC 100, on pallets. The DC is shown big — the BOL number is a unique serial,
// so the destination is what a human reads first.
//
// buildBolPdf(shipment) → Promise<Buffer> (for Drive upload); renderBolTo(res,
// shipment) streams it as an inline download.

import PDFDocument from 'pdfkit'
import { dcLabel } from '../src/model/dc.js'
import { SHIP_FROM, COMMODITY, shipToFor } from '../src/model/bolAddresses.js'

const PT = 72
const PAGE = { w: 8.5 * PT, h: 11 * PT, margin: 36 }

function addrLines(block) {
  const line2 = [block.city, block.state].filter(Boolean).join(', ')
  return [
    block.name,
    block.attn || null,
    block.street || '(confirm street)',
    (line2 || '(confirm city/state)') + (block.zip ? ` ${block.zip}` : ' (confirm ZIP)'),
  ].filter(Boolean)
}

// Draw a titled box; return the inner y after the title so callers can fill it.
function box(doc, x, y, w, h, title) {
  doc.lineWidth(0.8).rect(x, y, w, h).stroke('#000')
  if (title) {
    doc.save().rect(x, y, w, 13).fill('#e8e8e8').restore()
    doc.rect(x, y, w, 13).stroke('#000')
    doc.fillColor('#000').fontSize(6.5).font('Helvetica-Bold').text(title.toUpperCase(), x + 4, y + 4, { width: w - 8 })
  }
  return y + (title ? 15 : 3)
}

function field(doc, x, y, label, value, opts = {}) {
  doc.fillColor('#555').fontSize(5.5).font('Helvetica').text(label.toUpperCase(), x, y)
  doc.fillColor('#000').fontSize(opts.size || 9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .text(value == null || value === '' ? '—' : String(value), x, y + 6, { width: opts.width })
}

export function buildBolPdf(shipment) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: PAGE.margin })
      const chunks = []
      doc.on('data', (c) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))

      const M = PAGE.margin
      const W = PAGE.w - M * 2
      const label = dcLabel(shipment.dc)
      const { block: shipTo, missing } = shipToFor(shipment.partner, shipment.dc, label)
      let y = M

      // ── Header: title + big BOL number ─────────────────────────────────────
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(15).text('BILL OF LADING', M, y)
      doc.font('Helvetica').fontSize(6.5).fillColor('#555').text('VICS Standard · non-negotiable', M, y + 17)
      doc.font('Helvetica').fontSize(6.5).fillColor('#000')
        .text('BOL NUMBER', M + W - 170, y, { width: 170, align: 'right' })
      doc.font('Helvetica-Bold').fontSize(17)
        .text(shipment.bolNumber || '—', M + W - 170, y + 8, { width: 170, align: 'right' })
      y += 34

      // Partner + DC banner (DC shown big)
      doc.rect(M, y, W, 26).fill('#111').stroke('#111')
      doc.fillColor('#fff').font('Helvetica-Bold').fontSize(15).text(String(shipment.dc), M + 8, y + 6)
      doc.font('Helvetica').fontSize(9).fillColor('#ddd')
        .text(`${shipment.partner} · ${label}`, M + 60, y + 4, { width: W - 68 })
      doc.fontSize(7).fillColor('#bbb')
        .text(`POs: ${(shipment.memberPos || []).join(', ')}`, M + 60, y + 15, { width: W - 68 })
      y += 32

      // ── Ship From / Ship To ────────────────────────────────────────────────
      const colW = (W - 8) / 2
      const bTop = y
      const bH = 78
      let iy = box(doc, M, bTop, colW, bH, 'Ship From')
      doc.fillColor('#000').font('Helvetica').fontSize(9)
      addrLines(SHIP_FROM).forEach((l, i) => doc.text(l, M + 6, iy + i * 11, { width: colW - 12 }))

      iy = box(doc, M + colW + 8, bTop, colW, bH, 'Ship To')
      addrLines(shipTo).forEach((l, i) =>
        doc.fillColor(/⚠/.test(l) ? '#b00' : '#000').font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
          .text(l, M + colW + 14, iy + i * 11, { width: colW - 12 }))
      y = bTop + bH + 6

      // ── Carrier / routing references ────────────────────────────────────────
      const cH = 46
      box(doc, M, y, W, cH, 'Carrier & Routing')
      const cy = y + 17
      const c4 = (W - 8) / 4
      field(doc, M + 6, cy, 'Carrier', shipment.carrier, { width: c4 - 8, bold: true })
      field(doc, M + 6 + c4, cy, 'SCAC', shipment.scac, { width: c4 - 8, bold: true })
      field(doc, M + 6 + c4 * 2, cy, 'Authorization #', shipment.authNumber, { width: c4 - 8 })
      field(doc, M + 6 + c4 * 3, cy, 'Ship Date', shipment.shipDate ? String(shipment.shipDate).slice(0, 10) : null, { width: c4 - 8 })
      field(doc, M + 6, cy + 20, 'Project #', shipment.projectNumber, { width: c4 - 8 })
      field(doc, M + 6 + c4, cy + 20, 'Shipment #', shipment.shipmentNumber, { width: c4 - 8 })
      field(doc, M + 6 + c4 * 2, cy + 20, 'Pro No.', null, { width: c4 - 8 })
      field(doc, M + 6 + c4 * 3, cy + 20, 'Freight Terms', 'Prepaid', { width: c4 - 8 })
      y += cH + 6

      // ── Customer order information ──────────────────────────────────────────
      const oH = 52
      box(doc, M, y, W, oH, 'Customer Order Information')
      const oy = y + 15
      const oc = [W * 0.4, W * 0.2, W * 0.2, W * 0.2]
      const ox = [M, M + oc[0], M + oc[0] + oc[1], M + oc[0] + oc[1] + oc[2]]
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
      ;['Customer Order No. (PO)', '# Pkgs', 'Weight (lb)', 'Pallet/Slip'].forEach((h, i) =>
        doc.text(h, ox[i] + 4, oy, { width: oc[i] - 8 }))
      doc.font('Helvetica').fontSize(9)
      const rowY = oy + 12
      doc.text((shipment.memberPos || []).join(', '), ox[0] + 4, rowY, { width: oc[0] - 8 })
      doc.text(String(shipment.cartons ?? '—'), ox[1] + 4, rowY, { width: oc[1] - 8 })
      doc.text(String(shipment.weightLb ?? '—'), ox[2] + 4, rowY, { width: oc[2] - 8 })
      doc.text('PLT (Y)', ox[3] + 4, rowY, { width: oc[3] - 8 })
      // totals row
      doc.font('Helvetica-Bold').fontSize(8)
      doc.text('GRAND TOTAL', ox[0] + 4, oy + 30, { width: oc[0] - 8 })
      doc.text(String(shipment.cartons ?? '—'), ox[1] + 4, oy + 30, { width: oc[1] - 8 })
      doc.text(String(shipment.weightLb ?? '—'), ox[2] + 4, oy + 30, { width: oc[2] - 8 })
      y += oH + 6

      // ── Carrier information (commodity) ─────────────────────────────────────
      const kH = 56
      box(doc, M, y, W, kH, 'Carrier Information — commodity')
      const ky = y + 15
      const kc = [W * 0.16, W * 0.16, W * 0.16, W * 0.36, W * 0.16]
      const kx = []
      kc.reduce((acc, w, i) => { kx[i] = acc; return acc + w }, M)
      doc.font('Helvetica-Bold').fontSize(6).fillColor('#000')
      ;['Handling Units', 'Package (CTN)', 'Weight (lb)', 'Commodity Description', 'NMFC / Class'].forEach((h, i) =>
        doc.text(h, kx[i] + 4, ky, { width: kc[i] - 8 }))
      doc.font('Helvetica').fontSize(9)
      const kr = ky + 14
      doc.text('1 PLT', kx[0] + 4, kr, { width: kc[0] - 8 })
      doc.text(`${shipment.cartons ?? '—'} CTN`, kx[1] + 4, kr, { width: kc[1] - 8 })
      doc.text(String(shipment.weightLb ?? '—'), kx[2] + 4, kr, { width: kc[2] - 8 })
      doc.text(COMMODITY.description, kx[3] + 4, kr, { width: kc[3] - 8 })
      doc.text(`${COMMODITY.nmfc} / 100`, kx[4] + 4, kr, { width: kc[4] - 8 })
      doc.fontSize(6.5).fillColor('#555')
        .text(`Cubic feet: ${shipment.cubicFeet ?? '—'}   Units: ${shipment.units ?? '—'}   Packaging: ${COMMODITY.packaging}`, M + 6, y + kH - 14)
      y += kH + 6

      if (missing.length) {
        doc.fillColor('#b00').font('Helvetica-Bold').fontSize(7)
          .text(`! Ship-to ${missing.join(', ')} not on file — confirm against the ${shipment.partner} BOL template before shipping.`, M, y, { width: W })
        y += 14
      }

      // ── Signatures ──────────────────────────────────────────────────────────
      const sH = 40
      box(doc, M, y, W, sH, 'Signatures')
      const sy = y + 22
      doc.lineWidth(0.5)
      doc.moveTo(M + 8, sy + 6).lineTo(M + colW - 8, sy + 6).stroke('#000')
      doc.moveTo(M + colW + 8, sy + 6).lineTo(M + W - 8, sy + 6).stroke('#000')
      doc.font('Helvetica').fontSize(6.5).fillColor('#555')
        .text('Shipper (Naghedi)', M + 8, sy + 8)
        .text('Carrier / Driver — pickup date', M + colW + 8, sy + 8)

      doc.fontSize(6).fillColor('#999')
        .text(`Generated ${new Date().toISOString().slice(0, 10)} · Naghedi Work-Hub · not stored`, M, PAGE.h - M + 2, { width: W, align: 'center' })

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
