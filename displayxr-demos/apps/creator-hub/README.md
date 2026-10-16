# Creator Hub

Three creator tools for glasses-free 3D on DisplayXR (and 2D in any browser). Upload or create, then
**Push to DisplayXR HQ**, where creations show up in the Creator Gallery on the homepage.

Live: https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/

| Tool | What you can do |
|---|---|
| [Material Forge](https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/material/) | Layered PBR materials from 14 tileable generators, masks and blend modes; sample colours, palettes and whole materials from photos; paint on 3D objects; build objects from primitives or upload GLB/OBJ/STL; export maps and .glb |
| [Vehicle Studio](https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/vehicle/) | Configure a coupe, sedan, SUV or your own uploaded car: paint finishes, rims, calipers, glass, interior, lights, stance; variant sets; studio/showroom/sunset/night/HDR lighting; mirror floor; viewpoints; renders |
| [Terra Studio](https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/terra/) | Real terrain anywhere (elevation + imagery/topo/streets), contours, elevation tint, water level, OSM buildings, GeoJSON/CSV/heightmap layers, identify, measure with profiles, line of sight, sketching |
| [HQ Viewer](https://joehillthunder.github.io/displayxr-demos/apps/creator-hub/view/) | Look at anything pushed to HQ in 3D |

Pushed creations are stored in the browser (IndexedDB on the joehillthunder.github.io origin), so they
appear on the same PC and browser. Use "Download .glb" to move one elsewhere.

Data credits: Esri World Imagery and World Topographic Map, © OpenStreetMap contributors (tiles and
buildings via Overpass), Mapzen Terrain Tiles on AWS. No bundled assets: every model and texture is
procedural or supplied by the user.

Developer notes: [CLAUDE.md](CLAUDE.md).
