# Holotable models

The GLBs here are the 3D holograms the Launch Bay projects. They started life
as OBJ files in Drive (`NAGHEDI Warehouse/Warehouse Documents/Data/Holograms`)
and were decimated + converted with `scripts/convert-hologram.py`.

## Adding a new ship — two steps

**1. Convert the OBJ** (any size — the script shrinks it to web weight):

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b \
  --python scripts/convert-hologram.py -- \
  "/path/to/Your Ship.obj" client/public/holograms/ship-falcon.glb 18000
```

The last number is the triangle budget — `18000` is right for ships,
`45000` for big environment pieces. The script centers the model, normalizes
its size, and strips materials (the hologram tint is applied in the app).

**2. Register it** — add the file's name (without `.glb`) to the `MODELS`
list at the top of `client/src/views/LaunchBay3D.jsx`:

```js
const MODELS = ['ship-a', 'ship-b', 'ship-cr90', 'ship-falcon']
```

Rebuild (`npm run client:build`) and it's in the rotation — each order is
assigned a model by a stable hash, so adding one reshuffles which ship an
order shows but stays consistent from then on.

## Current fleet

| file           | source OBJ                          |
| -------------- | ----------------------------------- |
| `ship-a.glb`   | 3d-model.obj (= 3d-model 2.obj)     |
| `ship-b.glb`   | 3d-model 3.obj                      |
| `ship-cr90.glb`| uploads_files_3436198_CR90_New.obj  |
| `bay.glb`      | Launch Bay.obj — the amber skyline  |
