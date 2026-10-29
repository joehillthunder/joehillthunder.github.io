"""Orthographic colour views (top, front, side) of an Echo-3 world's coarsest LOD, to check
orientation and the floor/ceiling picks.  python echo3_views.py <cache dir> <out dir> id ..."""
import json, os, sys
import numpy as np
from PIL import Image
import echo3_frame as e


def load(wid, cache):
    base = e.BASE + wid + '.lod/'
    lod = json.loads(e.fetch(base + 'lod-meta.json', cache))
    P, C = [], []
    for f in lod['filenames']:
        if not f.startswith(str(lod['lodLevels'] - 1) + '_'):
            continue
        m = json.loads(e.fetch(base + f, cache))
        d = base + f.rsplit('/', 1)[0] + '/'
        p, a = e.decode_chunk(d, m, cache)
        sh0 = e.rgba(e.fetch(d + m['sh0']['files'][0], cache)).reshape(-1, 4)[:m['count']]
        cb = np.array(m['sh0']['codebook'])
        rgb = np.clip(0.5 + 0.28209479 * cb[sh0[:, :3]], 0, 1)
        k = a > 0.3
        P.append(p[k]); C.append(rgb[k])
    return np.concatenate(P), np.concatenate(C)


def ortho(p, c, ax_u, ax_v, flip_v, size=500):
    u, v = p[:, ax_u], p[:, ax_v]
    u0, u1 = np.quantile(u, [0.01, 0.99]); v0, v1 = np.quantile(v, [0.01, 0.99])
    s = size / max(u1 - u0, v1 - v0)
    W, H = int((u1 - u0) * s) + 1, int((v1 - v0) * s) + 1
    iu = ((u - u0) * s).astype(int); iv = ((v - v0) * s).astype(int)
    if flip_v:
        iv = H - 1 - iv
    k = (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
    img = np.full((H, W, 3), 0.25)
    img[iv[k], iu[k]] = c[k]
    return Image.fromarray((img * 255).astype(np.uint8)), (u0, u1, v0, v1)


def main():
    cache, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for wid in sys.argv[3:]:
        p, c = load(wid, cache)
        # Rows of the image go +y downward, so a Y-down asset shows upright with flip_v False.
        for name, (a, b) in {'front_xy': (0, 1), 'side_zy': (2, 1), 'top_xz': (0, 2)}.items():
            img, ext = ortho(p, c, a, b, flip_v=False)
            img.save(os.path.join(out, f'{wid}_{name}.png'))
            print(wid, name, img.size, [round(float(x), 2) for x in ext])


if __name__ == '__main__':
    main()
