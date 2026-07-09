// src/model/stages.js
// The canonical fulfillment pipeline.
//
// This ordering IS the shared model: the tracker uses it to place orders, and
// BitaQuest will later read it to turn "what needs doing" into quests. Keep it
// the single source of truth for stage names — don't hardcode these strings
// elsewhere.

export const STAGE = {
  ON_HOLD: 'ON_HOLD_APPROVAL',
  OPEN: 'OPEN_NEEDS_FULFILLMENT',
  PICKED: 'PICKED_NEEDS_PACK',
  PACKED: 'PACKED_PENDING_NEXT',
  INVOICED: 'INVOICED_PENDING_PAYMENT',
  APPROVED: 'APPROVED_FOR_SHIPPING',
  SHIPPED: 'SHIPPED',
}

// Higher rank = further along. Used to pick an order's "current" stage when it
// shows up in more than one saved search at the same time.
export const STAGE_RANK = {
  [STAGE.ON_HOLD]: 0,
  [STAGE.OPEN]: 1,
  [STAGE.PICKED]: 2,
  [STAGE.PACKED]: 3,
  [STAGE.INVOICED]: 4,
  [STAGE.APPROVED]: 5,
  [STAGE.SHIPPED]: 6,
}

export const STAGE_LABEL = {
  [STAGE.ON_HOLD]: 'On hold — awaiting approval',
  [STAGE.OPEN]: 'Open — needs Item Fulfillment',
  [STAGE.PICKED]: 'Picked — with warehouse',
  [STAGE.PACKED]: 'Packed — watching for invoice',
  [STAGE.INVOICED]: 'Invoiced — pending payment',
  [STAGE.APPROVED]: 'Approved for shipping',
  [STAGE.SHIPPED]: 'Shipped',
}

// The single next action a human should take at each stage.
export const NEXT_ACTION = {
  [STAGE.ON_HOLD]: 'Wait — do not fulfill yet',
  [STAGE.OPEN]: 'Create an Item Fulfillment',
  [STAGE.PICKED]: 'Pack it',
  [STAGE.PACKED]: 'Invoice / progress it',
  [STAGE.INVOICED]: 'Follow up on payment',
  [STAGE.APPROVED]: 'Ship it out',
  [STAGE.SHIPPED]: '—',
}

// Return whichever of two stages is further along the pipeline.
export function furthestStage(a, b) {
  if (!a) return b
  if (!b) return a
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b
}
