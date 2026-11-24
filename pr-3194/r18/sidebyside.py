"""uv run --no-project --with numpy --with pillow python -I sidebyside.py
Full Glaze hero (flat-colour facade, 960 px frame reduced to 480) next to the full path tracer hero (the whole ground is water), same camera, labelled,
and the same for reflection only. Red ticks at the top and bottom mark the column the wall end should mirror at. Reports the column where the
building reflection steps, in both."""
import sys
sys.path.insert(0, '.')
import json
import numpy as np
from PIL import Image, ImageDraw
import compare_helpers as h
from compare_helpers import to_linear

EXPECTED = 383 / 2
h.GLAZE = 'diag-flat'


def label(image, text):
    canvas = Image.new('RGB', (image.width, image.height + 18), (255, 255, 255))
    canvas.paste(image, (0, 18))
    ImageDraw.Draw(canvas).text((3, 3), text, fill=(0, 0, 0))
    return canvas


def tick(array, column):
    array = array.copy()
    array[:6, column] = [1, 0, 0]
    array[-6:, column] = [1, 0, 0]
    return array


def encode_srgb(linear):
    linear = np.clip(linear, 0, 1)
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)


g_total = h.glaze_image('hero-clouds-total')
g_ref = h.glaze_image('hero-clouds-reflection')
t_total = h.pt_image('hero-clouds-puddle-plain')
t_ref = encode_srgb(to_linear(h.pt_image('hero-clouds-puddle-black')))
items = [(g_total, 'Glaze, total (flat-colour facade; patches of water)'),
         (t_total, 'Path tracer, total (whole ground is water; same camera and wall)'),
         (g_ref, 'Glaze, reflection only'),
         (t_ref, 'Path tracer, reflection only (black bed)')]
tiles = [label(Image.fromarray((tick(a, int(EXPECTED)) * 255).astype(np.uint8)).resize((960, 540), Image.NEAREST), t) for a, t in items]
sheet = Image.new('RGB', (1924, 2 * tiles[0].height + 4), (255, 255, 255))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % 2) * 964, (i // 2) * (tiles[0].height + 4)))
sheet.save('after/hero-side-by-side-r18.png')

results = {}
for name, img in (('glaze', g_ref), ('tracer', t_ref)):
    lum = to_linear(img) @ [0.2126, 0.7152, 0.0722]
    columns = []
    for y in range(150, 262):
        row = lum[y, 150:245]
        if (row > 0.004).sum() < 60:
            continue
        smooth = np.convolve(row, np.ones(3) / 3, 'valid')
        step = smooth[:-4] - smooth[4:]
        columns.append(150 + 3 + int(np.argmax(np.abs(step))))
    results[name] = {'rows': len(columns),
                 'median_column_480': float(np.median(columns)) if columns else None,
                 'p10': float(np.percentile(columns, 10)) if columns else None,
                 'p90': float(np.percentile(columns, 90)) if columns else None}
results['expected_column_480_from_geometry'] = EXPECTED
print(json.dumps(results))
json.dump(results, open('after/wall-end-column-r18.json', 'w'), indent=1)
