// scripts/check-shipstation.js — verify the ShipStation credentials work.
// Run: npm run check:shipstation
//
// Prints ONLY pass/fail plus your store and carrier names — never a secret — so the
// output is safe to paste anywhere (including to Claude). READ-ONLY: every call here
// is a GET. Nothing is created, nothing is bought.
//
// ShipStation's API Settings screen shows a single masked "Token" for V1 rather than
// the classic Key + Secret pair, and the docs describe Basic auth for V1 and an
// API-Key header for V2 — so rather than guess, this tries each shape and reports
// which one your credential actually is.

const KEY = process.env.SHIPSTATION_API_KEY
const SECRET = process.env.SHIPSTATION_API_SECRET

if (!KEY) {
  console.log('❌ Not configured. Add to .env.local:')
  console.log('     SHIPSTATION_API_KEY=<the token from Settings → Account → API Settings>')
  console.log('     SHIPSTATION_API_SECRET=<only if your account shows a separate Secret>')
  process.exit(1)
}

const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')

// Candidate auth shapes, most likely first.
const CANDIDATES = [
  SECRET && { label: 'V1 Basic (key:secret)', base: 'https://ssapi.shipstation.com', path: '/stores', headers: { Authorization: basic(KEY, SECRET) } },
  { label: 'V2 API-Key header', base: 'https://api.shipstation.com', path: '/v2/carriers', headers: { 'API-Key': KEY } },
  { label: 'V1 Basic (token as user, blank pass)', base: 'https://ssapi.shipstation.com', path: '/stores', headers: { Authorization: basic(KEY, '') } },
  { label: 'V1 Bearer token', base: 'https://ssapi.shipstation.com', path: '/stores', headers: { Authorization: `Bearer ${KEY}` } },
].filter(Boolean)

let working = null
console.log('Probing which auth scheme this credential uses (read-only)…\n')

for (const c of CANDIDATES) {
  let res
  try {
    res = await fetch(c.base + c.path, { headers: { ...c.headers, Accept: 'application/json' } })
  } catch (e) {
    console.log(`   ${c.label.padEnd(38)} → network error: ${e.message}`)
    continue
  }
  if (res.ok) {
    console.log(`   ${c.label.padEnd(38)} → ✅ WORKS`)
    working = { ...c, data: await res.json().catch(() => null) }
    break
  }
  const hint = res.status === 401 || res.status === 403 ? 'rejected (wrong scheme or bad credential)' : `HTTP ${res.status}`
  console.log(`   ${c.label.padEnd(38)} → ${hint}`)
}

if (!working) {
  console.log('\n❌ None of the auth shapes worked. Likely causes:')
  console.log('   • The token was copied incompletely, or is masked/expired')
  console.log('   • Your account needs a SECRET too — set SHIPSTATION_API_SECRET')
  console.log('   • The key was generated for the other API version (V1 vs V2)')
  console.log('   Regenerate under Settings → Account → API Settings and copy it immediately.')
  process.exit(1)
}

console.log(`\n✅ Authenticated using: ${working.label}`)
console.log(`   Base URL: ${working.base}`)

const get = async (path) => {
  const r = await fetch(working.base + path, { headers: { ...working.headers, Accept: 'application/json' } })
  if (!r.ok) return { err: `HTTP ${r.status}` }
  return { data: await r.json().catch(() => null) }
}

// Stores / channels — we need the right one so wholesale never mixes with retail.
// Compare the HOST exactly. A substring test is wrong here and silently broke this:
// 'ssapi.shipstation.com' CONTAINS 'api.shipstation.com' (it's ss + api…), so the V1
// host was misread as V2, a /v2 path was called against V1, and nothing printed.
const isV2 = new URL(working.base).host === 'api.shipstation.com'
if (!isV2) {
  const stores = await get('/stores')
  if (stores.err) console.log(`\n⚠️  couldn't list stores (${stores.err})`)
  else {
    const list = Array.isArray(stores.data) ? stores.data : []
    console.log(`\n🏬 Stores / channels (${list.length}) — pick one for wholesale:`)
    for (const s of list) {
      console.log(`   id=${String(s.storeId).padEnd(8)} ${s.active === false ? '(inactive) ' : ''}${s.storeName}`)
    }
  }
  const carriers = await get('/carriers')
  if (carriers.err) console.log(`\n⚠️  couldn't list carriers (${carriers.err})`)
  else if (!Array.isArray(carriers.data)) console.log('\n⚠️  carriers came back in an unexpected shape')
  else {
    console.log(`\n🚚 Carriers (${carriers.data.length}):`)
    for (const c of carriers.data) {
      const bal = c.balance !== undefined && c.balance !== null ? ` balance=${c.balance}` : ''
      console.log(`   ${String(c.code).padEnd(12)} ${c.name}${bal}${c.primary ? '  [primary]' : ''}`)
    }
  }
} else {
  const carriers = await get('/v2/carriers')
  if (carriers.err) console.log(`\n⚠️  couldn't list carriers (${carriers.err})`)
  else {
    const list = carriers.data?.carriers || []
    console.log(`\n🚚 Carriers (${list.length}):`)
    for (const c of list) {
      console.log(`   ${String(c.carrier_code).padEnd(14)} ${c.friendly_name || c.nickname || ''}  id=${c.carrier_id}`)
    }
  }
}

console.log('\n🎉 ShipStation is reachable read-only. Nothing was created, modified, or purchased.')
