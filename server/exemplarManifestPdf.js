// server/exemplarManifestPdf.js — the Master Manifest & Packing List, as a PDF.
//
// Guide p13: "Master Manifest & Packing List — Required for all shipments. Must
// provide the manifest to the carrier at pick-up." One per banner, each labelled with
// the banner name and the ship-to DC.
//
// ⚠️ IT IS THE CARRIER'S SHEET. Not the DC's (that is the packing slip, emailed ahead
// and pouched) and not the contract of carriage (that is the BOL). It exists so the
// driver can account for what is on the truck by store and PO.
//
// ⚠️ IT REFUSES TO RENDER WITH A PROBLEM. buildManifests() reports a store routed to a
// different DC, an unknown store, a carton with no PO. A manifest is handed over and
// travels with the freight, so a wrong one is worse than none — it looks authoritative.

import PDFDocument from 'pdfkit'
import { buildManifests, manifestAgreesWith, SOURCE } from '../src/model/exemplarManifest.js'
import { SHIP_FROM } from '../src/model/exemplarCartonLabel.js'
import { dcAddressLines } from '../src/model/exemplarStores.js'

const line = (doc, x, y, w) => doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.5).strokeColor('#999').stroke()

export async function manifestPdf(cartons, { dc, bolNumber = null, shipment = null } = {}) {
  const built = buildManifests(cartons, { dc })
  if (!built.printable) {
    throw new Error(`the manifest is not printable — ${built.problems.join(' · ')}`)
  }
  const agree = shipment ? manifestAgreesWith(built, shipment) : { agrees: true, notes: [] }
  if (!agree.agrees) {
    // ⚠️ Two reads of the same freight disagreeing is a discrepancy the DC raises
    // against us. Refuse rather than print the one that happens to be to hand.
    throw new Error(`the manifest disagrees with the shipment — ${agree.notes.join(' · ')}`)
  }

  const doc = new PDFDocument({ size: 'LETTER', margin: 40 })
  const W = 612 - 80

  built.manifests.forEach((m, i) => {
    if (i > 0) doc.addPage()
    doc.fontSize(16).font('Helvetica-Bold').fillColor('black').text('MASTER MANIFEST & PACKING LIST')
    // The two labels the guide names explicitly.
    doc.fontSize(11).font('Helvetica-Bold').text(`${m.bannerName}  —  ${m.dcName} (${m.dc})`)
    doc.fontSize(8).font('Helvetica').fillColor('#555')
      .text('Provide to the carrier at pick-up. Routing Guide p13.')
    doc.fillColor('black').moveDown(0.6)

    const top = doc.y
    doc.fontSize(7).font('Helvetica').text('SHIP FROM', 40, top)
    doc.fontSize(9).font('Helvetica-Bold').text(SHIP_FROM.name, 40, top + 10)
    doc.font('Helvetica').fontSize(8.5)
      .text([...SHIP_FROM.lines, `${SHIP_FROM.city}, ${SHIP_FROM.state} ${SHIP_FROM.zip}`].join('\n'), 40, top + 22)
    doc.fontSize(7).font('Helvetica').text('SHIP TO', 320, top)
    doc.fontSize(9).font('Helvetica-Bold').text(`${m.bannerName} — ${m.dcName}`, 320, top + 10)
    doc.font('Helvetica').fontSize(8.5).text(dcAddressLines(m.dc).join('\n'), 320, top + 22)
    doc.y = top + 66

    doc.fontSize(8.5).font('Helvetica')
      .text(`PO ${m.pos.join(', ')}     Cartons ${m.totalCartons}     Units ${m.totalUnits}`
        + (bolNumber ? `     BOL ${bolNumber}` : ''), 40, doc.y)
    doc.moveDown(0.6)
    line(doc, 40, doc.y, W); doc.moveDown(0.3)

    const cols = [40, 130, 330, 430, 500]
    doc.fontSize(8).font('Helvetica-Bold')
    const hy = doc.y
    ;['STORE', 'NAME', 'PO', 'CARTONS', 'UNITS'].forEach((h, k) => doc.text(h, cols[k], hy))
    doc.y = hy + 13
    line(doc, 40, doc.y - 3, W)

    doc.font('Helvetica').fontSize(8)
    for (const s of m.stores) {
      const y = doc.y
      if (y > 700) { doc.addPage(); doc.y = 40 }
      doc.text(s.store, cols[0], doc.y)
      doc.text(s.storeName || '', cols[1], y, { width: 195 })
      doc.text(s.pos.join(', '), cols[2], y, { width: 95 })
      doc.text(String(s.cartons), cols[3], y)
      doc.text(String(s.units), cols[4], y)
      doc.y = y + 13
    }
    line(doc, 40, doc.y + 2, W)
    doc.moveDown(0.4)
    doc.font('Helvetica-Bold').fontSize(9)
      .text(`TOTAL   ${m.stores.length} store${m.stores.length === 1 ? '' : 's'}   ${m.totalCartons} cartons   ${m.totalUnits} units`, 40, doc.y)

    doc.moveDown(1.5)
    doc.font('Helvetica').fontSize(7.5).fillColor('#555')
      .text(`${SOURCE.guide} rev ${SOURCE.revision}, p${SOURCE.page}.`, 40, doc.y)
    doc.fillColor('black')
  })

  return doc
}
