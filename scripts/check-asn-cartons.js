// scripts/check-asn-cartons.js — did every carton that shipped get announced?
//
//   npm run check:asn-cartons                 # POs from the 5 most recent ASNs
//   npm run check:asn-cartons -- --recent 20  # widen the window
//   npm run check:asn-cartons -- --po 7527086 --po 7776940
//
// Read-only: SuiteQL SELECTs and Orderful GETs, nothing written anywhere.
//
// WHY THE SCOPE IS BY PO, not by date. An 856 is a consolidated manifest, and a
// carton can perfectly legitimately have been announced on an ASN sent weeks
// earlier. Scoping to "recent 856s" would therefore report those cartons as
// unannounced — a false alarm on the exact check whose whole value is that it
// doesn't cry wolf. Scoping by PURCHASE ORDER closes that hole: for a PO we pull
// EVERY outbound 856 that references it (edi_document_po_refs is complete —
// all 819 are po_refs_checked) alongside every carton NetSuite has for it.
//
// ⚠️ The carton query deliberately omits ediPackagesLive's `status <> 'C'`
// filter. That feed only carries UNSHIPPED fulfilments and is replaced each
// sync, so by the time an 856 exists the cartons have left it by design. This
// check needs precisely the shipped ones.
import { runSuiteQL, netsuiteConfigured } from '../src/ingest/netsuiteApi.js'
import { extractAsnManifest } from '../src/ingest/orderfulAsn.js'
import { checkAsnCartons, undeclaredByFulfilment, asnSummary } from '../src/model/asnCartonCheck.js'
import { pool } from '../src/db.js'

const API_BASE = 'https://api.orderful.com/v3/transactions'

function parseArgs(argv) {
  const pos = []
  let recent = 5
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--po' && argv[i + 1]) pos.push(argv[++i])
    else if (argv[i] === '--recent' && argv[i + 1]) recent = Number(argv[++i]) || 5
  }
  return { pos, recent }
}

async function fetchMessage(apiKey, id) {
  const res = await fetch(`${API_BASE}/${id}/message`, {
    headers: { 'orderful-api-key': apiKey, 'Content-Type': 'application/json' },
  })
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  return { ok: true, message: await res.json() }
}

