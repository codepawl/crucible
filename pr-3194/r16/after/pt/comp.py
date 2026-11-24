"""uv run --no-project --with numpy --with pillow python comp.py [tag]
Reflection / bed / total of the puddle, Glaze against the CPU path tracer (display-encoded, 480x270), over the puddle pixels.
Path tracer: reflection = water over a black bed, total = water over the plain wet asphalt, bed = total - reflection in linear light.
Also writes side-by-side component sheets to sheets/ (left Glaze, right path tracer)."""
import json, os, sys
import numpy as np
from PIL import Image
import compare_helpers as h
from compare_helpers import luminance, to_linear, masks, VIEWS, W, H

tag = sys.argv[1] if len(sys.argv) > 1 else ''
os.makedirs('sheets', exist_ok=True)


def glaze(view, component):
    return h.glaze_image(f'{view}-{component}')


def tracer(view, ground):
    return h.pt_image(f'{view}-{ground}')


def encode(linear):
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)


if __name__ == "__main__":
  pass
rows = []
for view, (_, camera) in VIEWS.items():
    if view == 'hero-sky':
        continue
    puddle, road, ground = masks(view, camera)
    total_pt = to_linear(tracer(view, 'puddle-plain'))
    reflection_pt = to_linear(tracer(view, 'puddle-black'))
    bed_pt = np.clip(total_pt - reflection_pt, 0, None)
    images = {
        'reflection': (glaze(view, 'reflection'), encode(reflection_pt)),
        'bed': (glaze(view, 'bed'), encode(bed_pt)),
        'total': (glaze(view, 'total'), encode(total_pt)),
    }
    row = {'view': view, 'puddle_px': int(puddle.sum())}
    for name, (g, p) in images.items():
        gl, pl = luminance(g), luminance(p)
        row[name] = {'glaze': round(float(gl[puddle].mean()), 4), 'tracer': round(float(pl[puddle].mean()), 4)}
        row[name]['ratio'] = round(row[name]['glaze'] / max(row[name]['tracer'], 1e-6), 2)
        gm = g[puddle].mean(0)
        pm = p[puddle].mean(0)
        row[name]['glaze_rgb_chroma'] = [round(float(c), 3) for c in gm / gm.mean()]
        row[name]['tracer_rgb_chroma'] = [round(float(c), 3) for c in pm / max(pm.mean(), 1e-6)]
        sheet = np.concatenate([g, np.ones((H, 6, 3)), p], axis=1)
        Image.fromarray((np.clip(sheet, 0, 1) * 255).astype(np.uint8)).resize((sheet.shape[1] * 2, H * 2), Image.NEAREST).save(f'sheets/{view}-{name}{tag}.png')
    rows.append(row)
    print(json.dumps(row))
json.dump(rows, open(f'components{tag}.json', 'w'), indent=1)
