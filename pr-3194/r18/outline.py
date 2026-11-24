"""uv run --no-project --with numpy --with pillow python -I outline.py <png>...: outline of the far-left puddle (box 30,15,230,75 of the 960 px hero):
water mask = blue minus red above 12 (of 255); corners = 2x2 windows with 1 or 3 mask pixels (each is a direction change of the boundary), diagonal windows count 2."""
import sys
import numpy as np
from PIL import Image
for path in sys.argv[1:]:
    im = np.asarray(Image.open(path).convert('RGB'), float)[15:75, 30:230]
    mask = (im[..., 2] - im[..., 0]) > 12
    a, b, c, d = mask[:-1, :-1], mask[:-1, 1:], mask[1:, :-1], mask[1:, 1:]
    count = a.astype(int) + b + c + d
    corners = int(((count == 1) | (count == 3)).sum()) + 2 * int(((count == 2) & (a == d)).sum())
    perimeter = int((mask[:, 1:] != mask[:, :-1]).sum() + (mask[1:] != mask[:-1]).sum())
    print('%s: water px %d, perimeter %d, direction changes %d, per 100 perimeter %.1f' % (path, mask.sum(), perimeter, corners, 100 * corners / max(perimeter, 1)))