const main = async () => {
  const { pos: wantPos, recent } = parseArgs(process.argv.slice(2))
  const apiKey = process.env.ORDERFUL_API_KEY
  if (!apiKey) { console.error('ORDERFUL_API_KEY not set — nothing to compare against.'); process.exit(1) }
  if (!netsuiteConfigured()) { console.error('NetSuite not configured — cannot read cartons.'); process.exit(1) }

  // 1. Which POs are we checking?
  let pos = wantPos
  if (!pos.length) {
    // Ordered by when the ASN was actually sent, not by PO number — PO numbers
    // are not chronological, so sorting on them makes "--recent" a lie.
    const { rows } = await pool.query(`
      SELECT r.po_number, MAX(t.created_at) AS latest
        FROM edi_document_po_refs r
        JOIN edi_transactions t ON t.id = r.transaction_id
       WHERE t.type ILIKE '%856%' AND t.direction = 'OUT' AND t.stream = 'LIVE'
       GROUP BY r.po_number
       ORDER BY latest DESC
       FETCH FIRST $1 ROWS ONLY`, [recent])
    pos = rows.map((r) => r.po_number)
  }
  if (!pos.length) { console.log('No POs to check.'); return }
  console.log(`Checking ${pos.length} PO(s): ${pos.join(', ')}\n`)

  // 2. Every outbound 856 that references them — with the PO set CLOSED over
  //    those documents first.
  //
  //    ⚠️ This closure is not optional. An 856 is a consolidated manifest and we
  //    take every SSCC on it, so if a document also covers a PO outside the
  //    scope, that PO's cartons are never pulled and show up as phantom boxes.
  //    Measured on real data 2026-07-31: scoping to PO 6592086 alone reported 12
  //    phantoms, and ASN 6592086SC turned out to span four POs (6592086,
  //    6594176, 6706607, 6706717). With the closure the same run is clean.
  const docsForPos = async (ps) => (await pool.query(`
      SELECT DISTINCT t.id, t.business_number, t.delivery_status, t.trading_partner
        FROM edi_transactions t
        JOIN edi_document_po_refs r ON r.transaction_id = t.id
       WHERE t.type ILIKE '%856%' AND t.direction = 'OUT' AND t.stream = 'LIVE'
         AND r.po_number = ANY($1)
       ORDER BY t.id`, [ps])).rows

  const scope = new Set(pos)
  let docs = []
  for (let pass = 0; pass < 10; pass++) {
    docs = await docsForPos([...scope])
    if (!docs.length) break
    const { rows: co } = await pool.query(
      'SELECT DISTINCT po_number FROM edi_document_po_refs WHERE transaction_id = ANY($1)',
      [docs.map((d) => d.id)])
    const before = scope.size
    for (const r of co) scope.add(r.po_number)
    if (scope.size === before) break
  }
  if (scope.size > pos.length) {
    console.log(`Scope closed over co-listed POs: ${pos.length} → ${scope.size}`)
  }
  pos = [...scope]
  const delivered = docs.filter((d) => d.delivery_status === 'DELIVERED')
  const undelivered = docs.filter((d) => d.delivery_status !== 'DELIVERED')
  console.log(`${docs.length} outbound 856(s): ${delivered.length} delivered, ${undelivered.length} not`)
  if (undelivered.length) {
    console.log(`  ⚠ not delivered (announced nothing): ${undelivered.map((d) => `${d.business_number}[${d.delivery_status}]`).join(', ')}`)
  }

  // 3. Their carton manifests.
  const declared = []
  let msgErrors = 0
  let packsWithoutSscc = 0
  for (const d of delivered) {
    const r = await fetchMessage(apiKey, d.id)
    if (!r.ok) { msgErrors++; console.log(`  ! ${d.business_number}: ${r.error}`); continue }
    const m = extractAsnManifest(r.message)
    packsWithoutSscc += m.packsWithoutSscc
    for (const sscc of m.ssccs) declared.push({ sscc, transactionId: d.id, businessNumber: d.business_number })
  }
  console.log(`ASN cartons declared: ${declared.length}${packsWithoutSscc ? ` (+${packsWithoutSscc} pack segments with no SSCC)` : ''}${msgErrors ? ` — ${msgErrors} message(s) unreadable` : ''}`)

  // 4. What NetSuite says actually shipped. Sequential on purpose (NetSuite
  //    governs by CONCURRENT requests and Celigo shares the allowance).
  const ifq = await runSuiteQL(`
    SELECT id, tranid, status, custbody_po_cd_identifier AS po_dc
      FROM transaction
     WHERE type='ItemShip' AND (${pos.map((p) => `custbody_po_cd_identifier LIKE '${p}-%'`).join(' OR ')})`)
  if (!ifq.ok) { console.error('fulfilment query failed:', ifq.error); process.exit(1) }
  const ifs = ifq.rows
  const shipped = ifs.filter((r) => r.status === 'C')
  console.log(`NetSuite fulfilments: ${ifs.length} (${shipped.length} shipped)`)
  if (!shipped.length) { console.log('\nNothing shipped on these POs yet — nothing to reconcile.'); return }

  const pk = await runSuiteQL(`
    SELECT custrecord_hb_edi_pack_related_iff AS if_id,
           custrecord_hb_edi_package_ucc AS ucc
      FROM customrecord_hb_edi_packages
     WHERE isinactive = 'F'
       AND custrecord_hb_edi_pack_related_iff IN (${shipped.map((r) => r.id).join(',')})`)
  if (!pk.ok) { console.error('carton query failed:', pk.error); process.exit(1) }

  const byId = new Map(shipped.map((r) => [String(r.id), r]))
  const packed = pk.rows.map((c) => {
    const f = byId.get(String(c.if_id))
    return { sscc: c.ucc, ifNumber: f?.tranid ?? null, poDc: f?.po_dc ?? null }
  })

  // 5. The verdict.
  const result = checkAsnCartons({ packed, declared })
  console.log(`\n── ${asnSummary(result)} — ${result.status.toUpperCase()}`)
  const c = result.counts
  console.log(`   matched ${c.matched} · unannounced ${c.undeclared} · phantom ${c.phantom} · blank SSCC ${c.blankSscc} · duplicated ${c.duplicated}`)
  if (c.reDeclared) {
    // Accounts for the difference between the raw declared count printed above
    // and the unique carton count here, so the two never look contradictory.
    console.log(`   ${c.reDeclared} carton(s) announced on more than one ASN (re-sent 856s) — usually benign`)
  }

  if (result.undeclared.length) {
    console.log('\n⚠ SHIPPED BUT NEVER ANNOUNCED — these partners received unexpected cartons:')
    for (const g of undeclaredByFulfilment(result)) {
      console.log(`   ${g.ifNumber || '(unknown IF)'} [${g.poDc || '?'}] — ${g.ssccs.length} carton(s)`)
      for (const s of g.ssccs.slice(0, 5)) console.log(`      ${s}`)
      if (g.ssccs.length > 5) console.log(`      … ${g.ssccs.length - 5} more`)
    }
  }
  if (result.phantom.length) {
    console.log('\n⚠ ANNOUNCED BUT NOT IN NETSUITE — the partner is waiting for a box that may not exist:')
    for (const p of result.phantom.slice(0, 10)) console.log(`   ${p.sscc} on ${p.declaredOn.join(', ')}`)
    if (result.phantom.length > 10) console.log(`   … ${result.phantom.length - 10} more`)
  }
  if (result.blankSscc.length) {
    const ifsBlank = [...new Set(result.blankSscc.map((b) => b.ifNumber))]
    console.log(`\n⚠ ${result.blankSscc.length} carton(s) have NO SSCC — unreconcilable either way: ${ifsBlank.join(', ')}`)
  }
  if (result.duplicated.length) {
    console.log('\n⚠ DUPLICATE SSCC — one license plate on more than one carton:')
    for (const d of result.duplicated) console.log(`   ${d.sscc} ×${d.count} (${d.ifNumbers.join(', ')})`)
  }
  if (result.clean) console.log('\n✓ Every shipped carton is on a delivered ASN.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => pool.end())
