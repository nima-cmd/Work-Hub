// client/src/data/shipImages.js — auto-discovers ship art so adding a ship
// picture is just "drop a file in client/src/assets/ships/, named
// <ship-id>-<n>.<ext>" — no code changes, no map to maintain (mirrors
// characterImages.js). See that folder's README for the naming convention.
const modules = import.meta.glob('../assets/ships/*.{png,jpg,jpeg,webp,svg}', { eager: true, import: 'default' })

const byShip = {}
for (const [path, url] of Object.entries(modules)) {
  const filename = path.split('/').pop()
  // lower-cased so filename capitalisation never matters — ship ids are always
  // lower-kebab (mirrors characterImages.js).
  const id = filename.replace(/-\d+\.\w+$/, '').replace(/\.\w+$/, '').toLowerCase()
  ;(byShip[id] ||= []).push(url)
}

export function shipImagesFor(shipId) {
  return byShip[shipId] || []
}
