#!/usr/bin/env python3
"""Resize and re-encode image assets to the size they are actually DISPLAYED at.

Nima drops raw assets and I do the conversion — he never gets handed CLI steps. This
is that conversion, kept as a tool so the next drop is one command rather than a
one-off.

── WHY ─────────────────────────────────────────────────────────────────────────

Render's outbound bandwidth warning (70% of 5 GB) sent me looking for the cause. The
JSON and JS are already compressed at the edge — Render fronts the app with
Cloudflare and serves `content-encoding: br`. ⚠️ IMAGES ARE THE ONE THING BROTLI
CANNOT SHRINK, because a JPEG is already compressed. So they went out at full size on
every uncached load: 2,780 KB across 19 character portraits.

And they were enormous for what they are. Measured in the running app, the largest box
any portrait is EVER drawn into is 218x187 CSS px, at devicePixelRatio 2 — so 436x374
real pixels is retina-sharp. yoda-1.jpeg was 1600x1920: about thirty times the pixels
that can ever reach the screen.

── THE RULES ───────────────────────────────────────────────────────────────────

⚠️ IT IS THE SHORT EDGE THAT MATTERS, NOT THE LONG ONE, and getting this wrong is
how I nearly shipped a subtle quality regression. My first pass capped the LONG edge
at 448px and left 14 of 19 portraits measurably soft at devicePixelRatio 2. The reason
is `object-fit: cover`: the browser scales the image until it FILLS the box, so
   scale = max(boxW/natW, boxH/natH)
and staying crisp at dpr 2 needs scale <= 1/2, which requires BOTH
   natW >= 2*boxW  AND  natH >= 2*boxH.
Capping the long edge satisfies only one of them. yoda-1 came out 373x448 for a
218x187 box: the height was fine (448 >= 374) and the width was 15% short of the 436
it needed. So the target is a BOX the image must still cover — TARGET_COVER — and the
scale is chosen to meet both minimums at once.

Caught by measuring the rendered result in the browser rather than trusting the
byte count, which is the same lesson as everything else in this repo.

⚠️ NEVER UPSCALES. Several portraits are already small (rey-1 is 235x360) and
enlarging them would cost bytes AND look worse.

⚠️ ONLY WRITES WHEN THE SAVING IS MEANINGFUL. Re-encoding an already-optimised JPEG
can grow it, so every file is compared and skipped if it did not help — and it SAYS it
skipped, because a silent no-op is how you stop noticing a broken step.

⚠️ AND "SMALLER" IS NOT ENOUGH: it must beat MIN_SAVING_PCT *and* MIN_SAVING_BYTES.
Caught by re-running this tool on its own output — a plain `after < before` test
rewrote 13 of 19 files a second time for a few bytes each, 0 KB overall. That is a
tool that dirties the git tree on every run forever, and diff noise nobody can explain
is how real changes get missed.

⚠️ APPLIES EXIF ORIENTATION FIRST. A phone photo carries its rotation in metadata;
resizing without transposing silently turns portraits sideways, and the metadata is
dropped on save so it cannot be recovered afterwards.

⚠️ FORMAT IS PRESERVED. WebP would compress better, but the filename is what the
JSX imports — changing extensions means editing source, and that is a separate
decision from "stop shipping thirty times the pixels".

Usage:
    python3 scripts/optimise-images.py                      # dry run, default dirs
    python3 scripts/optimise-images.py --apply
    python3 scripts/optimise-images.py --max-edge 720 --apply
    python3 scripts/optimise-images.py client/src/assets/characters --apply
"""
import argparse
import os
import sys
from io import BytesIO

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is needed:  python3 -m pip install --user Pillow")

