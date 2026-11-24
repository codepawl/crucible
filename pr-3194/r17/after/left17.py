import sys; sys.path.insert(0, ".")
"""uv run --no-project --with numpy --with pillow python -I left17.py <glaze-folder> <out.json>
Left region (columns 75..195 of the 480 px hero-clouds frame) with every tile labelled, the puddle-mask edge drawn on the reflection tiles,
and statistics inside the mask and for the road pixels of the crop (the near-black pixels of the reflection-only row)."""
import sys, json
import numpy as np
from PIL import Image, ImageDraw
import compare_helpers as h
from compare_helpers import to_linear, masks, VIEWS
h.GLAZE = sys.argv[1]
out = sys.argv[2]
view = 'hero-clouds'
puddle, road, ground = masks(view, VIEWS[view][1])
cols = np.zeros_like(puddle); cols[:, 75:195] = True
region = puddle & cols
def enc(l):
    l = np.clip(l, 0, 1); return np.where(l <= 0.0031308, l * 12.92, 1.055 * l ** (1 / 2.4) - 0.055)
tot_pt = to_linear(h.pt_image(f'{view}-puddle-plain')); ref_pt = to_linear(h.pt_image(f'{view}-puddle-black'))
g_tot = h.glaze_image(f'{view}-total'); g_ref = h.glaze_image(f'{view}-reflection')
def stat(img_srgb, mask):
    lin = to_linear(img_srgb)[mask]; m = lin.mean(0); lum = float(m @ [0.2126, 0.7152, 0.0722])
    return dict(lum=round(lum, 4), chroma=[round(float(c), 3) for c in m / m.mean()], px=int(mask.sum()))
road_in_crop = ground & ~puddle & cols
res = {'region_px': int(region.sum()),
 'glaze_total': stat(g_tot, region), 'tracer_total': stat(enc(tot_pt), region),
 'glaze_reflection': stat(g_ref, region), 'tracer_reflection': stat(enc(ref_pt), region),
 'road_pixels_in_crop_reflection_only': {'glaze': stat(g_ref, road_in_crop), 'tracer': stat(enc(ref_pt), road_in_crop)}}
json.dump(res, open(out, 'w'), indent=1); print(json.dumps(res))
rows = np.where(region.any(1))[0]; r0, r1 = rows.min() - 4, rows.max() + 4
def crop(a): return a[r0:r1, 70:200]
def edge(mask):
    m = mask.astype(bool); e = m ^ np.roll(m, 1, 0) | m ^ np.roll(m, 1, 1); return e
def with_edge(img): 
    img = img.copy(); img[edge(puddle)] = [1, 0.1, 0.1]; return img
panels = [('Glaze, total', crop(g_tot)), ('Path tracer, total', crop(enc(tot_pt))),
          ('Glaze, reflection only', crop(g_ref)), ('Path tracer, reflection only', crop(enc(ref_pt))),
          ('Glaze, reflection only + puddle mask edge (red)', crop(with_edge(g_ref))), ('Path tracer, reflection only + puddle mask edge (red)', crop(with_edge(enc(ref_pt))))]
tiles = []
for label, array in panels:
    tile = Image.fromarray((np.clip(array, 0, 1) * 255).astype(np.uint8)).resize((array.shape[1] * 4, array.shape[0] * 4), Image.NEAREST)
    canvas = Image.new('RGB', (tile.width, tile.height + 18), (255, 255, 255)); canvas.paste(tile, (0, 18))
    ImageDraw.Draw(canvas).text((3, 3), label, fill=(0, 0, 0)); tiles.append(canvas)
w = tiles[0].width; hgt = tiles[0].height
sheet = Image.new('RGB', (2 * w + 4, 3 * hgt + 8), (255, 255, 255))
for i, t in enumerate(tiles): sheet.paste(t, ((i % 2) * (w + 4), (i // 2) * (hgt + 4)))
sheet.save(out.replace('.json', '.png'))
