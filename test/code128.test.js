// test/code128.test.js — the barcode for labels that do not go to the Zebra.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gs1BarcodePng, code128Png, xDimensionFor, SSCC_MODULES, X_MIN_IN, X_CONVEYOR_IN, MUST_TEST_SCAN,
} from '../src/model/code128.js'

test('⚠️ A BAD SSCC CHECK DIGIT IS REFUSED, NOT DRAWN', () => {
  // This is the reason for using a reference implementation rather than my own
  // table: a label that prints a WRONG SSCC scans cleanly and identifies the wrong
  // carton, which is worse than one that does not scan at all.
  return Promise.all([
    gs1BarcodePng('00', '185072747098541640').then((b) => assert.ok(b.length > 500, 'a valid SSCC renders')),
    gs1BarcodePng('00', '185072747098541641').then(
      () => assert.fail('a wrong check digit must not render'),
      (e) => assert.match(String(e.message || e), /checksum/i)),
  ])
})

test('⚠️ THE 3x6 IS A MARGIN PROBLEM, NOT A PAPER PROBLEM', () => {
  // Nima: "our 3x6 which would make things small i think thought wed have to
  // inspect." An SSCC symbol is 231 modules wide with quiet zones, so the usable
  // width divided by 231 is the X-dimension — what decides whether a DC scanner
  // reads it. At a half-inch margin the 3x6 falls under the conveyor spec; at a
  // quarter inch it clears it. This PO is XDOCK, so conveyor is the case that counts.
  assert.equal(SSCC_MODULES, 231)
  const half = xDimensionFor(3.0 - 0.5 * 2)
  assert.equal(half.meetsMinimum, true)
  assert.equal(half.meetsConveyor, false, 'a half-inch margin is below the conveyor spec')
  const quarter = xDimensionFor(3.0 - 0.25 * 2)
  assert.equal(quarter.meetsConveyor, true)
  assert.ok(quarter.mils >= 10)
  // The half sheet has room to spare either way.
  assert.equal(xDimensionFor(5.5 - 0.5 * 2).meetsConveyor, true)
})

test('a width that cannot carry the symbol says so plainly', () => {
  const tiny = xDimensionFor(1.0)
  assert.equal(tiny.meetsMinimum, false)
  assert.match(tiny.verdict, /TOO SMALL/)
  assert.match(tiny.verdict, /under the 7.5 mil floor/)
})

test('⚠️ THE INSTRUCTION TO TEST-SCAN IS PART OF THE MODULE', () => {
  // bwip-js draws correct bars; it cannot tell you the printer rendered them at a
  // readable density. That is exactly the thing Nima said he would inspect.
  assert.match(MUST_TEST_SCAN, /Scan carton 1/)
  assert.match(MUST_TEST_SCAN, /3x6/)
})

test('a plain Code 128 renders for the PO number', async () => {
  const png = await code128Png('8928906')
  assert.ok(png.length > 300)
})
