# render-cockpit-plate.py — renders the Flight Deck cockpit plate from the
# high-res Millennium Falcon cockpit OBJ (Drive, ~237MB, 3.6M faces).
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --python scripts/render-cockpit-plate.py
#
# Output: cockpit-plate.png (3840x2160, alpha) next to this script — copy to
# client/src/assets/flightdeck/. The window panes and the seated figures
# (Chewbacca, R2-D2, C-3PO, Han) are stripped so the canopy openings render
# as alpha cutouts; the live hyperspace canvas shows through them in the app.
#
# Hard-won model facts (headless probes, 2026-07-21):
# - one mesh; cockpit tube runs almost straight -X, canopy front shell x~2000
# - pilot aisle ~(2185..2240, -1206), interior eye height ~690-700
# - window panes = materials Cockpit2 (upper) + Cockpit3 (lower band)
# - figures by material: WOOKIEE*/R2* (Chewie+R2), Brushed_gold*/C_3P0*/
#   BlackInodizedAl*/Brushed_bronze (3PO), the _00NN_color cluster (Han)
# - camera clip_end must be >= 1e5; the model is thousands of units wide
import bpy, math, os
import bmesh
from mathutils import Vector

OBJ = ("/Users/nimaerfani/Library/CloudStorage/GoogleDrive-nima@naghedinyc.com/"
       "Shared drives/NAGHEDI Warehouse/Warehouse Documents/Data/Holograms/"
       "millennium-falcon-cockpit-high-res/source/Millennium Falcon Cockpit/"
       "Millennium Flacon Cockpit Model.obj")
OUT = os.path.dirname(os.path.abspath(__file__))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.wm.obj_import(filepath=OBJ)
ob = [o for o in bpy.data.objects if o.type == 'MESH'][0]
me = ob.data

HAN = {'__0007_MistyRose_1', '_0011_Seashell', '_0023_FireBrick', '_0042_Sienna',
       '_0041_Chocolate', '_0111_SlateGray', '_0136_Charcoal', '_0132_LightGray',
       '_0135_DarkGray', '_0007_MistyRose', '_0110_LightSlateGray'}
PANES = {'Cockpit2', 'Cockpit3'}

def is_doomed(m):
    if not m:
        return False
    u = m.name.upper()
    return ('WOOKIEE' in u or 'R2' in u or 'GOLD' in u or 'C_3P0' in u
            or 'BRUSHED_BRONZE' in u or 'BLACKINODIZEDAL' in u
            or m.name in HAN or m.name in PANES)

doom_idx = {i for i, m in enumerate(me.materials) if is_doomed(m)}
bm = bmesh.new(); bm.from_mesh(me)
doomed = [f for f in bm.faces if f.material_index in doom_idx]
bmesh.ops.delete(bm, geom=doomed, context='FACES')
bm.to_mesh(me); bm.free()
print(f"PLATE stripped {len(doomed)} pane+figure faces")

scene = bpy.context.scene
cam_data = bpy.data.cameras.new("p"); cam_data.angle = math.radians(90)
cam_data.clip_start = 0.5; cam_data.clip_end = 1000000
cam = bpy.data.objects.new("p", cam_data)
scene.collection.objects.link(cam); scene.camera = cam
cam.location = Vector((2185, -1206, 700))
d = (Vector((2000, -1210, 680)) - cam.location).normalized()
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.45, 0.62, 0.95, 1)  # cool starlight ambient
bg.inputs[1].default_value = 0.35

def lamp(name, kind, loc, energy, color, size=80, rot=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy; ld.color = color
    if kind == 'AREA':
        ld.size = size
    lo = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(lo)
    lo.location = loc
    if rot:
        lo.rotation_euler = rot
    return lo

# warm console glow pointing down at the dash + its bounce on the ceiling ribs
lamp("dashDown", 'AREA', (2095, -1212, 720), 90000, (1.0, 0.72, 0.42), size=110)
lamp("dashUp", 'AREA', (2100, -1212, 660), 25000, (1.0, 0.65, 0.4), size=90,
     rot=(math.radians(180), 0, 0))
# cool key streaming in through the canopy toward the cabin
lamp("key", 'AREA', (1995, -1210, 705), 160000, (0.6, 0.75, 1.0), size=160,
     rot=(math.radians(75), 0, math.radians(-90)))
# the Falcon's red-lit rear wall + side-console practicals
lamp("rear", 'POINT', (2280, -1205, 700), 40000, (1.0, 0.25, 0.2))
lamp("sideL", 'POINT', (2160, -1155, 660), 12000, (1.0, 0.8, 0.5))
lamp("sideR", 'POINT', (2160, -1265, 660), 12000, (1.0, 0.8, 0.5))

scene.render.engine = 'BLENDER_EEVEE_NEXT'
scene.render.film_transparent = True
scene.eevee.taa_render_samples = 64
scene.render.resolution_x = 3840
scene.render.resolution_y = 2160
scene.render.filepath = os.path.join(OUT, "cockpit-plate.png")
bpy.ops.render.render(write_still=True)
print("PLATE done:", scene.render.filepath)
