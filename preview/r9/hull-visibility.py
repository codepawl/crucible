"""Hull-bottom visibility per waterline from three passes (ship only, full scene, empty sky) at the clip camera, 480x270.

Per column the hull mask of the ship-only picture gives its lowest hull row; in the full scene that column's hull is visible down to a row too.
`hidden` is the difference in pixels (how much hull the water covers), `exposed` is the share of hull columns where the water covers less than 2 px.
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
folder = sys.argv[1]
waterlines = sys.argv[2:]
times = [0, 1, 2, 3, 4, 5]


def load(name):
    return np.asarray(Image.open(os.path.join(folder, name)).convert("RGB"), dtype=np.int16)


print("waterline | mean hull px hidden by water | share of hull columns with the bottom exposed (water covers < 2 px) | per time hidden px")
for waterline in waterlines:
    hidden_by_time = []
    exposed_by_time = []
    for time in times:
        empty = load(f"galleon-empty-t{time}.png")
        ship = load(f"galleon-ship-{waterline}-t{time}.png")
        full = load(f"galleon-full-{waterline}-t{time}.png")
        mask = np.abs(ship - empty).max(axis=2) > 14
        mask[: int(0.5 * mask.shape[0])] = False
        visible = mask & (np.abs(ship - full).max(axis=2) < 40)
        columns = np.where(mask.sum(axis=0) > 3)[0]
        hidden = []
        for column in columns:
            lowest_ship = np.where(mask[:, column])[0].max()
            rows_visible = np.where(visible[:, column])[0]
            lowest_full = rows_visible.max() if len(rows_visible) else lowest_ship - 40
            hidden.append(lowest_ship - lowest_full)
        hidden = np.array(hidden)
        hidden_by_time.append(hidden.mean())
        exposed_by_time.append((hidden < 2).mean())
    print(f"{waterline:>4} | {np.mean(hidden_by_time):5.1f} | {np.mean(exposed_by_time):4.2f} | " + " ".join(f"{value:.1f}" for value in hidden_by_time))
