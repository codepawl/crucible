# Usage: metrics.py <folder...>   coverage (mountain box) and isolated snow specks of <view>-pixel.png in each folder.
# Speck = connected component (4-neighbour) of 4 pixels or fewer with luminance above 0.55 whose ring (7x7 around it, minus itself)
# holds at most 15 percent snow pixels, counted over the whole frame (rock only; the sky and sea are bright or flat and skipped by the ring test).
import sys, json
import numpy as np
from PIL import Image
from scipy import ndimage
BOX = {'heavy': (330, 520, 950, 700), 'close': (400, 300, 880, 600)}
out = {}
for path in sys.argv[1:]:
    for view in ('close', 'heavy'):
        im = np.asarray(Image.open(f'{path}/{view}-pixel.png').convert('RGB'), dtype=np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32) / 255
        x0, y0, x1, y1 = BOX[view]
        snow = im > 0.55
        labels, count = ndimage.label(snow)
        sizes = np.asarray(ndimage.sum(snow, labels, range(1, count + 1)))
        near = ndimage.uniform_filter(snow.astype(np.float32), 7) * 49
        specks = []
        for index in np.nonzero(sizes <= 4)[0]:
            mask = labels == index + 1
            ring = ndimage.binary_dilation(mask, np.ones((7, 7), bool)) & ~mask
            if snow[ring].mean() <= 0.15:
                specks.append(ndimage.center_of_mass(mask))
        inbox = [s for s in specks if y0 <= s[0] < y1 and x0 <= s[1] < x1]
        out[f'{path}|{view}'] = {'coverage': round(float(snow[y0:y1, x0:x1].mean()), 4), 'isolatedSpecksFrame': len(specks), 'isolatedSpecksBox': len(inbox)}
print(json.dumps(out, indent=1))
