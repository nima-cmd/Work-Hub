# Quantise the Base view's building sprites. Second half of the asset pipeline —
# run it after scripts/render-base-sprites.py, every time.
#
# ⚠️ THIS IS NOT OPTIONAL POLISH. Blender writes full 8-bit RGBA, and the seven
# sprites came out at 560 KB for what are two flat colours plus antialiasing — on a
# view meant to be open all day, behind a one-vCPU deploy. Quantised to 64 colours
# they are 40 KB, a 93% cut, and the result is indistinguishable (checked by eye at
# full size: the amber outlines and every dock door survive intact).
#
# 64 and not fewer: the outlines are antialiased against both the dark roof fill and
# transparency, so the ramp needs the headroom. FASTOCTREE rather than the default
# median cut because it preserves those thin light-on-dark edges better.
#
# Usage:  python3 scripts/optimise-base-sprites.py [dir]
# Needs Pillow (present on this machine at 12.3.0). If it is missing, say so rather
# than shipping the unquantised files — half a megabyte of flat colour is a real cost.

import glob
import os
import sys

try:
    from PIL import Image
except ImportError:                                            # pragma: no cover
    raise SystemExit(
        "Pillow is not installed — `pip3 install Pillow`. Refusing to skip: the "
        "unquantised sprites are 14x larger and would ship as-is."
    )

target = sys.argv[1] if len(sys.argv) > 1 else "client/public/base"
files = sorted(glob.glob(os.path.join(target, "bldg-*.png")))
if not files:
    raise SystemExit("no bldg-*.png in %s — run scripts/render-base-sprites.py first" % target)

before = after = 0
for f in files:
    b = os.path.getsize(f)
    im = Image.open(f).convert("RGBA")
    im.quantize(colors=64, method=Image.Quantize.FASTOCTREE).save(f, optimize=True)
    a = os.path.getsize(f)
    before += b
    after += a
    print("  %-14s %5dK -> %4dK" % (os.path.basename(f), b // 1024, a // 1024))

print("TOTAL %dK -> %dK across %d sprites" % (before // 1024, after // 1024, len(files)))
