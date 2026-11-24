import numpy as np
from compare_helpers import luminance, glaze_image, pt_image, W, H
albedo = np.fromfile('pt/tree-under-road.albedo.f32', dtype=np.float32).reshape(H, W, 3)
leaf = (albedo[..., 1] > 2 * albedo[..., 0]) & (albedo[..., 1] > 0.1)
g = luminance(glaze_image('tree-under-dry')); p = luminance(pt_image('tree-under-road'))
print('leaf px', int(leaf.sum()), 'crown underside seen from below: glaze', round(g[leaf].mean(), 4), 'pt', round(p[leaf].mean(), 4), 'ratio', round(g[leaf].mean() / p[leaf].mean(), 3))
