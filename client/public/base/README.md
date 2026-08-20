# Base view building sprites

The Base view is a **command base seen from directly above** (Nima, 2026-08-20:
*"a top down view would be best i think like in a video game"*), and its buildings
are not drawings of buildings — they are **the** buildings: the same `bay.glb`
skyline the Launch Bay projects, photographed straight down and cut into sprites.

No three.js here. He called 3D *"way too resource intensive and messy"* and he is
right: the deploy is one vCPU and this view is meant to sit open all day. Flat PNGs
cost nothing to draw and cannot drop frames.

## What the render found

`bay.glb` is **not a composed skyline**. It is a kit of separate structures laid out
in two rows on a sheet — nothing about their positions is a base layout. That is
lucky: each building can be cut out and placed where its LANE belongs, instead of
inheriting someone else's town planning.

⚠️ **The buildings are separated by SPACE, not by topology.** The first attempt split
the mesh by loose parts and got 4,567 shells — sprite 00 came out as a crescent, one
surface of the docking ring rather than the ring. The pipeline now clusters those
shells by XY proximity (union-find, gap = 1.2% of sheet width), which yields **16
groups: 10 buildings and 6 props** that are correctly skipped as too small to hold a
lane.

## The fleet

| sprite | footprint | what it is | lane it carries |
| ------ | --------- | ---------- | --------------- |
| `bldg-00` | 0.286 × 0.348 | docking ring, 12 bays around a circular pad | **Launch pad** |
| `bldg-01` | 0.162 × 0.154 | stepped terrace block, tallest on the sheet | **Ops centre** |
| `bldg-02` | 0.137 × 0.179 | large shed on legs with an annex | **Receiving** |
| `bldg-03` | 0.149 × 0.142 | twin silos beside a long hall | **Stock depot** |
| `bldg-04` | 0.132 × 0.150 | hipped roof, dock doors right around the perimeter | **Pack house** |
| `bldg-05` | 0.112 × 0.112 | square block | **Routing yard** |
| `bldg-06` | 0.078 × 0.099 | small tower | **Comms tower** |

`bldg-07` … `bldg-09` also render and are kept as spares (2 KB each) — a small pad, a
long low block and a narrow tower, for lanes this view does not have yet.

The lane assignment is a judgement call, not a fact in the model — swapping two is a
one-line change wherever the view declares them.

## Regenerating

Two steps, and the second is not optional:

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python scripts/render-base-sprites.py -- client/public/base 512

python3 scripts/optimise-base-sprites.py client/public/base
```

⚠️ **Always run the optimiser.** Blender writes full 8-bit RGBA and these are two
flat colours plus antialiasing: 560 KB raw, **40 KB** quantised to 64 colours, visually
identical. Shipping the raw files puts half a megabyte of flat colour on a view that
is open all day.

⚠️ Blender 4.5 prints `NoneType has no attribute use_chaining` from inside its own
Freestyle renderer, once per frame. **Cosmetic** — the amber outlines are in every
sprite regardless. Do not chase it.

There is deliberately no `npm run` alias yet: `package.json` was being edited by
another session's uncommitted Weaver work when this landed, and staging that file
would have committed their work-in-progress. Add one once it is free.
