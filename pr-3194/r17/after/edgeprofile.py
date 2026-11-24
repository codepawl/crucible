"""uv run --no-project --with numpy --with pillow python -I edgeprofile.py <glaze png> [label]
Mean linear luminance of ground pixels binned by basin depth relative to the water level (negative = road side, positive = water)."""
import sys, json
import numpy as np
sys.path.insert(0, '.')
import compare_helpers as h
from compare_helpers import W, H, CENTRE, VIEWS, rays, luminance, to_linear, LEVEL
from basin_port import basin
from PIL import Image

def depth_map(view):
    eye, d = rays(VIEWS[view][1])
    valid = d[..., 1] < -1e-4
    t = np.where(valid, -eye[1] / np.where(valid, d[..., 1], -1), np.nan)
    x, z = eye[0] + d[..., 0] * t, eye[2] + d[..., 2] * t
    depth = basin(np.nan_to_num(x), np.nan_to_num(z)) - LEVEL
    pt_depth = np.fromfile(f'pt/{view}-road.depth.f32', dtype=np.float32).reshape(H, W)
    ground = valid & (np.abs(pt_depth - t) < 0.02 * t) & (t < 12)
    return depth, ground

EDGES = [-0.10, -0.06, -0.04, -0.025, -0.015, -0.008, -0.004, 0.0, 0.004, 0.008, 0.015, 0.03, 0.06, 0.12]
def profile(lum, depth, ground):
    out = []
    for lo, hi in zip(EDGES[:-1], EDGES[1:]):
        m = ground & (depth >= lo) & (depth < hi)
        out.append((lo, hi, int(m.sum()), float(lum[m].mean()) if m.sum() else None))
    return out

if __name__ == '__main__':
    view = 'hero-clouds'
    depth, ground = depth_map(view)
    img = Image.open(sys.argv[1]).convert('RGB').resize((W, H), Image.BOX)
    g = luminance(np.asarray(img, float) / 255)
    pt = to_linear(h.pt_image(f'{view}-puddle-plain')) @ [0.2126, 0.7152, 0.0722]
    dry_road = g[ground & (depth < -0.12)].mean(); water = g[ground & (depth > 0.06)].mean()
    print('far road mean %.4f water mean(depth>0.06) %.4f' % (dry_road, water))
    print('depth bin        n   glaze   tracer')
    res = []
    for (lo, hi, n, gm), (_, _, _, pm) in zip(profile(g, depth, ground), profile(pt, depth, ground)):
        print('%+.3f..%+.3f %4d  %s  %s' % (lo, hi, n, ('%.4f' % gm) if gm else '-', ('%.4f' % pm) if pm else '-'))
        res.append([lo, hi, n, gm, pm])
    json.dump(res, open(sys.argv[2] if len(sys.argv) > 2 else 'edgeprofile.json', 'w'))
