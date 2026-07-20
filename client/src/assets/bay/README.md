# Launch Bay backdrop

Drop ONE image here to set the Launch Bay's full-bleed spaceport background —
the Mos Espa desert scene is the intended base. Name it whatever you like
(`mos-espa.jpg` is fine); any `.png/.jpg/.jpeg/.webp/.svg` is picked up.

`client/src/data/bayBackdrop.js` auto-discovers it. If several are present the
first alphabetically wins; if none are present the Launch Bay falls back to its
CSS gradient sky, so the build never breaks on a missing file.

Landscape orientation works best — it's rendered `cover`, anchored to the
bottom (the horizon/skyline sits behind the floating ships).
