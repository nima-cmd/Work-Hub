// test/packingSlipRevision.test.js — a reissued slip is news, not a silent overwrite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { slipRevision } from '../src/model/packingSlipRevision.js'

const stored = { container_num: '55 Container 2026.9.7', unit_count: 1439, carton_count: 55, po_numbers: ['1747','1761','1785','1820'] }
const same = { containerNum: '55 Container 2026.9.7', unitCount: 1439, cartonCount: 55, poNumbers: ['1785','1761','1820','1747'] }

test('a brand-new container is new, not a revision', () => {
  const r = slipRevision(null, same)
  assert.equal(r.isNew, true)
  assert.equal(r.changed, false)
  assert.equal(r.revision, null)
})

test('⚠️ RE-IMPORTING THE SAME FILE IS SILENT', () => {
  // Dropping a slip in twice is normal — checking it landed, re-running after a fix
  // elsewhere. Logging that as a revision fills the history with non-events and
  // trains everyone to ignore it. PO order must not matter either.
  const r = slipRevision(stored, same)
  assert.equal(r.changed, false)
  assert.deepEqual(r.changes, [])
  assert.equal(r.revision, null)
})

test('⚠️ CHANGED TOTALS ARE RECORDED BEFORE THE REPLACE', () => {
  // The Item Receipt may already have gone to NetSuite on the old numbers, so the
  // fact that they moved cannot vanish with the rows being replaced.
  const r = slipRevision(stored, { ...same, unitCount: 1400, cartonCount: 54 })
  assert.equal(r.changed, true)
  assert.equal(r.revision.prevUnits, 1439)
  assert.equal(r.revision.newUnits, 1400)
  assert.match(r.changes.join(' '), /units 1439 -> 1400/)
  assert.match(r.changes.join(' '), /cartons 55 -> 54/)
})

test('⚠️ A PO THAT DISAPPEARS IS THE SERIOUS ONE', () => {
  // Its units may already be received against the previous version of this slip.
  const r = slipRevision(stored, { ...same, poNumbers: ['1785','1761','1820'] })
  assert.equal(r.changed, true)
  assert.match(r.changes.join(' '), /no longer on the slip: 1747/)
  assert.match(r.changes.join(' '), /already received/)
})

test('a PO added is reported, more quietly', () => {
  const r = slipRevision(stored, { ...same, poNumbers: [...stored.po_numbers, '1900'] })
  assert.match(r.changes.join(' '), /PO added: 1900/)
})

test('⚠️ CARTONS BECOMING UNKNOWN IS LOUDER THAN CARTONS BECOMING KNOWN', () => {
  // A master list replacing a factory slip LOSES the box map. That is a downgrade in
  // what we can answer, so it must not read like an ordinary change.
  const lost = slipRevision(stored, { ...same, cartonCount: null })
  assert.match(lost.changes.join(' '), /NO LONGER KNOWN \(was 55\)/)

  const gained = slipRevision({ ...stored, carton_count: null }, same)
  assert.match(gained.changes.join(' '), /cartons now known: 55/)
})

test('it reads camelCase rows too, not only the database projection', () => {
  const r = slipRevision({ unitCount: 100, cartonCount: 2, poNumbers: ['1'] }, { containerNum: 'x', unitCount: 100, cartonCount: 2, poNumbers: ['1'] })
  assert.equal(r.changed, false)
})

test('⚠️ NO CHARACTER OUTSIDE WinAnsi IN A CHANGE LINE', () => {
  const r = slipRevision(stored, { ...same, unitCount: 1400, cartonCount: null, poNumbers: ['1785'] })
  for (const c of r.changes) assert.doesNotMatch(c, /[←-⯿]/, c)
})
