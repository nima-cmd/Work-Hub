// test/upcBarcode.test.js — the barcode, checked against a real printed tag.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  upcCheckDigit, upcError, isValidUpc, upcHumanReadable, upcModules, upcBars,
  SYMBOL_MODULES, QUIET_MODULES,
} from '../src/model/upcBarcode.js'

// The tag Nima photographed: SN03012LD Bordeaux, "St. Barths Small Tote", $285.00.
const REAL = '840470897966'

// Every UPC in catalogue_skus as of 2026-08-31, straight from the database.
const CATALOGUE = JSON.parse(readFileSync(new URL('./fixtures/catalogueUpcs.json', import.meta.url)))

test('⚠️ THE PRINTED TAG IS THE SPEC — its check digit and grouping both reproduce', () => {
  // The bars on the photo carry "8 40470 89796 6". If either of these disagreed with the
  // tag, the encoder would be wrong and every label printed from it would be wrong the
  // same way — which is why the reference is a physical object, not my reading of a spec.
  assert.equal(upcCheckDigit('84047089796'), 6)
  assert.equal(isValidUpc(REAL), true)
  assert.deepEqual(upcHumanReadable(REAL), { lead: '8', left: '40470', right: '89796', check: '6' })
})

test('⚠️ ALL 77 REAL CATALOGUE UPCs ARE SELF-CONSISTENT', () => {
  // Not a formality. If one of these failed, the number in our catalogue would not
  // describe the item it claims to, and a hang tag would scan as something else. This
  // asserts the encoder AND the data at once.
  assert.equal(CATALOGUE.length, 77)
  const bad = CATALOGUE.filter((r) => !isValidUpc(r.upc))
  assert.deepEqual(bad, [], `these catalogue UPCs fail their own check digit: ${bad.map((r) => `${r.skuKey}=${r.upc}`).join(', ')}`)
  // And all three GS1 company prefixes are represented, so this is not one block of numbers.
  const prefixes = new Set(CATALOGUE.map((r) => String(r.upc).slice(0, 6)))
  assert.deepEqual([...prefixes].sort(), ['810077', '840470', '850021'])
})

test('a refusal NAMES its cause — never a bare false', () => {
  assert.equal(upcError(REAL), null)
  assert.match(upcError(''), /no UPC/)
  assert.match(upcError('84047089796'), /12 digits, this is 11/)
  assert.match(upcError('8404708979660'), /12 digits, this is 13/)
  assert.match(upcError('84047089796X'), /digits only/)
  // ⚠️ The one that matters most: present, 12 digits, and NOT self-consistent.
  assert.match(upcError('840470897967'), /check digit is 7 but the first 11 digits require 6/)
})

test('⚠️ an inconsistent UPC produces NO BARS AT ALL', () => {
  // A barcode that does not scan is an annoyance. One that scans as the wrong number is
  // a bag that rings up as another bag. So a number that fails its own check digit must
  // not be drawable.
  assert.equal(upcModules('840470897967'), null)
  assert.equal(upcBars('840470897967'), null)
  assert.equal(upcHumanReadable('84047089796'), null)
})

test('the symbol is 95 modules, guards and centre in the right places', () => {
  const m = upcModules(REAL)
  assert.equal(m.length, SYMBOL_MODULES)
  assert.equal(m.slice(0, 3), '101', 'left guard')
  assert.equal(m.slice(45, 50), '01010', 'centre guard')
  assert.equal(m.slice(92, 95), '101', 'right guard')
})

test('right-hand patterns are the complement of the left — that is what makes it readable upside down', () => {
  // '0' encodes as 0001101 on the left and must be 1110010 on the right.
  const zero = upcModules('000000000000')
  assert.equal(zero.slice(3, 10), '0001101', 'left 0')
  assert.equal(zero.slice(50, 57), '1110010', 'right 0')
})

test('⚠️ the quiet zones are part of the symbol, not padding', () => {
  // A scanner needs clear space either side to find the guard bars. A barcode butted
  // against a label edge or against text is the commonest reason a correct tag will not
  // read, so the geometry carries them and a caller cannot forget.
  const b = upcBars(REAL)
  assert.equal(b.quiet, QUIET_MODULES)
  assert.equal(b.totalModules, SYMBOL_MODULES + QUIET_MODULES * 2)
})

test('guard and centre bars are TALL, the digit bars are not', () => {
  // The descender is how a printed UPC gets its shape — without it the symbol scans but
  // looks wrong to anyone who handles retail tags.
  const { bars } = upcBars(REAL)
  const tall = bars.filter((x) => x.tall)
  assert.equal(tall.length, 6, 'two bars per guard, three guards')
  for (const g of tall) assert.equal(g.width, 1, 'guard bars are single modules')
  assert.ok(bars.some((x) => !x.tall), 'and the data bars are short')
})

test('bars never overlap and stay inside the symbol', () => {
  const { bars } = upcBars(REAL)
  let prevEnd = -1
  for (const b of bars) {
    assert.ok(b.at > prevEnd, `bar at ${b.at} overlaps the previous one`)
    assert.ok(b.at + b.width <= SYMBOL_MODULES, 'bar runs past the symbol')
    prevEnd = b.at + b.width - 1
  }
})

test('spaces and dashes in a typed UPC are tolerated', () => {
  // The human-readable form is printed with spaces, so it will get typed back that way.
  assert.equal(isValidUpc('8 40470 89796 6'), true)
  assert.equal(isValidUpc('840470-897966'), true)
})

test('check digit refuses anything that is not 11 digits', () => {
  assert.equal(upcCheckDigit('1234567890'), null)
  assert.equal(upcCheckDigit('123456789012'), null)
  assert.equal(upcCheckDigit(''), null)
  assert.equal(upcCheckDigit(null), null)
})
