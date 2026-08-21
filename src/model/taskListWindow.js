// src/model/taskListWindow.js — how much COMPLETED work the task list carries.
//
// Nima, 2026-08-21, asked the right question about this: "is the trade off in loss
// in history worth what we get in return". Measured answer: there is no loss of
// history to trade. Nothing is deleted and nothing becomes unreachable —
//
//   • the archive search is SERVER-SIDE over the whole table (searchQuestTasks:
//     ILIKE over subject, snippet, from_name, from_address), so it finds rows the
//     list never loaded;
//   • 711 of 739 completed tasks came from an email, and Gmail is the real archive;
//   • the 13 linked to a NetSuite doc surface in that doc's data packet;
//   • the Ledger reads order_events, not this list, so it is untouched.
//
// What changes is only how much arrives EAGERLY. Measured on the live board:
//
//   everything          750 cards   660 KB
//   open + last  3d     111 cards    97 KB
//   open + last  7d     127 cards   112 KB   <- the default
//   open + last 14d     268 cards   233 KB
//   open + last 30d     719 cards   633 KB   (worthless: 708 of 739 are <30d old)
//
// The whole history is five weeks old (17 Jul 2026 onward), and it is mostly
// machine noise repeated — 42x "Netsuite Inventory Transfer", 24x "You have an
// order to prepare". A 739-card wall is not history anyone reads.
//
// ⚠️ THE COUNTER TRAP THIS EXISTS TO AVOID ────────────────────────────────────
//
// Tasks.jsx computed `doneCount = tasks.length - openCount` and labelled it
// "done". Trim the list and that number silently becomes 116 while still SAYING
// done — a counter counting something other than its label, which is shape two of
// the five this repo keeps producing (see fieldAssumptions.js). So a windowed list
// must never be the source of a total. The totals come from a COUNT over the whole
// table, and `windowed` says out loud that the array is partial.

/** The default eager window, in days. 7 covers "what did I just get through" — the
 *  only question a scrolling list actually answers. */
export const DEFAULT_DONE_WINDOW_DAYS = 7

/**
 * Describe a task payload honestly.
 *
 * @param doneTotal   completed tasks IN THE TABLE — never `tasks.length`
 * @param openTotal   open tasks in the table
 * @param returned    how many rows the array actually holds
 * @param windowDays  the window applied, or null when everything was returned
 */
export function taskListMeta({ doneTotal = 0, openTotal = 0, returned = 0, windowDays = null } = {}) {
  const total = Number(doneTotal) + Number(openTotal)
  const windowed = windowDays != null && returned < total
  const withheld = windowed ? total - returned : 0
  return {
    doneTotal: Number(doneTotal),
    openTotal: Number(openTotal),
    returned: Number(returned),
    windowDays: windowed ? windowDays : null,
    windowed,
    withheld,
    // ⚠️ The label a button may show. It NAMES the number so "show all" can never
    // be a mystery box, and it is empty when nothing is withheld — a button
    // offering to load 0 more rows is a lie about there being more.
    moreLabel: withheld > 0 ? `Show all ${total} — ${withheld} older completed not loaded` : null,
  }
}
