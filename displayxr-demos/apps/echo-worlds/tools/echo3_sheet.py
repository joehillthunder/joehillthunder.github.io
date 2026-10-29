"""Contact sheet: a 3/4 view (yaw 30, pitch 35 down) of every world's coarsest LOD, cut at
1.6 m above the floor from worlds.json.  python echo3_sheet.py <cache> <worlds.json> <out.png>"""
import json, math, sys
import numpy as np
from PIL import Image, ImageDraw
import echo3_views as v

cache, wj, out = sys.argv[1:4]
rows = json.load(open(wj))
tiles = []
for r in rows:
    p, c = v.load(r['id'], cache)
    keep = (p[:, 1] > r['floorY'] - 0.3) & (p[:, 1] < r['floorY'] + 1.6)
    p, c = p[keep], c[keep]
    p = p - np.median(p, axis=0)
    yaw, pitch = math.radians(30), math.radians(35)
    # Y-up asset: rotate about y (yaw), then tilt so we look down at the floor.
    x = p[:, 0] * math.cos(yaw) + p[:, 2] * math.sin(yaw)
    z = -p[:, 0] * math.sin(yaw) + p[:, 2] * math.cos(yaw)
    y = p[:, 1] * math.cos(pitch) - z * math.sin(pitch)     # screen up
    near = p[:, 1] * math.sin(pitch) + z * math.cos(pitch)   # towards a viewer at +z, above
    o = np.argsort(near)               # painter's order: far first
    q = np.stack([x[o], y[o], np.zeros(len(o))], 1)
    img, _ = v.ortho(q, c[o], 0, 1, flip_v=True, size=300)
    canvas = Image.new('RGB', (320, 260), (64, 64, 64))
    img.thumbnail((310, 230))
    canvas.paste(img, (5, 25))
    ImageDraw.Draw(canvas).text((6, 6), f"{r['title'][:40]}  {r['size']}", fill=(235, 235, 235))
    tiles.append(canvas)
cols = 4
sheet = Image.new('RGB', (320 * cols, 260 * math.ceil(len(tiles) / cols)), (40, 40, 40))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols) * 320, (i // cols) * 260))
sheet.save(out)
print(out, sheet.size)
