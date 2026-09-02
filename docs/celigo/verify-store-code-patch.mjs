// Run BOTH versions of the Celigo script against the real Orderful payload for
// PO 50220600 and compare, so the patch is proven on live data rather than reasoned about.
import fs from 'node:fs'
import vm from 'node:vm'

// Everything this needs lives beside it, so the proof is re-runnable from a clean
// checkout — a verification that depends on a temp folder is a verification nobody
// can repeat.
const S = new URL('.', import.meta.url).pathname

function load(file) {
  const src = fs.readFileSync(`${S}/${file}`, 'utf8')
  const ctx = { module: { exports: {} }, console, JSON, parseInt, String }
  vm.createContext(ctx)
  // The files stay pristine on disk; the export line only exists in this sandbox.
  vm.runInContext(src + '\n;module.exports = { getStores, splitByStore };', ctx)
  return ctx.module.exports
}

const orig = load('nordstrom-850-preSavePage.ORIGINAL-2026-09-01.js')
const patched = load('nordstrom-850-preSavePage.PATCHED-2026-09-01.js')

const msg = JSON.parse(fs.readFileSync(`${S}/850-50220600-orderful.json`, 'utf8'))
const loops = msg.transactionSets[0].PO1_loop

// ── getStores, on every real SDQ object ─────────────────────────────────────
const codesOf = (impl) => {
  const seen = []
  for (const l of loops) for (const dq of l.destinationQuantity) {
    for (const r of impl.getStores(dq)) seen.push(r.store)
  }
  return [...new Set(seen)]
}
const a = codesOf(orig).sort()
const b = codesOf(patched).sort()
console.log('ORIGINAL getStores →', a.join(', '))
console.log('PATCHED  getStores →', b.join(', '))

// ── splitByStore, end to end ────────────────────────────────────────────────
// Build the shape splitByStore expects, using each version's own getStores so the
// two pipelines are compared as wholes, not as isolated functions.
const pipeline = (impl) => {
  const items = loops.map((l) => ({
    shipToID: l.N1_loop[0].partyIdentification[0].name,
    sku: (l.baselineItemData[0].productServiceId3 || l.baselineItemData[0].productServiceId2),
    destinationQuantity: l.destinationQuantity.length > 1
      ? l.destinationQuantity.flatMap((dq) => impl.getStores(dq))
      : impl.getStores(l.destinationQuantity[0]),
  }))
  const out = impl.splitByStore([{ purchaseOrderNumber: '50220600', items }])
  return out.map((o) => ({
    store: o.store,
    units: o.items.reduce((t, i) => t + i.destinationQuantity.reduce((s, d) => s + d.quantity, 0), 0),
    dc: o.items[0].shipToID,
  })).sort((x, y) => x.store.localeCompare(y.store))
}

const pa = pipeline(orig), pb = pipeline(patched)
const total = (p) => p.reduce((t, r) => t + r.units, 0)

console.log(`\nORIGINAL: ${pa.length} orders, ${total(pa)} units`)
console.log(`PATCHED : ${pb.length} orders, ${total(pb)} units`)

// Expected, straight from the X12's own SDQ segments.
const expected = { '167': 10, '351': 9, '363': 8, '370': 7, '371': 8, '372': 12, '378': 9, '7742': 9, '7760': 12, '7768': 11 }

console.log('\n| store | ORIGINAL | PATCHED | expected from the 850 | verdict |')
console.log('|---|---|---|---|---|')
const stores = [...new Set([...pa.map((r) => r.store), ...pb.map((r) => r.store), ...Object.keys(expected)])].sort()
let bad = 0
for (const s of stores) {
  const o = pa.find((r) => r.store === s)
  const p = pb.find((r) => r.store === s)
  const exp = expected[s]
  const ok = exp !== undefined ? (p && p.units === exp) : !p
  if (!ok) bad++
  console.log(`| ${s} | ${o ? o.units : '—'} | ${p ? p.units : '—'} | ${exp ?? '(not on this PO)'} | ${ok ? 'OK' : 'MISMATCH'} |`)
}
console.log(bad ? `\n${bad} MISMATCHES` : '\nPatched output matches the 850 exactly, store for store and unit for unit.')
