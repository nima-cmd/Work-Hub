// src/model/pushRemedy.js — when a ShipStation push refuses, what can be done about it?
//
// Nima, 2026-08-31, after a push that appeared to do nothing: "i tried to push this label
// to shipstation again it originally was wrong in its number of boxes but i dodnt see it
// in shipstation." IF7616 carried three NetSuite labels and no dead-label markers, so the
// push hit ALREADY_LABELLED and stopped — correctly. The refusal was right; the DEAD END
// was the defect. He then asked the real question: "how can i mark them dead in the app
// manually so it lets me push to shipstation."
//
// ⚠️ THE REMEDY BELONGED WHERE THE REFUSAL HAPPENS. The dead-label button existed, but on
// exactly one line of the Ship Desk — the `labelledNotShipped` column — so 13 labelled
// IFs held for payment had no route to it at all. PR #100 put that button "on the row
// where you notice"; this is the same principle applied to the row where he now notices,
// which is a card with a push button on it.
//
// ⚠️ AND IT IS A TESTED FUNCTION, NOT A CONDITION IN JSX, for the reason
// showsParcelPushButton is: the previous decision here was a REGEX OVER PROSE —
// `/NetSuite/i.test(reason) && !/already has/i.test(reason)` — so a reworded server
// message would have silently changed which button the operator is offered. Two such
// decisions in one component is one too many to leave untested.

export const REMEDY = {
  /** The location blocks it, but the block is a conflict a human may override. */
  FORCE: 'force',
  /** Labels already exist. They must be declared unusable before anything can be pushed. */
  KILL_LABELS: 'kill_labels',
  /** Nothing the operator can do here — the refusal is a fact about the data. */
  NONE: 'none',
}

/**
 * Read a push response and say what to offer.
 *
 * @param res     the /api/shipstation/push body
 * @param forced  was this attempt already a forced one?
 *
 * ⚠️ THE LIVE LABELS COME FROM THE RESPONSE, not from the caller. The server attaches
 * them to an ALREADY_LABELLED refusal because it computed the hold FROM them — so the
 * client cannot disagree with the gate about which labels are counting, and a dead or
 * voided one can never be offered for killing twice. `/api/orders` deliberately carries
 * `labelled` as a boolean only ("the board never shows them and the tracking list is
 * long"), so there is nothing on the card to read instead.
 */
export function pushRemedy(res = {}, { forced = false } = {}) {
  if ((res.pushed || 0) > 0) {
    const num = res.results?.[0]?.orderNumber || res.records?.[0]?.orderNumber || null
    return { ok: true, orderNumber: num, remedy: REMEDY.NONE, reason: null, hold: null, killable: [] }
  }

  const held = (res.skipped || [])[0] || null
  const reason = held?.reason || ((res.seen || 0) === 0
    ? 'not in the push scope — only unshipped, non-China fulfilments are'
    : 'held, with no reason given')

  // ⚠️ THE HOLD KEY IS THE SIGNAL, NOT THE SENTENCE. Eligibility holds carry `hold`
  // (ALREADY_LABELLED, NOT_PICKED…); a location block carries none. Keying on the key
  // is what stops a reworded message from changing behaviour.
  const hold = held?.hold || null
  const live = (held?.tracking || []).filter(Boolean)

  if (hold === 'ALREADY_LABELLED') {
    // ⚠️ FORCE MUST NEVER LIFT THIS — a second live label is a double charge and a wrong
    // number on the ASN. The way through is to declare the existing labels unusable,
    // which is a statement about the world, not an override of a rule.
    // ⚠️ And with no tracking numbers to offer there is nothing actionable: say so rather
    // than showing a control that cannot work.
    return {
      ok: false, reason, hold,
      remedy: live.length ? REMEDY.KILL_LABELS : REMEDY.NONE,
      killable: live,
    }
  }

  // A location block. ⚠️ Only the NetSuite-labels-this-one conflict is forceable: China
  // ("we never make the label") and an absent location are facts, and forcing either
  // would push something broken. Matching the old behaviour deliberately — the previous
  // regex refused both, and that was right.
  const forceable = !forced && !hold && /NetSuite/i.test(reason)
  return {
    ok: false, reason, hold,
    remedy: forceable ? REMEDY.FORCE : REMEDY.NONE,
    killable: [],
  }
}

/** The sentence shown after the labels are declared dead. */
export const KILLED_MESSAGE = (n) =>
  `${n} label${n === 1 ? '' : 's'} marked unusable — push again to create the order in ShipStation.`
