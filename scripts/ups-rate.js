// scripts/ups-rate.js — what will this big box cost on the WHOLESALE UPS account?
//
//   npm run ups:rate -- --if IF7228 --postal 02554 --state MA
//   npm run ups:rate -- --weight 32 --dims 24x18x14 --postal 02554 --state MA
//   npm run ups:rate -- --weight 32 --postal 33308 --state FL --service ups_2nd_day_air
//   npm run ups:rate -- --check                 just test the carrier connections
//
// Answers from two sources, never blended:
//   • a LIVE quote on C6J610 — the real number, blocked until the Big Box carrier
//     is reconnected in ShipStation;
//   • what C6J610 was ACTUALLY BILLED for comparable boxes (npm run sync:ups-costs)
//     — real invoiced wholesale money, available today.
//
// An 18GE01 figure is shown only as a clearly-marked cross-check. It is the ecom
// account; boutique freight bills to C6J610, so it is never the wholesale number.
import { WHOLESALE_ACCOUNT, quoteFromActuals, wholesaleFigure, crossChecks } from '../src/model/upsRates.js'
import { fetchActuals } from '../src/ingest/shipstationCosts.js'
import { quoteAccount, checkConnection } from '../src/ingest/shipstationRates.js'
import { fetchFulfillmentBoxes } from '../src/ingest/loadToDb.js'
import { pool } from '../src/db.js'

const argv = process.argv.slice(2)
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null }
const has = (n) => argv.includes(`--${n}`)

const done = async (code = 0) => { await pool.end(); process.exit(code) }

if (has('check')) {
  for (const acct of [WHOLESALE_ACCOUNT, '18GE01']) {
    const r = await checkConnection(acct)
    const tag = acct === WHOLESALE_ACCOUNT ? ' (wholesale)' : ' (ecom)'
    console.log(r.healthy ? `✓ ${acct}${tag} — rating works, ${r.services} services` : `✗ ${acct}${tag} — ${r.error}`)
  }
  console.log('\nIf wholesale is ✗: ShipStation → Settings → Shipping → Carriers → NAGHEDI UPS (C6J610) Big Box → reconnect.')
  await done()
}

const postalCode = flag('postal')
if (!postalCode) {
  console.error('Need a destination: --postal 02554 [--state MA] [--city Nantucket]')
  console.error('UPS ground price is driven by distance, so a rate without a destination is meaningless.')
  await done(1)
}
const destination = { postalCode, state: flag('state'), city: flag('city'), country: flag('country') || 'US' }
const serviceCode = flag('service') || 'ups_ground'
const residential = has('residential')

// Boxes: either straight off a scanned-in IF, or given on the command line.
let boxes = []
const ifNumber = flag('if')
if (ifNumber) {
  boxes = await fetchFulfillmentBoxes(ifNumber)
  if (!boxes.length) {
    console.error(`No scanned-in boxes captured for ${ifNumber} — the rate comes off the dims recorded at scan-in.`)
    await done(1)
  }
} else {
  const weightLb = Number(flag('weight'))
  if (!weightLb) { console.error('Need --weight <lb>, or --if IF##### to use the scanned-in box dims.'); await done(1) }
  const d = (flag('dims') || '').match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/)
  boxes = [{ weightLb, lengthIn: d ? Number(d[1]) : null, widthIn: d ? Number(d[2]) : null, heightIn: d ? Number(d[3]) : null }]
}

const dest = `${destination.city || ''} ${destination.state || ''} ${postalCode}`.trim()
console.log(`${serviceCode} → ${dest}${residential ? ' (residential)' : ''}${ifNumber ? `  ·  ${ifNumber}` : ''}\n`)

const actuals = await fetchActuals({ account: WHOLESALE_ACCOUNT, serviceCode }, pool)
if (!actuals.length) {
  console.log(`⚠ No billed ${WHOLESALE_ACCOUNT} history for ${serviceCode} yet — run: npm run sync:ups-costs -- --months 30\n`)
}
const asOfDate = new Date().toISOString().slice(0, 10)

let liveErr = null
let runningTotal = 0
let totalComplete = true

for (const [i, box] of boxes.entries()) {
  const dims = box.lengthIn ? `${box.lengthIn}×${box.widthIn}×${box.heightIn}` : 'no dims'
  console.log(`Box ${i + 1}: ${box.weightLb} lb, ${dims}`)

  const figures = []
  const live = await quoteAccount({ account: WHOLESALE_ACCOUNT, box, destination, residential })
  if (live.ok) {
    const pick = live.figures.find((f) => f.serviceCode === serviceCode) || live.figures[0]
    if (pick) figures.push(pick)
  } else { liveErr = live.error }

  const hist = quoteFromActuals(
    actuals,
    { account: WHOLESALE_ACCOUNT, serviceCode, weightLb: Number(box.weightLb), destPostal: postalCode, destState: destination.state },
    { asOfDate },
  )
  if (hist) figures.push(hist)

  const ecom = await quoteAccount({ account: '18GE01', box, destination, residential })
  if (ecom.ok) {
    const pick = ecom.figures.find((f) => f.serviceCode === serviceCode) || ecom.figures[0]
    if (pick) figures.push(pick)
  }

  const wf = wholesaleFigure(figures)
  if (!wf) {
    totalComplete = false
    console.log(`   WHOLESALE (${WHOLESALE_ACCOUNT}): unknown`)
    console.log(`      ${liveErr || 'no comparable billed history'}`)
  } else if (wf.basis === 'live-quote') {
    runningTotal += wf.total
    console.log(`   WHOLESALE (${WHOLESALE_ACCOUNT}): $${wf.total.toFixed(2)}   [LIVE QUOTE, ${wf.asOf}]`)
    if (wf.other) console.log(`      $${wf.shipping.toFixed(2)} freight + $${wf.other.toFixed(2)} surcharges`)
  } else {
    runningTotal += wf.median
    console.log(`   WHOLESALE (${WHOLESALE_ACCOUNT}): $${wf.median.toFixed(2)}   [BILLED HISTORY — not a live quote]`)
    console.log(`      ${wf.n} comparable shipment(s), ${wf.tier}, range $${wf.p25.toFixed(2)}–$${wf.p75.toFixed(2)} (min $${wf.min.toFixed(2)}, max $${wf.max.toFixed(2)})`)
    console.log(`      billed ${wf.asOf.from} → ${wf.asOf.to}${wf.staleDays > 400 ? `  ⚠ newest is ${Math.round(wf.staleDays / 30)} months old — UPS has raised rates since` : ''}`)
    if (wf.thin) console.log('      ⚠ thin sample — treat as a rough indication')
  }

  for (const cc of crossChecks(figures)) {
    console.log(`   ${cc.account} (NOT wholesale): $${cc.total.toFixed(2)} — reference only`)
  }
  console.log('')
}

if (boxes.length > 1) {
  if (totalComplete) console.log(`SHIPMENT TOTAL (${WHOLESALE_ACCOUNT}, ${boxes.length} boxes): $${runningTotal.toFixed(2)}`)
  else console.log(`SHIPMENT TOTAL: incomplete — at least one box has no wholesale figure, so a sum would understate it.`)
}

if (liveErr) {
  console.log(`\nLive wholesale quoting is down: ${liveErr}`)
  console.log('Fix: ShipStation → Settings → Shipping → Carriers → NAGHEDI UPS (C6J610) Big Box → reconnect.')
  console.log('Then: npm run ups:rate -- --check')
}

await done()
