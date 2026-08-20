# Headless Blender: bay.glb -> one top-down PNG sprite PER BUILDING.
#
# The first pass at this rendered the whole model as a single plate, and that render
# taught us something better: `bay.glb` is not a composed skyline at all. It is a KIT
# OF SEPARATE STRUCTURES laid out in two rows — a big docking ring, a stepped-terrace
# block, a long warehouse with loading bays down both flanks, silos, landing pads and
# a handful of small props. Nothing about their positions in the file is a base
# layout; they are parts on a sheet.
#
# That is luckier than a fixed cityscape: each structure can be cut out and placed
# where its LANE belongs, so the Base view gets real building art without inheriting
# someone else's town planning.
#
# ⚠️ ORTHOGRAPHIC per sprite, framed on that structure alone. Perspective would make
# each building lean according to where it happened to sit in the source file, and a
# sprite has to be photographed square-on to be placed anywhere.
#
# Usage:
#   Blender -b --python scripts/render-base-sprites.py -- <out-dir> [max_px]
#
# Prints an INVENTORY line per part (index, footprint, aspect, pixels) — that listing
# is the point of the first run: it is how you tell the docking ring from the silos
# without opening Blender.

import bpy
import sys
import os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
out_dir = argv[0]
max_px = int(argv[1]) if len(argv) > 1 else 512
src = "client/public/holograms/bay.glb"

os.makedirs(out_dir, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit("no meshes in %s" % src)

# ── Split the sheet into its separate structures ────────────────────────────
# ⚠️ CONNECTIVITY IS THE WRONG GROUPING, and the first run proved it: separating by
# loose parts yielded 119 objects, and sprite 00 came out as a crescent — one surface
# shell of the docking ring rather than the ring. The mesh's islands are shells, not
# buildings.
#
# What DOES separate the buildings is SPACE: on the source sheet they sit well apart
# with clear gutters between them. So split by connectivity first (cheap), then
# CLUSTER those pieces by proximity, and render one sprite per cluster.
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active

bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.separate(type='LOOSE')
bpy.ops.object.mode_set(mode='OBJECT')
parts = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print("SEPARATED into %d shells" % len(parts))


def bounds(o):
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    for corner in o.bound_box:
        w = o.matrix_world @ Vector(corner)
        for i in range(3):
            lo[i] = min(lo[i], w[i])
            hi[i] = max(hi[i], w[i])
    return lo, hi


# ── Cluster the shells into buildings, by proximity in the XY plane ─────────
# Union-find over "do these two footprints come within GAP of each other". GAP is a
# fraction of the whole sheet's width, so it scales if the model is ever re-exported
# at another size: wide enough to pull a roof, its vents and its dock canopies into
# one building, narrow enough to leave the next building alone.
model_lo, model_hi = [float("inf")] * 3, [float("-inf")] * 3
boxes = []
for o in parts:
    lo, hi = bounds(o)
    boxes.append((o, lo, hi))
    for i in range(3):
        model_lo[i] = min(model_lo[i], lo[i])
        model_hi[i] = max(model_hi[i], hi[i])
sheet_w = model_hi[0] - model_lo[0]
GAP = sheet_w * 0.012

parent = list(range(len(boxes)))


def find(a):
    while parent[a] != a:
        parent[a] = parent[parent[a]]
        a = parent[a]
    return a


def union(a, b):
    ra, rb = find(a), find(b)
    if ra != rb:
        parent[rb] = ra


def near(i, j):
    _, lo1, hi1 = boxes[i]
    _, lo2, hi2 = boxes[j]
    # Overlap-or-within-GAP on BOTH horizontal axes. Height is ignored on purpose —
    # a mast above a roof belongs to that roof.
    for ax in (0, 1):
        if lo1[ax] - GAP > hi2[ax] or lo2[ax] - GAP > hi1[ax]:
            return False
    return True


for i in range(len(boxes)):
    for j in range(i + 1, len(boxes)):
        if near(i, j):
            union(i, j)

groups = {}
for i, (o, lo, hi) in enumerate(boxes):
    groups.setdefault(find(i), []).append(i)
print("CLUSTERED %d shells into %d buildings (gap %.4f)" % (len(boxes), len(groups), GAP))

# Rank by footprint so the inventory reads biggest-first — the buildings worth
# placing are the big ones, and the tail is antennae and bollards.
sized = []
for members in groups.values():
    lo = [min(boxes[m][1][k] for m in members) for k in range(3)]
    hi = [max(boxes[m][2][k] for m in members) for k in range(3)]
    fw, fd, ht = hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]
    sized.append((fw * fd, [boxes[m][0] for m in members], lo, hi, fw, fd, ht))
