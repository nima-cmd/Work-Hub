# Character art — open items

Parked 2026-09-11 at Nima's call ("we detoured too long lets continue and make a
note of these fies for later"). Nothing here blocks anything; the roster, the
rotation and the Crew cards all work.

## 1. Six sources are too small to upscale cleanly

Maomao is the visible one — Nima: "maomao has some weird artifacting". The cause is
resolution, not processing: her source is **180×360**, and the avatars render her at
84×84 while the Crew card's art box is 228×202. Upscaling a 180px-wide JPEG that far
is what the artifacting is.

These are below the ~400px the existing set sits at, in order of severity:

| character | source | note |
|---|---|---|
| `maomao` | 180×360 | worst; visibly artifacting today |
| `alicia-glenfall` | 200×268 | |
| `euphyllia-magenta` | 200×268 | |
| `nemu-miyao` | 225×350 | |
| `darkness` | 300×450 | borderline |
| `clen` | 314×426 | borderline |

**Fix: better source art, not better code.** Re-compressing or upscaling these cannot
add detail. Drop a larger file into the Drive `Characters` folder and re-run the
resize step; nothing else needs to change, because `import.meta.glob` discovers by
filename.

⚠️ Do NOT "fix" this by sharpening or running an upscaler without asking — an
invented-detail portrait of a real character is a worse artefact than a soft one, and
the file would then look authoritative.

## 2. The message avatars have not had the art-window fix

`8ed7ec4` fixed the Crew card: its art box is landscape (228×202) while every
portrait is 3:4 or taller, so `object-fit: cover` was clipping heads. That fix was
scoped to `.tcArt` only.

The transmission list still crops the same way — Nima: "we still need to adjust for
when we get them in the message". The avatars there are square and use
`cover` + `object-position: top center`:

- `.tiAvatar img` — the Transmissions row avatar (the one in his screenshot)
- `.chipAvatar img`, `.calTaskAvatar img`, `.crewChip img`, `.fdFace`

⚠️ These are NOT simply the same fix. A 26px circular avatar *should* crop to the
face — `contain` there would letterbox a portrait into a tiny sliver. The open
question is per-surface: which of these are big enough to deserve the whole portrait
(the ~84px Transmissions avatar probably is) and which should stay a face crop.
Decide that with Nima against the real screens rather than applying one rule.

## 3. Five voices are written, three from Nima's own descriptions

Not a defect, just context: `alicia-glenfall`, `clen` and `nemu-miyao` were written
from the personality notes Nima supplied on 2026-09-11 rather than from the source
material. `coco` and `nico-wakatsuki` are from their series. If any read wrong to
him, they are in `src/model/dialogue.js` and safe to rewrite — nothing keys on the
line text.
