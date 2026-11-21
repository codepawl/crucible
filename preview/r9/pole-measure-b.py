import math
import numpy as np
from PIL import Image
import sys
heights = {1: float(sys.argv[1]), 3: float(sys.argv[2]), 5: float(sys.argv[3])}
eye = np.array([0, 1.2, -45.0]); target = np.array([0, 4.0, 0])
forward = (target - eye) / np.linalg.norm(target - eye)
right = np.cross(forward, [0, 1, 0]); right /= np.linalg.norm(right)
up = np.cross(right, forward)
def project_row(point, height=540, fov=40):
    relative = np.array(point) - eye
    depth = relative @ forward
    return height / 2 - (relative @ up) / depth / math.tan(math.radians(fov / 2)) * height / 2
for time, predicted_height in heights.items():
    image = np.asarray(Image.open(f"galleon-poleb-t{time}.png").convert("RGB"), dtype=np.int16)
    red = (image[:, :, 0] > 180) & (image[:, :, 1] < 70) & (image[:, :, 2] < 70)
    rows = np.where(red.any(axis=1))[0]
    print(f"t={time}: pole rows {rows.min()}..{rows.max()}, predicted water row at the pole {project_row([-6, predicted_height, -8]):.1f}")
