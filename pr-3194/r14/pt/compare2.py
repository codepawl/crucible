import numpy as np
import compare_helpers as c
from compare_helpers import luminance, glaze_image, pt_image, masks, VIEWS, W, H

for view in ('hero-clouds', 'hero-tree'):
    puddle, road, ground = masks(view, VIEWS[view][1])
    glaze = luminance(glaze_image(f'{view}-black'))
    truth = luminance(pt_image(f'{view}-puddle-black'))
    print(view, 'mirror only (bed albedo 0): glaze', round(glaze[puddle].mean(), 4), 'pt', round(truth[puddle].mean(), 4), 'ratio', round(glaze[puddle].mean() / truth[puddle].mean(), 3))
# Direct sky: rays above the horizon whose path tracer depth shows no object (road variant, same scene).
camera = VIEWS['hero-sky'][1]
eye, directions = c.rays(camera)
depth = np.fromfile('pt/hero-sky-road.depth.f32', dtype=np.float32).reshape(H, W)
glaze = luminance(glaze_image('hero-sky-wet1'))
truth = luminance(pt_image('hero-sky-road'))
print('depth quantiles', np.percentile(depth, [1, 50, 99]))
sky = (directions[..., 1] > 0.02) & ~np.isfinite(depth) | ((directions[..., 1] > 0.02) & (depth > 200))
print('sky px', int(sky.sum()))
if sky.any():
    print('direct sky: glaze', round(glaze[sky].mean(), 4), 'pt', round(truth[sky].mean(), 4), 'ratio', round(glaze[sky].mean() / truth[sky].mean(), 3))
