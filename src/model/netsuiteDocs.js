// src/model/netsuiteDocs.js — the NetSuite document types a quest_task can
// reference (Nima, 2026-07-15). Prefixes PO/SO/IF/TO are already confirmed
// elsewhere in this codebase (src/ingest/savedSearches.js, test fixtures);
// IR (Item Receipt) and IT (Inventory Transfer) are best-guess defaults not
// yet verified against live NetSuite (the NetSuite MCP connector was down
// when this was built — see CLAUDE.md's note that it's unstable) — confirm
// and correct here if your instance numbers them differently.
export const NETSUITE_DOC_TYPES = [
  { value: 'PO', label: 'Purchase Order' },
  { value: 'SO', label: 'Sales Order' },
  { value: 'IF', label: 'Item Fulfillment' },
  { value: 'IR', label: 'Item Receipt' },
  { value: 'IT', label: 'Inventory Transfer' },
  { value: 'TO', label: 'Transfer Order' },
]

// normalizeDocNumber('SO', '1213') -> 'SO1213'; normalizeDocNumber('SO', 'SO1213') -> 'SO1213'
export function normalizeDocNumber(prefix, raw) {
  const trimmed = (raw || '').trim().toUpperCase()
  if (!trimmed || !prefix) return trimmed
  return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`
}
