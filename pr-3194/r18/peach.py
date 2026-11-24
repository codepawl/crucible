"""uv run --no-project --with numpy --with pillow python -I peach.py <glaze folder>
Warm pixels (R minus B, 0 to 255) of the Glaze hero (flat-colour facade) at 480 px, and what the path tracer shows at the same pixels."""
import sys
sys.path.insert(0, '.')
import numpy as np
from PIL import Image
import compare_helpers as h

folder = sys.argv[1]
h.GLAZE = folder


def at480(png):
    return np.asarray(Image.open(png).convert('RGB').resize((480, 270), Image.BOX), float)


total = at480(f'{folder}/hero-clouds-total.png')
reflection = at480(f'{folder}/hero-clouds-reflection.png')
tracer = h.pt_image('hero-clouds-puddle-plain') * 255
boxes = {'far-left tip and bottom edge (480 px box x 15..115, y 20..32)': (15, 115, 20, 32),
         'dot near (200, 345) of 960, i.e. (100, 172) of 480': (92, 109, 164, 181)}
for name, (x0, x1, y0, y1) in boxes.items():
    g = total[y0:y1, x0:x1]
    t = tracer[y0:y1, x0:x1]
    r = reflection[y0:y1, x0:x1]
    gw, tw, rw = g[..., 0] - g[..., 2], t[..., 0] - t[..., 2], r[..., 0] - r[..., 2]
    print(name)
    print('  Glaze total R-B max %.0f p95 %.0f | Glaze reflection-only R-B max %.0f | tracer total R-B max %.0f p95 %.0f | brightest RGB tracer %s Glaze %s' % (
        gw.max(), np.percentile(gw, 95), rw.max(), tw.max(), np.percentile(tw, 95),
        t.reshape(-1, 3)[np.argmax(t.sum(-1))].astype(int), g.reshape(-1, 3)[np.argmax(g.sum(-1))].astype(int)))
