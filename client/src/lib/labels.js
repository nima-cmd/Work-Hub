// Cargo-tag label printing (Nima, 2026-07-17) — one 4×6 thermal label per
// Item Fulfillment, printed on the MUNBYN via the browser's print dialog the
// moment the IF exists in the app. The QR encodes JUST the IF number (plain
// text, scanner-agnostic) — the Scan Bay reads it back for OUT/IN custody scans.
import qrcode from 'qrcode-generator'

export function ifLabelHtml({ ifNumber, soNumber, customer, poNumber }) {
  const qr = qrcode(0, 'M') // type 0 = auto-size, M error correction
  qr.addData(ifNumber)
  qr.make()
  const qrSvg = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true })

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(ifNumber)} cargo tag</title>
<style>
  @page { size: 4in 6in; margin: 0; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 4in; height: 6in; }
  body {
    font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
    color: #000; background: #fff;
    display: flex; flex-direction: column; align-items: center;
    padding: 0.25in; text-align: center;
  }
  .head { font-size: 11pt; letter-spacing: 0.28em; font-weight: 700; }
  .sub  { font-size: 7.5pt; letter-spacing: 0.18em; margin-top: 2pt; }
  .qr   { width: 2.6in; height: 2.6in; margin: 0.18in 0 0.12in; }
  .qr svg { width: 100%; height: 100%; }
  .ifnum { font-size: 30pt; font-weight: 800; letter-spacing: 0.04em; }
  .meta  { margin-top: 0.1in; font-size: 12pt; line-height: 1.45; }
  .meta b { font-size: 13pt; }
  .foot { margin-top: auto; width: 100%; border-top: 2px solid #000; padding-top: 6pt;
          font-size: 8pt; letter-spacing: 0.14em; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <div class="head">◆ NAGHEDI</div>
  <div class="sub">CARGO TAG · WAREHOUSE CUSTODY</div>
  <div class="qr">${qrSvg}</div>
  <div class="ifnum">${esc(ifNumber)}</div>
  <div class="meta">
    ${soNumber ? `<b>${esc(soNumber)}</b><br/>` : ''}
    ${customer ? `${esc(customer)}<br/>` : ''}
    ${poNumber ? `PO ${esc(poNumber)}` : ''}
  </div>
  <div class="foot"><span>SCAN OUT → WAREHOUSE</span><span>SCAN IN → RETURNED</span></div>
  <script>
    window.addEventListener('load', () => { window.print() })
    window.addEventListener('afterprint', () => { window.close() })
  </script>
</body>
</html>`
}

export function printIfLabel(info) {
  const w = window.open('', '_blank', 'width=420,height=660')
  if (!w) throw new Error('Popup blocked — allow popups to print labels')
  w.document.write(ifLabelHtml(info))
  w.document.close()
}
