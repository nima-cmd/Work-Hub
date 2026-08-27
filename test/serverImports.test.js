// test/serverImports.test.js — every name server/ imports from a sibling must exist.
//
// ⚠️ WHY THIS EXISTS. `fileShipmentToDrive` and `rememberDriveFiles` were deleted from
// server/queries.js by an over-greedy edit and merged to main. ALL 1,244 TESTS PASSED,
// because nothing in the suite has ever loaded server/index.js — the model is tested
// exhaustively and the wiring between server modules was tested not at all. The app
// died at startup with "does not provide an export named 'fileShipmentToDrive'", which
// is a SYNTAX-LEVEL failure: not one route worked, and the deploy could not boot.
//
// ⚠️ It is deliberately STATIC — it reads the files rather than importing them. An
// import of server/queries.js opens a database pool and needs credentials, so a test
// that did that would be skipped in CI and would never run when it mattered. Text
// analysis needs neither and catches the same class.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Named imports from relative paths: `import { a, b as c } from './x.js'`. */
function localImports(src) {
  const out = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const names = m[1].split(',').map((n) => n.trim()).filter(Boolean)
      // `a as b` imports `a`; the local alias is irrelevant to whether it exists.
      .map((n) => n.split(/\s+as\s+/)[0].trim())
      .filter((n) => n && n !== 'type')
    out.push({ from: m[2], names })
  }
  return out
}

/** Every name a module exports, however it is written. */
function exportedNames(src) {
  const out = new Set()
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1])
  for (const m of src.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/gm)) out.add(m[1])
  // `export { a, b as c }` — the EXPORTED name is what matters, so take the alias.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/)
      const name = (parts[1] || parts[0] || '').trim()
      if (name) out.add(name)
    }
  }
  return out
}

const serverFiles = readdirSync(join(ROOT, 'server'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => join('server', f))

test('every named import in server/ resolves to a real export', () => {
  const missing = []
  for (const rel of serverFiles) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    for (const { from, names } of localImports(src)) {
      const target = resolve(ROOT, dirname(rel), from)
      let targetSrc
      try { targetSrc = readFileSync(target, 'utf8') } catch { continue } // not a file we can read
      const exported = exportedNames(targetSrc)
      for (const n of names) {
        if (!exported.has(n)) missing.push(`${rel} imports { ${n} } from ${from} — not exported there`)
      }
    }
  }
  assert.deepEqual(missing, [], `\n${missing.join('\n')}\n`)
})

test('the guard can actually see a missing export', () => {
  // ⚠️ A checker that cannot fail proves nothing — the lesson from the held-calendar
  // test that asserted an impossible state. Exercised on synthetic sources.
  const target = 'export function present() {}\nexport const alsoPresent = 1\n'
  const exported = exportedNames(target)
  assert.equal(exported.has('present'), true)
  assert.equal(exported.has('alsoPresent'), true)
  assert.equal(exported.has('gone'), false)

  const imports = localImports("import { present, gone } from './x.js'\n")
  assert.deepEqual(imports, [{ from: './x.js', names: ['present', 'gone'] }])
})

test('aliases are understood on both sides', () => {
  assert.deepEqual(localImports("import { a as b } from './x.js'")[0].names, ['a'])
  assert.equal(exportedNames('export { inner as outer }').has('outer'), true)
  assert.equal(exportedNames('export { inner as outer }').has('inner'), false)
})
