# Ship art

Drop image files here named `<ship-id>-<n>.<ext>` (`.png`, `.jpg`, `.jpeg`,
`.webp`, or `.svg`) — e.g. `razor-crest-1.png`, `crimson-raider-1.jpg`.
`<ship-id>` must match an `id` in `src/model/ships.js`.

That's the entire integration step — `client/src/data/shipImages.js`
auto-discovers every file here via `import.meta.glob` and groups them by ship
id. No code changes, no map to maintain. A ship with no art here just renders
the built-in CSS hull in the Launch Bay.

Transparent-background PNGs look best (the ships sit over the Mos Espa
backdrop). The four ids seeded in `ships.js` map to the reference images:

| id               | ship                                   |
| ---------------- | -------------------------------------- |
| `razor-crest`    | white Mandalorian gunship              |
| `gilded-carrier` | gold capital ship                      |
| `crimson-raider` | red raider                             |
| `steel-frigate`  | grey / blue military frigate           |

Add more ships anytime: add a line to `src/model/ships.js`, drop the art here.
