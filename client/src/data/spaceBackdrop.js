// client/src/data/spaceBackdrop.js — what's outside the cockpit canopy.
// Drop any image into client/src/assets/space/ to change the view — hyperspace
// streaks, a planet, a nebula, whatever the ship is flying past this month.
// No image = the built-in animated starfield. First alphabetically wins
// (same convention as bayBackdrop).
const modules = import.meta.glob('../assets/space/*.{png,jpg,jpeg,webp,svg}', { eager: true, import: 'default' })

const urls = Object.entries(modules)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url)

export const spaceBackdrop = urls[0] || null