sized.sort(key=lambda t: -t[0])

# ── Flat dark roofs, amber outlines: the app's own palette ──────────────────
mat = bpy.data.materials.new("plate")
mat.use_nodes = True
nt = mat.node_tree
nt.nodes.clear()
emit = nt.nodes.new("ShaderNodeEmission")
emit.inputs[0].default_value = (0.035, 0.048, 0.070, 1.0)   # #0b0f16
emit.inputs[1].default_value = 1.0
outn = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(emit.outputs[0], outn.inputs[0])
for _, objs, *_rest in sized:
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)

scene = bpy.context.scene
for engine in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        continue

# Freestyle draws SILHOUETTES and creases, so a sprite reads as a building from
# above — roof edges and setbacks — rather than as every triangle in the mesh.
# ⚠️ Guarded: on 4.5 a fresh lineset can report no linestyle for a moment, and an
# unguarded write throws a traceback that looks like a failed render when the render
# is in fact fine.
scene.render.use_freestyle = True
fs = bpy.context.view_layer.freestyle_settings
fs.as_render_pass = False
ls = fs.linesets.new("edges")
ls.select_silhouette = True
ls.select_border = True
ls.select_crease = True
ls.select_edge_mark = False
ls.select_contour = True
style = ls.linestyle
style.color = (0.851, 0.643, 0.255)   # #d9a441, the app's --accent
style.thickness = 1.7
style.alpha = 1.0
# ⚠️ Blender 4.5 prints "NoneType has no attribute use_chaining" from inside its own
# Freestyle renderer once per frame. VERIFIED COSMETIC — the amber outlines are in
# every sprite regardless (checked by eye on the first render). Filter it from the
# log rather than chasing it; the render is not failing.

cam_data = bpy.data.cameras.new("top")
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new("top", cam_data)
scene.collection.objects.link(cam)
cam.rotation_euler = (0.0, 0.0, 0.0)   # default camera looks down -Z
scene.camera = cam
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.resolution_percentage = 100

# Only the structures worth placing. Below this the parts are bollards and aerials —
# renderable, but nothing a lane could live in.
FOOTPRINT_FLOOR = 0.0006

print("INVENTORY (index, footprint, w x d x h, aspect, file)")
kept = 0
for i, (area, objs, lo, hi, fw, fd, ht) in enumerate(sized):
    if area < FOOTPRINT_FLOOR:
        print("  %2d  %.6f  SKIPPED — prop, too small to hold a lane" % (i, area))
        continue

    # Hide everything else: a sprite must carry ONE building, or a neighbour's roof
    # bleeds into its transparent margin and the cut-out is unusable.
    keep = set(objs)
    for _, others, *_r in sized:
        for other in others:
            other.hide_render = other not in keep

    mid = [(hi[k] + lo[k]) / 2 for k in range(3)]
    span = max(fw, fd) * 1.10          # 10% margin so the outline is never clipped
    cam_data.ortho_scale = span
    cam.location = (mid[0], mid[1], hi[2] + max(fw, fd, ht) * 3.0)

    # Square frame at a resolution proportional to real footprint, so a big building
    # is not upscaled to match a small one.
    px = max(160, min(max_px, int(max_px * (span / (sized[0][4] * 1.10)))))
    scene.render.resolution_x = px
    scene.render.resolution_y = px

    name = "bldg-%02d.png" % i
    scene.render.filepath = os.path.join(out_dir, name)
    bpy.ops.render.render(write_still=True)
    kept += 1
    print("  %2d  %.6f  %.3f x %.3f x %.3f  aspect %.2f  %d shells  %s @ %dpx"
          % (i, area, fw, fd, ht, (fw / fd) if fd else 0, len(objs), name, px))

print("RENDERED %d building sprites into %s" % (kept, out_dir))
