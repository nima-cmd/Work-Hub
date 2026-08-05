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
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: true, invoiced: true }),
    LABEL_GAP.HELD_FOR_PAYMENT,
  )
})

test('labelled and payment-clear is the real missed-click case', () => {
  assert.equal(
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: false, invoiced: true }),
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

// Nima, 2026-08-04, on what FOB Pending Approval actually is: "a shipment that is
// in china pending a pick up usually confirmed by our china warehouse but that's
// with someone in our NY office." We never dispatch it, so we never make its
// label — measured live, 12 of 12 China fulfilments carry ZERO tracking numbers
// while 11 have already shipped. Calling it "needs a label" invented work.
test('the China/FOB lane never asks for a label, held or not', () => {
  assert.equal(
    labelGapKind({ labelled: false, lane: 'fob', heldForPayment: false }),
    LABEL_GAP.FOB_PICKUP,
  )
  // ...and payment does NOT swallow it, same rule as every other lane: the
  // outstanding STEP is asked for first, the money is only ever context.
  assert.equal(
    labelGapKind({ labelled: false, lane: 'fob', heldForPayment: true }),
    LABEL_GAP.FOB_PICKUP,
  )
  // A label on a China shipment would be genuinely unusual evidence that it moved
  // some other way, so it is allowed back into the normal labelled branch rather
  // than being forced to stay FOB.
  assert.equal(
    labelGapKind({ labelled: true, lane: 'fob', heldForPayment: false, invoiced: true }),
    LABEL_GAP.LABELLED_NOT_SHIPPED,
  )
})

// ⚠️ The 2026-08-05 miss, and the fifth time the "walk the steps in order" lesson
// cost something. Overnight nine parcels were packed and labelled; the board then
// said "mark shipped" about all nine, and 9 of 9 had NO invoice and had not shipped.
// Acting on it would have marked nine orders Shipped with nothing billed.
test('a labelled parcel with no invoice is at step 2, not the ship decision', () => {
  assert.equal(
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: false, invoiced: false }),
    LABEL_GAP.NEEDS_INVOICE,
  )
  // ...and payment cannot pull it forward either: with no invoice there is no
  // balance to be held against, so the invoice is unambiguously the next step.
  assert.equal(
    labelGapKind({ labelled: true, lane: 'parcel', heldForPayment: true, invoiced: false }),
    LABEL_GAP.NEEDS_INVOICE,
  )
  const s = labelGapNeeded({
    labelled: true, lane: 'parcel', heldForPayment: false, invoiced: false,
    ifNumber: 'IF7442', labelCount: 1,
  })
  assert.match(s, /raise the invoice for IF7442/)
  assert.match(s, /Labelled \(1\)/)          // credits the label already printed
  assert.doesNotMatch(s, /shipped/)          // never claims a departure
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
    labelled: true, lane: 'parcel', heldForPayment: true, invoiced: true,
    ifNumber: 'IF7413', invoiceNumber: 'INV11361', invoiceTerms: 'Due on receipt',
    amountRemaining: 158, labelCount: 1,
  })
  assert.match(s, /^Held for payment/)
  assert.doesNotMatch(s, /mark .* shipped/)  // the false accusation PR #47 removed
})

test('a labelled, clear row asks for the status transition', () => {
  const s = labelGapNeeded({
    labelled: true, lane: 'parcel', heldForPayment: false, invoiced: true,
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
    for (const lane of ['parcel', 'freight', 'fob']) {
      for (const heldForPayment of [true, false]) {
       for (const invoiced of [true, false]) {
        const row = { labelled, lane, heldForPayment, invoiced, ifNumber: 'IF1', invoiceNumber: 'INV1', amountRemaining: 10, labelCount: 1 }
        const kind = labelGapKind(row)
        const needed = labelGapNeeded(row)
        if (kind === LABEL_GAP.HELD_FOR_PAYMENT) assert.match(needed, /^Held for payment/)
        if (kind === LABEL_GAP.NEEDS_LABEL) assert.match(needed, /no carrier label/)
        if (kind === LABEL_GAP.FREIGHT_BOL_LANE) assert.match(needed, /Freight\/BOL/)
        if (kind === LABEL_GAP.FOB_PICKUP) {
          assert.match(needed, /awaiting pickup/)
          // it must never name a label — that was the whole defect
          assert.doesNotMatch(needed, /label/)
        }
        if (kind === LABEL_GAP.LABELLED_NOT_SHIPPED) assert.match(needed, /mark IF1 shipped/)
        if (kind === LABEL_GAP.NEEDS_INVOICE) {
          assert.match(needed, /raise the invoice/)
          // must never claim it shipped — that was the 9-of-9 defect
          assert.doesNotMatch(needed, /shipped/)
        }
       }
      }
    }
  }
})
