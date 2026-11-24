"""uv run --no-project --with numpy --with pillow python edges.py <folder>: 10-90 edge width (px) of the mirrored pole and trunk against the direct one."""
import sys
import numpy as np
from PIL import Image

folder = sys.argv[1]


def luminance(name):
    image = np.asarray(Image.open(f'{folder}/{name}.png').convert('RGB'), dtype=np.float64) / 255
    return image @ np.array([0.2126, 0.7152, 0.0722])


def interpolated_index(normalised, level):
    for index in range(len(normalised) - 1):
        low, high = normalised[index], normalised[index + 1]
        if low < level <= high:
            return index + (level - low) / (high - low)
    return float('nan')


def edge_width(lum, rows, columns):
    widths = []
    for row in range(*rows):
        line = lum[row]
        centre = columns[0] + int(np.argmax(np.abs(np.diff(line[columns[0]:columns[1]]))))
        before = line[centre - 8:centre - 5].mean()
        after = line[centre + 6:centre + 9].mean()
        if abs(after - before) < 0.004:
            continue
        window = (line[centre - 5:centre + 7] - before) / (after - before)
        width = abs(interpolated_index(window, 0.9) - interpolated_index(window, 0.1))
        if not np.isnan(width):
            widths.append(width)
    return round(float(np.median(widths)), 2) if widths else float('nan'), len(widths)


clouds = luminance('hero-clouds-wet1')
tree = luminance('hero-tree-wet1')
print('pole  direct', edge_width(clouds, (20, 110), (565, 605)))
print('pole  mirror', edge_width(clouds, (230, 420), (555, 600)))
print('trunk direct', edge_width(tree, (30, 170), (480, 515)))
print('trunk mirror', edge_width(tree, (285, 325), (480, 515)))
