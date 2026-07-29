// Gmail label resolution for transmission chips.
//
// quest_emails.label_ids stores the RAW Gmail label ids a message carries.
// User labels look like `Label_42`; system labels are human-ish ids like
// `INBOX`, `UNREAD`, `IMPORTANT`, `CATEGORY_UPDATES`. This turns that raw id
// list into display chips: noise dropped, system ids given friendly names,
// user ids resolved via the label list we already fetch for the picker.

// Pure plumbing — on every inbox message or never worth showing here. INBOX/
// UNREAD are on virtually every transmission; the CATEGORY_* tabs and
// SENT/DRAFT/CHAT/TRASH aren't meaningful tags to surface (Nima, 2026-07-29).
const HIDDEN_LABELS = new Set(['INBOX', 'UNREAD', 'SENT', 'DRAFT', 'CHAT', 'TRASH'])

// The handful of system labels that ARE worth seeing, with friendly names
// (their raw id is the display fallback for any others).
const SYSTEM_LABEL_NAMES = {
  IMPORTANT: 'Important',
  STARRED: 'Starred',
  SPAM: 'Spam',
}

export function isNoiseLabel(id) {
  return HIDDEN_LABELS.has(id) || id.startsWith('CATEGORY_')
}

// labelIds: the raw ids on the message. nameById: id→name for the user's own
// labels (what listUserLabels/the picker returns). Returns [{id, name}] chips
// with noise removed and sorted by name. A user `Label_*` id we can't resolve
// (not in nameById) is skipped rather than shown as a gibberish id.
export function resolveLabelChips(labelIds = [], nameById = {}) {
  const chips = []
  for (const id of labelIds || []) {
    if (isNoiseLabel(id)) continue
    let name = nameById[id] || SYSTEM_LABEL_NAMES[id]
    if (!name) {
      if (id.startsWith('Label_')) continue // unresolvable user label — skip
      name = id // an unmapped system label — show its id rather than nothing
    }
    chips.push({ id, name })
  }
  return chips.sort((a, b) => a.name.localeCompare(b.name))
}
