import sys
import numpy as np
from PIL import Image
from scipy import ndimage
for path in sys.argv[1:]:
    im = np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32) / 255
    snow = im > 0.55
    labels, count = ndimage.label(snow)
    sizes = np.asarray(ndimage.sum(snow, labels, range(1, count + 1)))
    found = []
    for index in np.nonzero(sizes <= 4)[0]:
        mask = labels == index + 1
        ring = ndimage.binary_dilation(mask, np.ones((7, 7), bool)) & ~mask
        if snow[ring].mean() <= 0.15:
            y, x = ndimage.center_of_mass(mask)
            found.append((int(x), int(y), int(sizes[index])))
    print(path, found)
