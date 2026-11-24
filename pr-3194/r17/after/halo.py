import sys; sys.path.insert(0, '.')
import numpy as np
from PIL import Image
from compare_helpers import W, H, luminance
from edgeprofile import depth_map
depth, ground = depth_map('hero-clouds')
for path in sys.argv[1:]:
    g = luminance(np.asarray(Image.open(path).convert('RGB').resize((W, H), Image.BOX), float) / 255)
    road = g[ground & (depth < -0.12)].mean()
    dark = ground & (depth > -0.10) & (depth < 0.0) & (g < 0.9 * road)
    shore = ground & (np.abs(depth) < 0.003)
    # shore length in px: count of shore-band pixels divided by the band's mean width in px (depth gradient)
    gy, gx = np.gradient(np.where(ground, depth, np.nan))
    slope = np.hypot(gx, gy)[shore]; slope = slope[np.isfinite(slope)]
    shore_len = shore.sum() * np.nanmedian(slope) / 0.006
    px = dark.sum() / shore_len
    ratio = g[ground & (depth > -0.008) & (depth < 0.0)].mean() / road
    print('%s: dark(<0.9 road) px %d, halo thickness %.2f px at 480 (%.1f at 960); shore-bin / road %.2f' % (path, dark.sum(), px, 2 * px, ratio))
    box = np.zeros_like(ground); box[185:250, 320:450] = True
    inb = ground & box
    r = road
    d = inb & (depth > -0.10) & (depth < 0.0) & (g < 0.9 * r)
    sh = inb & (np.abs(depth) < 0.003)
    sl = np.hypot(*np.gradient(np.where(ground, depth, np.nan)))[sh]; sl = sl[np.isfinite(sl)]
    print('   lower-right box: halo thickness %.2f px at 960, shore/road %.2f' % (2 * d.sum() / (sh.sum() * np.median(sl) / 0.006), g[inb & (depth > -0.008) & (depth < 0)].mean() / r))
