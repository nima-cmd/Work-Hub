// client/src/data/characterImages.js — auto-discovers character portrait
// images so adding art is just "drop a file in client/src/assets/characters/,
// named <character-id>-<n>.<ext>" — no code changes, no map to maintain.
// See that folder's README for the naming convention.
const modules = import.meta.glob('../assets/characters/*.{png,jpg,jpeg,webp,svg}', { eager: true, import: 'default' })

const byCharacter = {}
for (const [path, url] of Object.entries(modules)) {
  const filename = path.split('/').pop()
  const id = filename.replace(/-\d+\.\w+$/, '').replace(/\.\w+$/, '')
  ;(byCharacter[id] ||= []).push(url)
}

export function imagesFor(characterId) {
  return byCharacter[characterId] || []
}
