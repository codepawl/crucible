import sys, glob, numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
files = sorted(glob.glob(sys.argv[1] + "/*.png"))
frames = [np.asarray(Image.open(file).convert("L"), dtype=np.float32) for file in files]
h, w = frames[0].shape
# hull crop: the waterline band around the ship, 19-75 percent of the width, 63-84 percent of the height
y0, y1, x0, x1 = int(0.63 * h), int(0.84 * h), int(0.19 * w), int(0.75 * w)
means, p99s = [], []
for i in range(1, len(frames)):
    difference = np.abs(frames[i][y0:y1, x0:x1] - frames[i - 1][y0:y1, x0:x1])
    means.append(difference.mean()); p99s.append(np.percentile(difference, 99))
print(f"hull frames {len(frames)} meanAbsDiff avg {np.mean(means):.2f} max {np.max(means):.2f} | p99 avg {np.mean(p99s):.1f} max {np.max(p99s):.1f}")
print("per pair mean:", " ".join(f"{mean:.1f}" for mean in means[:24]))
