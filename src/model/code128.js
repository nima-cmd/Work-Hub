// src/model/code128.js — GS1-128 for labels that do NOT go to the Zebra.
//
// Nima, 2026-09-11: "we have two version of label paper one is half a sheet and then
// we also ahve our 3x6 which would make things small i think thought wed have to
// inspect."
//
// ── ⚠️ I WROTE THE SYMBOL TABLE FROM MEMORY AND IT WAS WRONG IN 27 WAYS ─────
//
// Building the carton label I refused to hand-roll Code 128 and used the Zebra's
// `^BC…,D` instead, because one wrong bar pattern is an unscannable label at $250
// minimum. Then the half sheet arrived — 5.5 x 8.5 is laser stock, wider than the
// ZT411's 4 inch head — so those labels have to be a PDF, and a PDF draws its own
// bars. There is no printer to defer to.
//
// So I wrote the 107-pattern table out, and alongside it a verifyTable() asserting
// every invariant Code 128 guarantees. It reported 27 failures on my own table:
// seven symbols too many, eleven patterns summing to 10 or 12 modules instead of 11,
// an element of width 6 where the maximum is 4, and all four anchor symbols wrong.
//
// That is the whole argument. A table that looks plausible and is silently wrong
// prints 22 cartons of unscannable labels, and nobody finds out until the DC scans
// them. So the table is gone and this defers to bwip-js — a port of BWIPP, the
// reference implementation — which also VALIDATES the GS1 check digit and refuses
// (00)185072747098541641 rather than drawing it.
//
// ⚠️ THE LESSON GENERALISES: if a thing has a published table, get the table. The
// invariants I could check were real and still could not have proven a correct
// table — two transposed patterns pass every one of them.

import bwipjs from 'bwip-js'

/** GS1 requires 10 clear modules either side; a barcode butted to a rule fails to scan. */
export const QUIET_MODULES = 10

/**
 * ⚠️ STILL TEST-SCAN ONE. bwip-js draws correct bars; it cannot tell you the printer
 * rendered them at a readable density, which is exactly Nima's worry about the 3x6
 * ("which would make things small i think thought wed have to inspect").
 */
export const MUST_TEST_SCAN =
  'Scan carton 1 with a handheld before printing the other 21 — especially on the 3x6, where the bars are narrower.'

/**
 * A GS1-128 as a PNG buffer, for embedding in a PDF.
 *
 * @param ai     application identifier, e.g. '00' for an SSCC
 * @param value  its digits — the check digit is VALIDATED, not computed for you
 * @param scale  px per module. Below 2 the bars go under the 7.5 mil X-dimension
 *               GS1 sets as the practical floor for a laser-printed label.
 *
 * ⚠️ It throws on a bad check digit. That is wanted: a label that prints a wrong
 * SSCC scans cleanly and identifies the wrong carton, which is worse than one that
 * does not scan at all.
 */
export async function gs1BarcodePng(ai, value, { scale = 3, height = 12 } = {}) {
  const text = `(${String(ai).replace(/\D/g, '')})${String(value).replace(/\D/g, '')}`
  return bwipjs.toBuffer({
    bcid: 'gs1-128', text, includetext: false, scale, height,
    paddingwidth: QUIET_MODULES, paddingheight: 0,
  })
}

/** A plain Code 128 (PO numbers, postal codes) — no AI, no GS1 validation. */
export async function code128Png(text, { scale = 3, height = 10 } = {}) {
  return bwipjs.toBuffer({
    bcid: 'code128', text: String(text), includetext: false, scale, height,
    paddingwidth: QUIET_MODULES, paddingheight: 0,
  })
}

/**
 * ⚠️ X-DIMENSION IS THE THING THAT MAKES A SMALL LABEL UNSCANNABLE, and it is the
 * question Nima asked. GS1 General Specifications put the practical floor for a
 * GS1-128 on a distribution carton at 0.0075 in (7.5 mil) per module, 0.0098 in
 * (9.94 mil) for a label a DC scans in motion on a conveyor.
 *
 * An SSCC symbol is 211 modules wide plus 2 x 10 quiet modules = 231 modules. So the
 * barcode alone needs 231 x X inches of width, and this reports whether the width
 * you have left leaves it above the floor.
 */
export const SSCC_MODULES = 231
export const X_MIN_IN = 0.0075

/**
 * ⚠️ BAR HEIGHT IS A SEPARATE SPEC FROM X-DIMENSION, AND WE WERE UNDER IT.
 *
 * X-dimension decides whether the bars are wide enough to resolve; BAR HEIGHT decides
 * whether a scanner sweeping across at an angle stays inside the symbol. GS1 puts the
 * SSCC bar height on a logistics label at 31.75 mm (1.25 in) — and `gs1BarcodePng`
 * was being called with `height: 16` (mm), roughly half of it, on every stock.
 *
 * Measured on the rendered labels before this was fixed: the symbol drew 78.6pt tall
 * on the half sheet (1.09in), 57.7pt on the 4x6 (0.80in) and 22.8pt on the 3x6
 * (0.32in) — the last being a quarter of the specification.
 */
export const BAR_HEIGHT_MIN_IN = 1.25
export const BAR_HEIGHT_MIN_MM = 31.75
export const X_CONVEYOR_IN = 0.0098

export function xDimensionFor(availableWidthIn, modules = SSCC_MODULES) {
  const x = availableWidthIn / modules
  return {
    xIn: x,
    mils: Math.round(x * 10000) / 10,
    meetsMinimum: x >= X_MIN_IN,
    meetsConveyor: x >= X_CONVEYOR_IN,
    verdict: x >= X_CONVEYOR_IN ? 'good for conveyor scanning'
      : x >= X_MIN_IN ? 'scannable, but below the conveyor recommendation — hand-scan it'
        : `TOO SMALL — ${Math.round(x * 10000) / 10} mil is under the ${X_MIN_IN * 1000} mil floor; the symbol will not read reliably`,
  }
}
