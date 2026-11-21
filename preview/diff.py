import sys, glob, numpy as np
from PIL import Image
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
folder = sys.argv[1]
files = sorted(glob.glob(folder + "/*.png"))
frames = [np.asarray(Image.open(file).convert("L"), dtype=np.float32) for file in files]
h, w = frames[0].shape
# regions (y0,y1,x0,x1) in a 480x270 frame, scaled
regions = {"nearL": (0.70, 1.0, 0.0, 0.3), "nearR": (0.70, 1.0, 0.7, 1.0), "mid": (0.55, 0.68, 0.0, 0.25), "far": (0.45, 0.55, 0.7, 1.0)}
out = {}
for name, (top, bottom, left, right) in regions.items():
    y0, y1, x0, x1 = int(top*h), int(bottom*h), int(left*w), int(right*w)
    means, p99s = [], []
    for i in range(1, len(frames)):
        diff = np.abs(frames[i][y0:y1, x0:x1] - frames[i-1][y0:y1, x0:x1])
        means.append(diff.mean()); p99s.append(np.percentile(diff, 99))
    # second difference: high-frequency flicker (change of change)
    out[name] = (np.mean(means), np.max(means), np.mean(p99s), np.max(p99s))
    print(f"{name:6s} meanAbsDiff avg {np.mean(means):.2f} max {np.max(means):.2f} | p99 avg {np.mean(p99s):.1f} max {np.max(p99s):.1f}")
# per-frame series for nearL
y0,y1,x0,x1=int(.7*h),h,0,int(.3*w)
print("nearL per-pair mean:", " ".join(f"{np.abs(frames[i][y0:y1,x0:x1]-frames[i-1][y0:y1,x0:x1]).mean():.1f}" for i in range(1,len(frames))))
# block map of average diff over the clip
bs=30
print("block map (rows top->bottom) avg diff:")
for by in range(0,h,bs):
    print(" ".join(f"{np.mean([np.abs(frames[i][by:by+bs,bx:bx+bs]-frames[i-1][by:by+bs,bx:bx+bs]).mean() for i in range(1,len(frames))]):5.1f}" for bx in range(0,w,bs)))
