import sys; sys.path.insert(0, ".")
"""Column where the building reflection ends inside the puddle (largest drop in reflection-only luminance along rows), Glaze against tracer, at 480 px."""
import sys
import numpy as np
import compare_helpers as h
from compare_helpers import to_linear, masks, VIEWS
h.GLAZE = sys.argv[1]
view = 'hero-clouds'
puddle = masks(view, VIEWS[view][1])[0]
g = to_linear(h.glaze_image(f'{view}-reflection')) @ [0.2126, 0.7152, 0.0722]
p = to_linear(h.pt_image(f'{view}-puddle-black')) @ [0.2126, 0.7152, 0.0722]
for name, lum in (('glaze', g), ('tracer', p)):
    cols = []
    for y in range(270):
        xs = np.where(puddle[y])[0]
        xs = xs[(xs > 150) & (xs < 330)]
        if len(xs) < 40: continue
        d = lum[y, xs[:-3]] - lum[y, xs[3:]]
        cols.append(xs[np.argmax(d)] + 1.5)
    print(name, 'edge column median %.0f (rows %d, p10 %.0f p90 %.0f), x2 at 960 px = %.0f' % (np.median(cols), len(cols), np.percentile(cols, 10), np.percentile(cols, 90), 2 * np.median(cols)))
