# Character portraits

Drop image files here named `<character-id>-<n>.<ext>` (`.png`, `.jpg`,
`.jpeg`, `.webp`, or `.svg`) — e.g. `rey-1.png`, `rey-2.jpg`. `<character-id>`
must match an `id` in `src/model/characters.js` (case-insensitive — `Boba-Fett.jpg`
resolves to `boba-fett`, and the `-<n>` suffix is optional).

That's the entire integration step — `client/src/data/characterImages.js`
auto-discovers every file here via `import.meta.glob` and groups them by
character id. No code changes, no map to maintain. A character with no image
here just renders the placeholder badge in the Transmissions view.

`rey-1.svg` is a demo placeholder (an abstract badge, not character art) —
proving the pipeline renders real images with the hologram tint/scan
animation applied. Delete it whenever you drop in real art for Rey.
