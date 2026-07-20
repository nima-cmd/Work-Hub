# Headless Blender: OBJ -> decimated, normalized GLB for the Work-Hub holotable.
# Usage: Blender -b --python convert_holo.py -- <in.obj> <out.glb> <target_tris>
import bpy, sys, math

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst, target = argv[0], argv[1], int(argv[2])

# wipe default scene
bpy.ops.wm.read_factory_settings(use_empty=True)

# import (Blender 4.x operator; fall back to legacy)
try:
    bpy.ops.wm.obj_import(filepath=src)
except AttributeError:
    bpy.ops.import_scene.obj(filepath=src)

meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit("no meshes imported")

# join into one object
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active

# current triangle count
tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
print(f"IMPORT {src}: {tris} tris")

if tris > target:
    mod = obj.modifiers.new("dec", 'DECIMATE')
    mod.ratio = target / tris
    bpy.ops.object.modifier_apply(modifier="dec")
    tris2 = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    print(f"DECIMATED to {tris2} tris")

# center at origin, normalize longest dimension to 1.0
bpy.ops.object.origin_set(type='ORIGIN_CENTER_OF_VOLUME', center='BOUNDS')
obj.location = (0, 0, 0)
m = max(obj.dimensions) or 1.0
s = 1.0 / m
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# strip materials (hologram shader is applied in three.js)
obj.data.materials.clear()

bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_apply=True,
                          export_yup=True)
print(f"WROTE {dst}")
