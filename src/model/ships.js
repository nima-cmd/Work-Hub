// src/model/ships.js — the fleet roster for the Launch Bay. Plain config, not a
// DB table (same idea as characters.js): add a ship by adding a line here, then
// drop its art in client/src/assets/ships/ named <id>-<n>.<ext>. No migration,
// no code change. `id` is the stable key used for the image-folder filenames
// and for the deterministic ship→order assignment below.
export const SHIPS = [
  { id: 'razor-crest',    name: 'Razor Crest',    note: 'white Mandalorian gunship' },
  { id: 'gilded-carrier', name: 'Gilded Carrier', note: 'gold capital ship' },
  { id: 'crimson-raider', name: 'Crimson Raider', note: 'red raider' },
  { id: 'steel-frigate',  name: 'Steel Frigate',  note: 'grey/blue military frigate' },
]

export function getShipById(id) {
  return SHIPS.find((s) => s.id === id) || null
}

// Which ship represents a given departure. Deterministic (a stable string hash
// of the IF/SO number) so the same order ALWAYS shows the same ship across
// reloads — never a fresh random pick that would make the bay churn visually.
// Pure + injectable roster so it stays testable and so an empty roster can't
// divide-by-zero.
export function resolveShipForKey(key, roster = SHIPS) {
  if (!roster.length) return null
  const str = String(key || '')
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return roster[h % roster.length].id
}