# 2x the 218x187 box measured live in Transmissions / Crew / Command Center, plus a
# little headroom. The image must COVER this, in both dimensions — see the docstring.
TARGET_COVER = (448, 384)
JPEG_QUALITY = 82
# Below these, leave the file alone — see the docstring on idempotency.
MIN_SAVING_PCT = 5
MIN_SAVING_BYTES = 2048
DEFAULT_DIRS = ["client/src/assets"]
EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def optimise(path, cover, quality):
    """Return (before, after, note). Writes nothing; the caller decides."""
    before = os.path.getsize(path)
    try:
        im = Image.open(path)
    except Exception as e:                                    # noqa: BLE001
        return before, before, f"unreadable ({e})"

    fmt = im.format                                           # before any transform
    # ⚠️ Orientation FIRST — see the module docstring.
    im = ImageOps.exif_transpose(im)
    w, h = im.size
    cw, ch = cover
    # The smallest scale that still covers the target box in BOTH dimensions, capped
    # at 1 so nothing is ever enlarged.
    scale = min(1.0, max(cw / w, ch / h))
    if scale < 1.0:
        im = im.resize((max(cw, round(w * scale)), max(ch, round(h * scale))), Image.LANCZOS)
        note = f"{w}x{h} -> {im.size[0]}x{im.size[1]}"
    else:
        note = f"{w}x{h} already at or under {cw}x{ch}"

    buf = BytesIO()
    if fmt == "PNG":
        # A photographic PNG stays a PNG on purpose (see docstring); optimise=True is
        # lossless, so this only ever helps.
        im.save(buf, format="PNG", optimize=True)
    elif fmt == "WEBP":
        im.save(buf, format="WEBP", quality=quality, method=6)
    else:
        im.convert("RGB").save(buf, format="JPEG", quality=quality,
                               optimize=True, progressive=True)
    return before, buf.getbuffer().nbytes, note, buf


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dirs", nargs="*", default=DEFAULT_DIRS)
    ap.add_argument("--apply", action="store_true", help="write the files (default is a dry run)")
    ap.add_argument("--cover", default=f"{TARGET_COVER[0]}x{TARGET_COVER[1]}",
                    help="box the image must still cover, WxH (default from the measured layout)")
    ap.add_argument("--quality", type=int, default=JPEG_QUALITY)
    a = ap.parse_args()

    files = []
    for d in (a.dirs or DEFAULT_DIRS):
        if os.path.isfile(d):
            files.append(d)
            continue
        for root, _, names in os.walk(d):
            files += [os.path.join(root, n) for n in names
                      if os.path.splitext(n)[1].lower() in EXTS]
    files.sort(key=lambda f: -os.path.getsize(f))

    if not files:
        print("No images found.")
        return

    cover = tuple(int(x) for x in a.cover.lower().split("x"))
    print(f"{'' if a.apply else 'DRY RUN — '}must cover {cover[0]}x{cover[1]}, quality {a.quality}\n")
    tot_before = tot_after = 0
    changed = skipped = 0
    for f in files:
        out = optimise(f, cover, a.quality)
        if len(out) == 3:                                     # unreadable
            before, after, note = out
            print(f"  ⚠️  {os.path.basename(f):<28} {note}")
            tot_before += before
            tot_after += before
            continue
        before, after, note, buf = out
        tot_before += before
        # ⚠️ Only a MEANINGFUL saving counts, so re-running is a genuine no-op.
        gain = before - after
        if gain >= MIN_SAVING_BYTES and gain * 100 >= before * MIN_SAVING_PCT:
            pct = 100 - after * 100 // before
            print(f"  ok  {os.path.basename(f):<28} {before // 1024:>5} KB -> {after // 1024:>4} KB  "
                  f"({pct}%)  {note}")
            if a.apply:
                with open(f, "wb") as fh:
                    fh.write(buf.getvalue())
            tot_after += after
            changed += 1
        else:
            why = ("would grow it" if after >= before
                   else f"only {gain // 1024} KB / {gain * 100 // max(before, 1)}% — under the floor")
            print(f"  --  {os.path.basename(f):<28} {before // 1024:>5} KB  left alone ({why})  {note}")
            tot_after += before
            skipped += 1

    saved = tot_before - tot_after
    print(f"\n  {changed} changed, {skipped} left alone")
    print(f"  {tot_before // 1024} KB -> {tot_after // 1024} KB"
          f"   saved {saved // 1024} KB ({100 - tot_after * 100 // max(tot_before, 1)}%)")
    if not a.apply:
        print("\n  Nothing written. Re-run with --apply.")


if __name__ == "__main__":
    main()
