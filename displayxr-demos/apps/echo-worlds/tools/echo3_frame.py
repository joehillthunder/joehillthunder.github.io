"""Bake framing for SpAItial Echo-3 gallery worlds (Streamed SOG).

Reads the coarsest LOD level of each world's lod-meta.json, decodes splat centres and
opacity (SOG v2), and writes per-world floor / ceiling / footprint in the splat's own space:
what the DisplayXR splat tile needs for the dollhouse view (clip box + frame bounds).

    python -I echo3_frame.py <cache dir> <out worlds.json> [id ...]
"""
import io, json, math, os, sys, urllib.request
import numpy as np
from PIL import Image

BASE = 'https://echodot.spaitial.io/echo-3-release/featured-gallery-v4/'

WORLDS = {
    'splat-008-1020f57fbee6': 'House with Fireplace Lounge',
    'splat-004-94a797c2b5cc': 'Courtyard Garden with Wooden Balconies',
    'splat-018-aa612739ee25': 'School Library',
    'splat-013-fef0daa1ff00': 'Museum Gallery with Modern Paintings',
    'splat-023-a10add86f5c9': 'School Gym',
    'splat-010-30891d477e09': 'Chinese Temple Hall',
    'splat-011-dc5135b6b5bf': 'Historic Vaulted Hall',
    'splat-009-a3d7d7b2084d': 'Colorful Kids Playroom',
    'splat-021-805f18a986c8': 'Robotics Workshop',
    'splat-006-2a5bff23f409': 'City Apartment Living Room',
    'splat-015-da5c45cf0321': 'Colorful Cafe with Mezzanine',
    'splat-025-e7fdd4c433d4': 'Wood-panelled Dining Hall',
    'splat-003-b07c661d7380': 'Urban Community Garden',
    'splat-019-ba4cb5f5c9fd': 'Computer Classroom',
    'splat-017-63c13cdb2e6d': 'Electronics Classroom',
    'splat-024-cd1c262f66bf': 'Game Room & Auditorium',
    'splat-012-6bde6d55e122': 'Fine Arts Museum Gallery',
    'splat-014-dbd185d9def1': 'Neighbourhood Cafe with Photo Wall',
    'splat-005-f9fbc1216412': 'Open-plan Kitchen & Living Room',
    'splat-022-88f329ed5e0d': 'Conference Room',
}


def fetch(url, cache):
    path = os.path.join(cache, url[len(BASE):].replace('/', '__'))
    if not os.path.exists(path):
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read()
        with open(path + '.part', 'wb') as f:
            f.write(data)
        os.replace(path + '.part', path)
    with open(path, 'rb') as f:
        return f.read()


def rgba(data):
    return np.asarray(Image.open(io.BytesIO(data)).convert('RGBA'))


def decode_chunk(base, meta, cache):
    """Splat centres (n,3) and opacity (n,) of one SOG v2 chunk."""
    n = meta['count']
    lo = rgba(fetch(base + meta['means']['files'][0], cache)).reshape(-1, 4)[:n, :3].astype(np.float64)
    hi = rgba(fetch(base + meta['means']['files'][1], cache)).reshape(-1, 4)[:n, :3].astype(np.float64)
    v = (hi * 256 + lo) / 65535.0
    mn, mx = np.array(meta['means']['mins']), np.array(meta['means']['maxs'])
    t = mn + (mx - mn) * v
    xyz = np.sign(t) * (np.exp(np.abs(t)) - 1)   # SOG log transform
    sh0 = rgba(fetch(base + meta['sh0']['files'][0], cache)).reshape(-1, 4)[:n]
    return xyz, sh0[:, 3] / 255.0


def frame_world(wid, cache):
    base = BASE + wid + '.lod/'
    lod = json.loads(fetch(base + 'lod-meta.json', cache))
    coarse = str(lod['lodLevels'] - 1)
    pts, ops = [], []
    for fname in lod['filenames']:
        if not fname.startswith(coarse + '_'):
            continue
        meta = json.loads(fetch(base + fname, cache))
        xyz, op = decode_chunk(base + fname.rsplit('/', 1)[0] + '/', meta, cache)
        pts.append(xyz)
        ops.append(op)
    p, w = np.concatenate(pts), np.concatenate(ops)
    keep = w > 0.3
    p, w = p[keep], w[keep]

    # Echo-3 worlds are Y-UP (unlike most 3DGS exports, which are Y-down), origin near the
    # first camera, so the floor sits about 1.5 m below 0. Histogram along y.
    y = p[:, 1]
    lo_q, hi_q = np.quantile(y, [0.005, 0.995])
    bins = np.arange(lo_q, hi_q + 0.05, 0.05)
    h, edges = np.histogram(y, bins=bins, weights=w)
    centres = (edges[:-1] + edges[1:]) / 2
    # Floor = the lowest slab holding >= 25 % of the densest slab's weight, so a multi-storey
    # capture gets its ground floor. Ceiling = the highest such slab (often just shelf tops:
    # many captures stop below the ceiling).
    dense = np.nonzero(h >= 0.25 * h.max())[0]
    floor_i, ceil_i = int(dense[0]), int(dense[-1])
    floor_y, ceil_y = float(centres[floor_i]), float(centres[ceil_i])
    height = ceil_y - floor_y

    # Footprint: robust x/z extent of splats between floor and ceiling.
    band = (y > floor_y - 0.1) & (y < ceil_y + 0.1)
    xs, zs = p[band, 0], p[band, 2]
    x0, x1 = np.quantile(xs, [0.02, 0.98])
    z0, z1 = np.quantile(zs, [0.02, 0.98])
    return {
        'id': wid,
        'title': WORLDS.get(wid, wid),
        'url': base + 'lod-meta.json',
        'splats': lod['count'],
        'sampled': int(len(p)),
        'floorY': round(floor_y, 3),
        'ceilingY': round(ceil_y, 3),
        'roomHeight': round(height, 3),
        'footprint': {'x': [round(float(x0), 3), round(float(x1), 3)],
                      'z': [round(float(z0), 3), round(float(z1), 3)]},
        'size': [round(float(x1 - x0), 2), round(height, 2), round(float(z1 - z0), 2)],
    }


def main():
    cache, out = sys.argv[1], sys.argv[2]
    ids = sys.argv[3:] or list(WORLDS)
    os.makedirs(cache, exist_ok=True)
    rows = []
    for wid in ids:
        try:
            r = frame_world(wid, cache)
        except Exception as e:  # keep going; report at the end
            print(f'{wid}: FAILED {e}', file=sys.stderr)
            continue
        rows.append(r)
        print(f"{r['title'][:38]:38s} size {r['size']} floor {r['floorY']} ceil {r['ceilingY']} splats {r['splats']:,}")
    with open(out, 'w') as f:
        json.dump(rows, f, indent=1)


if __name__ == '__main__':
    main()
