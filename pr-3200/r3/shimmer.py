# Usage: shimmer.py <folder with r2-<view> and r3-<view>> <view> <out json>
# Snow region = pixels with luminance above 0.55 in at least 90 percent of the r2 frames, inside the mountain box of the
# r2 coverage check. Shimmer = |luminance change| between consecutive frames inside it (mean and p99 over all pairs).
import json, sys, glob
import numpy as np
from PIL import Image
folder, view, out = sys.argv[1:4]
BOX = {'heavy': (330, 520, 950, 700), 'close': (400, 300, 880, 600)}[view]
def load(label):
    files = sorted(glob.glob(f'{folder}/{label}-{view}/f*.png'))
    return np.stack([np.asarray(Image.open(f).convert('RGB'), dtype=np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32) / 255 for f in files])
before, after = load('r2'), load('r3')
x0, y0, x1, y1 = BOX
region = np.zeros(before.shape[1:], bool)
region[y0:y1, x0:x1] = (before[:, y0:y1, x0:x1] > 0.55).mean(axis=0) >= 0.9
# Interior only: drop pixels within ERODE pixels of the region edge (and of any pixel under 0.55 in the r2 frames), so camera parallax
# of the snow boundary does not drown the speckle shimmer.
ERODE = 3
for _ in range(ERODE):
    padded = np.pad(region, 1, constant_values=False)
    region = region & padded[:-2, 1:-1] & padded[2:, 1:-1] & padded[1:-1, :-2] & padded[1:-1, 2:]
def stats(frames):
    diffs = np.abs(np.diff(frames, axis=0))[:, region]
    flicker = np.abs(frames[1:-1] - 0.5 * (frames[:-2] + frames[2:]))[:, region]
    return {'mean': float(diffs.mean()), 'p99': float(np.percentile(diffs, 99)), 'p999': float(np.percentile(diffs, 99.9)), 'share_above_0.1': float((diffs > 0.1).mean()), 'flicker_mean': float(flicker.mean()), 'flicker_p99': float(np.percentile(flicker, 99)), 'pixels': int(region.sum()), 'frames': int(len(frames))}
result = {'view': view, 'r2': stats(before), 'r3': stats(after)}
json.dump(result, open(out, 'w'), indent=1)
print(json.dumps(result))
