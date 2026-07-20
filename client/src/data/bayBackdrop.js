// client/src/data/bayBackdrop.js — the Launch Bay's spaceport backdrop. Drop
// any image in client/src/assets/bay/ and it becomes the bay's full-bleed
// background (Mos Espa is the intended base). If several are present, the
// first alphabetically wins; if none are present, this exports null and the
// Launch Bay falls back to its CSS gradient sky — so the build never breaks on
// a missing file.
const modules = import.meta.glob('../assets/bay/*.{png,jpg,jpeg,webp,svg}', { eager: true, import: 'default' })

const urls = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url)

export const bayBackdrop = urls[0] || null
