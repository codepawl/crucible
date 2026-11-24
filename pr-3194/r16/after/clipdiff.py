"""uv run --no-project --with numpy --with pillow python clipdiff.py <framesdir> ...: frame-to-frame |difference| of luminance (0..255 sRGB luma) over the rim boxes (960x540)."""
import sys, glob, json
import numpy as np
from PIL import Image
BOXES = {'rim lower right': (640, 370, 900, 500), 'rim far left': (30, 15, 230, 75), 'rim whole puddle': (90, 180, 900, 500)}
result = {}
for folder in sys.argv[1:]:
    files = sorted(glob.glob(folder + '/frame-*.png'))
    frames = [np.asarray(Image.open(f).convert('L'), float) for f in files]
    out = {}
    for name, (x0, y0, x1, y1) in BOXES.items():
        diffs = np.concatenate([np.abs(frames[i + 1][y0:y1, x0:x1] - frames[i][y0:y1, x0:x1]).ravel() for i in range(len(frames) - 1)])
        out[name] = {'mean': round(float(diffs.mean()), 3), 'p99': round(float(np.percentile(diffs, 99)), 2)}
    result[folder] = out
    print(folder, len(files), json.dumps(out))
json.dump(result, open('clip-rim-diff.json', 'w'), indent=1)
