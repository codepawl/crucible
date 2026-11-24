"""uv run --no-project --with numpy --with pillow python -I left18.py <glaze-folder> <out.json>
Round 18: the statistics mask covers every ground pixel left of the wall end (column 192 of 480) whose basin depth is above 0.01 (the water interior,
not the anti-aliased shore), not only the deep blob (above 0.03). Flat-facade Glaze against the tracer; labelled tiles with the mask edge in red."""
import sys
sys.path.insert(0, '.')
import json
import numpy as np
from PIL import Image, ImageDraw
import compare_helpers as h
from compare_helpers import to_linear, W, H
from edgeprofile import depth_map

h.GLAZE = sys.argv[1]
out = sys.argv[2]
view = 'hero-clouds'
depth, ground = depth_map(view)
g_lum_ref = to_linear(h.glaze_image(f'{view}-reflection')) @ [0.2126, 0.7152, 0.0722]
wide = ground & (g_lum_ref > 0.0065) & (depth > -0.004)
cols = np.zeros_like(wide)
cols[:, :192] = True
region = wide & cols


def encode_srgb(linear):
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)


tot_pt = to_linear(h.pt_image(f'{view}-puddle-plain'))
ref_pt = to_linear(h.pt_image(f'{view}-puddle-black'))
g_tot = h.glaze_image(f'{view}-total')
g_ref = h.glaze_image(f'{view}-reflection')


def stat(img_srgb, mask):
    lin = to_linear(img_srgb)[mask]
    mean_linear = lin.mean(0)
    lum = float(mean_linear @ [0.2126, 0.7152, 0.0722])
    return dict(lum=round(lum, 4), chroma=[round(float(channel), 3) for channel in mean_linear / mean_linear.mean()], px=int(mask.sum()))


results = {'mask': 'ground pixels that are water in the Glaze render (reflection-only luminance above 0.0065, the basin port is unreliable on the shallow left side), columns 0 to 191 of 480', 'region_px': int(region.sum()),
       'glaze_total': stat(g_tot, region), 'tracer_total': stat(encode_srgb(tot_pt), region),
       'glaze_reflection': stat(g_ref, region), 'tracer_reflection': stat(encode_srgb(ref_pt), region)}
column_index = np.arange(W)[None, :]
for name, selector in (('columns below 120', cols & (column_index < 120)), ('columns 120 to 191', cols & (column_index >= 120))):
    selected = wide & selector
    results[name] = {'glaze_reflection': stat(g_ref, selected), 'tracer_reflection': stat(encode_srgb(ref_pt), selected)}
json.dump(results, open(out, 'w'), indent=1)
print(json.dumps(results))

rows = np.where(region.any(1))[0]
r0, r1 = rows.min() - 4, rows.max() + 4


def crop(a):
    return a[r0:r1, 20:200]


def edge(mask):
    boolean_mask = mask.astype(bool)
    return boolean_mask ^ np.roll(boolean_mask, 1, 0) | boolean_mask ^ np.roll(boolean_mask, 1, 1)


def with_edge(img):
    img = img.copy()
    img[edge(region)] = [1, 0.1, 0.1]
    return img


panels = [('Glaze (flat-colour facade), total', crop(g_tot)), ('Path tracer, total', crop(encode_srgb(tot_pt))),
          ('Glaze, reflection only', crop(g_ref)), ('Path tracer, reflection only', crop(encode_srgb(ref_pt))),
          ('Glaze, reflection only + stats mask edge (red)', crop(with_edge(g_ref))),
          ('Path tracer, reflection only + stats mask edge (red)', crop(with_edge(encode_srgb(ref_pt))))]
tiles = []
for label, array in panels:
    tile = Image.fromarray((np.clip(array, 0, 1) * 255).astype(np.uint8)).resize((array.shape[1] * 3, array.shape[0] * 3), Image.NEAREST)
    canvas = Image.new('RGB', (tile.width, tile.height + 18), (255, 255, 255))
    canvas.paste(tile, (0, 18))
    ImageDraw.Draw(canvas).text((3, 3), label, fill=(0, 0, 0))
    tiles.append(canvas)
w = tiles[0].width
hgt = tiles[0].height
sheet = Image.new('RGB', (2 * w + 4, 3 * hgt + 8), (255, 255, 255))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % 2) * (w + 4), (i // 2) * (hgt + 4)))
sheet.save(out.replace('.json', '.png'))
