import numpy as np
import compare_helpers as c
from compare_helpers import luminance, glaze_image, pt_image, masks, VIEWS, W, H
puddle, road, ground = masks('hero-clouds', VIEWS['hero-clouds'][1])
region = ground & (c.np.ones((H, W), bool))
g = luminance(glaze_image('hero-clouds-flat-dry')); p = luminance(pt_image('hero-clouds-flat'))
print('flat 0.3 diffuse ground, dry: glaze', round(g[region].mean(), 4), 'pt', round(p[region].mean(), 4), 'ratio', round(g[region].mean() / p[region].mean(), 3))
# direct sky (path tracer depth 0)
eye, directions = c.rays(VIEWS['hero-sky'][1])
depth = np.fromfile('pt/hero-sky-flat.depth.f32', dtype=np.float32).reshape(H, W)
sky = (directions[..., 1] > 0.0) & (depth == 0)
gs = luminance(glaze_image('hero-sky-flat-dry')); ps = luminance(pt_image('hero-sky-flat'))
print('sky px', int(sky.sum()), 'direct sky: glaze', round(gs[sky].mean(), 4), 'pt', round(ps[sky].mean(), 4), 'ratio', round(gs[sky].mean() / ps[sky].mean(), 3))
