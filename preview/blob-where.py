import subprocess
import sys

import numpy as np

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
width, height = 480, 270
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", sys.argv[1], "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
frames = np.frombuffer(raw, np.uint8).reshape(-1, height, width).astype(np.int16)
water_top = int(height * 0.45)
bright = frames[:, water_top:, :] > 220
transient = bright[1:-1] & ~bright[:-2] & ~bright[2:]
total = transient.sum()
by_row_band = [int(transient[:, band:band + 15, :].sum()) for band in range(0, height - water_top, 15)]
by_column_band = [int(transient[:, :, band:band + 48].sum()) for band in range(0, width, 48)]
print("transient total", total)
print("by 15-row band from y", water_top, by_row_band)
print("by 48-column band", by_column_band)
