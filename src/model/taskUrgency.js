// src/model/taskUrgency.js — how urgent a task is, DERIVED, with Nima's manual
// setting as an override.
//
// Nima, 2026-08-05: "if the app can learn and set urgency with a manual overrid it
// be best."
//
// ── Why deriving is the right default ────────────────────────────────────────
//
// `quest_tasks.urgency` is hand-set and had gone degenerate: measured on the live
// board, **16 of 34 open tasks were 'hi' and the other 18 were unset — zero 'mid',
// zero 'lo'**. A field where everything is either maximum or nothing cannot order
// anything, which is the same failure as the Nordstrom noon cutoff that was "always
// on" and therefore meant nothing. Every hand-maintained field in this app has gone
// this way (packed_status, shipping_status), so urgency is now computed and the
// hand-set value becomes an explicit OVERRIDE that wins when present.
//
// ── Only signals that actually exist ────────────────────────────────────────
//
// Measured coverage across the 34 open tasks before choosing the rules:
//
//   created_at (age)      34 of 34   ← the only universal signal
//   linked NetSuite doc   13
//   recurring             3
//   needs_type            2  (32 are 'none')
//   due_at                0
//
// So a design leaning on due_at or needs_type would have been born dead — the
// structurally-unreachable shape this repo keeps producing. They are still honoured
// when present, because a real due date is the strongest evidence there is; they
// simply cannot be the backbone.
//
// ── Age is NEGLECT, not urgency ─────────────────────────────────────────────
//
// The tempting move is "old = urgent", and it is wrong: an email sitting for three
// weeks is not a deadline, it is a decision that keeps being deferred. Grading it
// 'hi' would rebuild the everything-is-urgent problem from the other direction. So
// age tops out at 'mid' — loud enough to force do-it-or-drop-it, never loud enough
// to outrank a real cutoff.

export const AGE_STALE_DAYS = 14   // past this, a task needs a decision
export const AGE_WATCH_DAYS = 7

const DAY = 86400000
const LEVELS = { hi: 3, mid: 2, lo: 1 }

// Highest wins, and every result carries the REASON it won — an urgency you can't
// explain is one nobody trusts (and the reason is what makes the override
// meaningful: you can see what you're overriding).
function strongest(candidates) {
  return candidates.filter(Boolean).sort((a, b) => LEVELS[b.level] - LEVELS[a.level])[0]
}

/**
 * @param task   { urgency, urgencyOverride, dueAt, createdAt, recurringKey, needsType }
 * @param opts   { now, linkedSeverity } — linkedSeverity is the flag severity of the
 *               NetSuite doc this task hangs off, when the caller knows it (0–3).
 * @returns { level, basis, derived, override }
 */
/** Done is done. `status` and `completed_at` were checked against each other on the
 *  live board — 739 done, and ZERO rows where one says done and the other does not —
 *  so either is a safe key and both are honoured. */
export const isTaskDone = (task = {}) =>
  task.status === 'done' || !!(task.completedAt || task.completed_at)

export function deriveTaskUrgency(task = {}, opts = {}) {
  const now = opts.now ?? Date.now()

  // ── ⚠️ A COMPLETED TASK HAS NO URGENCY ────────────────────────────────────
  //
  // This is a correctness rule, not an optimisation. Every signal below asks a
  // question about work still to be done — is it due, is anyone waiting, how long
  // has it sat — and none of them mean anything once the work is finished. Deriving
  // anyway does not merely waste time, it makes the app STATE SOMETHING FALSE.
  //
  // Measured on the live board, 2026-08-21, across 739 completed tasks:
  //
  //     697  mid · "someone is waiting on a reply"      <- nobody is. it is done.
  //      31  mid · "NNd old — decide or drop it"        <- already decided and done
  //       3  mid · "recurring, due today"              <- today's was completed
  //       1  mid · "its order needs watching"
  //
  // 697 finished tasks each asserting a person was still waiting on them. That is
  // this repo's recurring shape — a field saying something it cannot mean — and it
  // was on a surface Nima reads (Transmissions renders "Priority: MID" on completed
  // cards from exactly this value).
  //
  // ⚠️ AN OVERRIDE STILL SURVIVES. What a human typed is a fact and outlives the
  // task; what we computed about pending work does not. Measured: 0 of the 739 have
  // one today, so this branch is currently theoretical — kept because the rule is
  // "drop what we inferred, keep what he said", not "blank the field".
  if (isTaskDone(task)) {
    const ov = task.urgencyOverride || null
    return ov && LEVELS[ov]
      ? { level: ov, basis: 'you set this', derived: null, override: ov }
      : { level: null, basis: null, derived: null, override: null }
  }

  const cands = []

  // A real due date is the strongest thing available. Today or past → act.
  if (task.dueAt) {
    const due = new Date(task.dueAt).getTime()
    if (!Number.isNaN(due)) {
      const days = Math.floor((due - now) / DAY)
      if (days <= 0) cands.push({ level: 'hi', basis: 'due now' })
      else if (days <= 1) cands.push({ level: 'hi', basis: 'due tomorrow' })
      else if (days <= 3) cands.push({ level: 'mid', basis: `due in ${days}d` })
    }
  }

  // Hanging off a NetSuite doc that is itself in trouble — the task inherits it.
  // Severity 3 is the app's "act now" tier (src/model/pipeline.js).
  if (opts.linkedSeverity >= 3) cands.push({ level: 'hi', basis: 'its order needs action now' })
  else if (opts.linkedSeverity === 2) cands.push({ level: 'mid', basis: 'its order needs watching' })

  // A recurring task is due on its schedule; the scheduler only materialises an
  // instance when it IS due, so an open one is due today by construction.
  if (task.recurringKey) cands.push({ level: 'mid', basis: 'recurring, due today' })

  // Something explicitly waiting on a person to reply or acknowledge.
  if (task.needsType === 'reply' || task.needsType === 'acknowledgment') {
    cands.push({ level: 'mid', basis: 'someone is waiting on a reply' })
  }

  // Age: capped at 'mid' on purpose — see the header.
  const created = task.createdAt ? new Date(task.createdAt).getTime() : null
  if (created && !Number.isNaN(created)) {
    const age = Math.floor((now - created) / DAY)
    if (age >= AGE_STALE_DAYS) cands.push({ level: 'mid', basis: `${age}d old — decide or drop it` })
    else if (age >= AGE_WATCH_DAYS) cands.push({ level: 'lo', basis: `${age}d old` })
  }

  const derived = strongest(cands) || { level: 'lo', basis: 'no deadline or age pressure' }

  // The override wins outright. Deliberately a SEPARATE field from the derived
  // value so the two can never be confused: the old scheme wrote 'hi' from a
  // recurring TEMPLATE as well as from Nima, which made it impossible to tell what
  // he had actually chosen.
  const override = task.urgencyOverride || null
  if (override && LEVELS[override]) {
    return { level: override, basis: 'you set this', derived: derived.level, override }
  }
  return { level: derived.level, basis: derived.basis, derived: derived.level, override: null }
}
