import test from 'node:test'
import assert from 'node:assert/strict'
import { labelGapKind, labelGapNeeded, LABEL_GAP } from '../src/model/labelGap.js'

// The ordering these lock down comes from Nima's flow (2026-08-04): "a label is
// created, the next step is the creation of an invoice, and then after we need to
// know if we can ship it." Document → invoice → ship decision.

test('an unlabelled parcel needs its label even when payment is holding it', () => {
  // THE REGRESSION. IF7414: $90,654 owed, 6 days old, ZERO labels — the oldest
  // item on the board, silenced because the payment test ran first.
  assert.equal(
    labelGapKind({ labelled: false, lane: 'parcel', heldForPayment: true }),
    LABEL_GAP.NEEDS_LABEL,
  )
})

test('payment only parks a shipment whose label already exists', () => {
  // IF7413 / IF7409: 1 label each, deliberately held. This is the case PR #47
  // fixed — they must NOT read as a forgotten "mark shipped" click.
  assert.equal(
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: true }),
    LABEL_GAP.HELD_FOR_PAYMENT,
  )
})

test('labelled and payment-clear is the real missed-click case', () => {
  assert.equal(
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: false }),
    LABEL_GAP.LABELLED_NOT_SHIPPED,
  )
})

test('an unlabelled parcel with nothing owed simply needs a label', () => {
  assert.equal(
    labelGapKind({ labelled: false, lane: 'parcel', heldForPayment: false }),
    LABEL_GAP.NEEDS_LABEL,
  )
})

// Freight never carries a parcel tracking number, so it must never be counted as
// needing a label (12 of the first 16 hits were exactly this noise).
test('freight is its own lane, labelled or not, held or not', () => {
  assert.equal(
    labelGapKind({ labelled: false, lane: 'freight', heldForPayment: false }),
    LABEL_GAP.FREIGHT_BOL_LANE,
  )
  assert.equal(
    labelGapKind({ labelled: false, lane: 'freight', heldForPayment: true }),
    LABEL_GAP.FREIGHT_BOL_LANE,
  )
})

// ── the sentence on the row ──────────────────────────────────────────────────

test('a held, unlabelled row names the label as the action and the balance as context', () => {
  const s = labelGapNeeded({
    labelled: false, lane: 'parcel', heldForPayment: true,
    ifNumber: 'IF7414', invoiceNumber: 'INV11358', amountRemaining: 90654.4,
  })
  // The ACTION is the label; the money explains why no departure follows.
  assert.match(s, /create one for IF7414/)
  assert.match(s, /payment still holds the departure/)
  assert.match(s, /\$90,654\.4/)
})

test('a held, labelled row states the hold, not a missed click', () => {
  const s = labelGapNeeded({
    labelled: true, lane: 'parcel', heldForPayment: true,
    ifNumber: 'IF7413', invoiceNumber: 'INV11361', invoiceTerms: 'Due on receipt',
    amountRemaining: 158, labelCount: 1,
  })
  assert.match(s, /^Held for payment/)
  assert.doesNotMatch(s, /mark .* shipped/)  // the false accusation PR #47 removed
})

test('a labelled, clear row asks for the status transition', () => {
  const s = labelGapNeeded({
    labelled: true, lane: 'parcel', heldForPayment: false,
    ifNumber: 'IF7288', labelCount: 2,
  })
  assert.match(s, /mark IF7288 shipped in NetSuite/)
  assert.match(s, /2 label\(s\)/)
})

// The sentence and the chip are derived from ONE call for this reason: a row that
// reads "held for payment" while being counted under "need a label" is how both
// previous versions of this logic went unnoticed.
test('the sentence always agrees with the kind', () => {
  for (const labelled of [true, false]) {
    for (const lane of ['parcel', 'freight']) {
      for (const heldForPayment of [true, false]) {
        const row = { labelled, lane, heldForPayment, ifNumber: 'IF1', invoiceNumber: 'INV1', amountRemaining: 10 }
        const kind = labelGapKind(row)
        const needed = labelGapNeeded(row)
        if (kind === LABEL_GAP.HELD_FOR_PAYMENT) assert.match(needed, /^Held for payment/)
        if (kind === LABEL_GAP.NEEDS_LABEL) assert.match(needed, /no carrier label/)
        if (kind === LABEL_GAP.FREIGHT_BOL_LANE) assert.match(needed, /Freight\/BOL/)
        if (kind === LABEL_GAP.LABELLED_NOT_SHIPPED) assert.match(needed, /mark IF1 shipped/)
      }
    }
  }
})
