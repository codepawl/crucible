"""Acceptance sheet measurements for PR #3246 (checks 1, 3, 4, 5, 6, 7) from the r8 PNGs.
Run: uv run --no-project python -I meas8.py [folder]"""
import sys, math, colorsys, json
from pathlib import Path
import numpy as np
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FOLDER = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent
NAMES = ["smoothPlastic", "wood", "grass", "neon", "glass", "brick"]
FOV_TAN = math.tan(math.radians(16))
SPACING = 1.4


def load(name):
    return np.asarray(Image.open(FOLDER / name).convert("RGB")).astype(float)


def project(point, eye, size=1080):
    scale = (size / 2) / FOV_TAN
    depth = eye[2] - point[2]
    return size / 2 + (point[0] - eye[0]) / depth * scale, size / 2 - (point[1] - eye[1]) / depth * scale


def front_box(center, side, eye, inset=0.0, bevel=0.0):
    half = side / 2 * (1 - inset)
    front_z = center[2] + side / 2 - bevel * side
    x0, y0 = project((center[0] - half, center[1] + half, front_z), eye)
    x1, y1 = project((center[0] + half, center[1] - half, front_z), eye)
    return int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))


def silhouette_box(center, side, eye):
    corners = [(center[0] + sx * side / 2, center[1] + sy * side / 2, center[2] + sz * side / 2)
               for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    points = [project(corner, eye) for corner in corners]
    xs, ys = zip(*points)
    return int(math.floor(min(xs))), int(math.floor(min(ys))), int(math.ceil(max(xs))), int(math.ceil(max(ys)))


def mean_rgb(image, box):
    x0, y0, x1, y1 = box
    return image[y0:y1, x0:x1].reshape(-1, 3).mean(axis=0)


def srgb_to_lab(rgb):
    channels = np.asarray(rgb, dtype=float) / 255
    channels = np.where(channels <= 0.04045, channels / 12.92, ((channels + 0.055) / 1.055) ** 2.4)
    matrix = np.array([[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.0721750],
                       [0.0193339, 0.1191920, 0.9503041]])
    x, y, z = matrix @ channels / np.array([0.95047, 1.0, 1.08883])

    def lab_curve(t):
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116
    return 116 * lab_curve(y) - 16, 500 * (lab_curve(x) - lab_curve(y)), 200 * (lab_curve(y) - lab_curve(z))


def delta_e2000(rgb_a, rgb_b):
    l1, a1, b1 = srgb_to_lab(rgb_a)
    l2, a2, b2 = srgb_to_lab(rgb_b)
    c1, c2 = math.hypot(a1, b1), math.hypot(a2, b2)
    c_bar7 = ((c1 + c2) / 2) ** 7
    g = 0.5 * (1 - math.sqrt(c_bar7 / (c_bar7 + 25 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360
    h2p = math.degrees(math.atan2(b2, a2p)) % 360
    dl, dc = l2 - l1, c2p - c1p
    if c1p * c2p == 0:
        dh = 0
    else:
        dh = h2p - h1p
        dh = dh - 360 if dh > 180 else dh + 360 if dh < -180 else dh
    dhp = 2 * math.sqrt(c1p * c2p) * math.sin(math.radians(dh) / 2)
    l_bar, c_bar = (l1 + l2) / 2, (c1p + c2p) / 2
    if c1p * c2p == 0:
        h_bar = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        h_bar = (h1p + h2p) / 2
    else:
        h_bar = (h1p + h2p + 360) / 2 if h1p + h2p < 360 else (h1p + h2p - 360) / 2
    t = (1 - 0.17 * math.cos(math.radians(h_bar - 30)) + 0.24 * math.cos(math.radians(2 * h_bar))
         + 0.32 * math.cos(math.radians(3 * h_bar + 6)) - 0.20 * math.cos(math.radians(4 * h_bar - 63)))
    d_theta = 30 * math.exp(-(((h_bar - 275) / 25) ** 2))
    rc = 2 * math.sqrt(c_bar ** 7 / (c_bar ** 7 + 25 ** 7))
    sl = 1 + 0.015 * (l_bar - 50) ** 2 / math.sqrt(20 + (l_bar - 50) ** 2)
    sc, sh = 1 + 0.045 * c_bar, 1 + 0.015 * c_bar * t
    rt = -math.sin(math.radians(2 * d_theta)) * rc
    term_l, term_c, term_h = dl / sl, dc / sc, dhp / sh
    return math.sqrt(term_l ** 2 + term_c ** 2 + term_h ** 2 + rt * term_c * term_h)


def luma(image):
    return image @ np.array([0.2126, 0.7152, 0.0722])


results = {}
EYE_ROW = (0, 1.2, 16)


def row_center(index):
    return ((index - 2.5) * SPACING, 1.2, 0)


# Check 1: front-face mean colour against the path-traced reference, 18 cubes.
worst = {}
detail = []
for colour_set in ("red", "blue", "default"):
    rt, pt = load(f"row-{colour_set}.png"), load(f"row-{colour_set}-pt.png")
    for index, name in enumerate(NAMES):
        box = front_box(row_center(index), 1.2, EYE_ROW, inset=0.5)
        value = delta_e2000(mean_rgb(rt, box), mean_rgb(pt, box))
        detail.append((colour_set, name, round(value, 1)))
        worst[name] = max(worst.get(name, 0), value)
results["1 reference dE2000 (max per preset, limit 12)"] = {name: round(value, 1) for name, value in worst.items()}
results["1 detail"] = detail

# Check 3 and 4: glass over grey.
EYE_GLASS = (0, 1.2, 8.5)
glass = load("glass-grey.png")
luma_glass = luma(glass)
backdrop_luma = luma_glass[40:140, 40:1040].mean()
x0, y0, x1, y1 = front_box((1.6, 1.2, 0), 1.3, EYE_GLASS, bevel=0.2)
band = 7
sides = {
    "left": luma_glass[y0 + 20:y1 - 20, x0 + 3:x0 + 3 + band], "right": luma_glass[y0 + 20:y1 - 20, x1 - 3 - band:x1 - 3],
    "top": luma_glass[y0 + 3:y0 + 3 + band, x0 + 20:x1 - 20], "bottom": luma_glass[y1 - 3 - band:y1 - 3, x0 + 20:x1 - 20],
}
contrast = {side: round(abs(float(region.mean()) - backdrop_luma), 1) for side, region in sides.items()}
results["3 clear glass rim luma contrast (limit 25; backdrop %.0f)" % backdrop_luma] = contrast
hues = {}
for label, index, target in (("red", 0, 0), ("blue", 1, 220)):
    box = front_box(((index - 1) * 1.6, 1.2, 0), 1.3, EYE_GLASS, inset=0.5)
    r, g, b = mean_rgb(glass, box) / 255
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    hues[label] = {"hue": round(h * 360), "target": target, "sat": round(s, 2)}
results["4 coloured glass (sat limit 0.30, hue within 25 of target)"] = hues


# Check 5: grass repeat: best normalized autocorrelation of the high-passed face at lags of 0.25 to 0.9 face widths.
def repeat_score(image_luma, box):
    x0, y0, x1, y1 = box
    face = image_luma[y0:y1, x0:x1]
    size = min(face.shape)
    face = face[:size, :size]
    width = max(3, size // 8)
    kernel = np.ones(width) / width
    blurred = np.apply_along_axis(lambda row: np.convolve(row, kernel, mode="same"), 1, face)
    blurred = np.apply_along_axis(lambda column: np.convolve(column, kernel, mode="same"), 0, blurred)
    detail = (face - blurred)[size // 10:-size // 10, size // 10:-size // 10]
    n = detail.shape[0]
    best, best_lag = 0.0, None
    for dy in range(0, n - n // 4):
        for dx in range(-(n - n // 4), n - n // 4):
            lag = math.hypot(dx, dy)
            if not (0.25 * size <= lag <= 0.9 * size) or (dy == 0 and dx < 0):
                continue
            a = detail[dy:, max(dx, 0):n + min(dx, 0)]
            b = detail[:n - dy, max(-dx, 0):n + min(-dx, 0)]
            if a.size < 0.3 * n * n:
                continue
            value = float((a * b).sum() / math.sqrt((a * a).sum() * (b * b).sum()))
            if value > best:
                best, best_lag = value, (dx, dy)
    return round(best, 2), best_lag


scores = {}
for colour_set in ("red", "blue", "default"):
    rt = load(f"row-{colour_set}.png")
    scores[colour_set + " row"] = repeat_score(luma(rt), front_box(row_center(2), 1.2, EYE_ROW, inset=0.08))
if (FOLDER / "grass-face.png").exists():
    scores["close"] = repeat_score(luma(load("grass-face.png")), front_box((0, 1.2, 0), 1.2, (0, 1.2, 4.5), inset=0.05))
results["5 grass repeat (autocorrelation, repeat if above 0.5)"] = scores

# Check 6: neon ring 7 to 9 px outside the silhouette, bloom on minus off.
ring = {}
for colour_set in ("red", "blue", "default"):
    on, off = luma(load(f"row-{colour_set}.png")), luma(load(f"row-{colour_set}-nobloom.png"))
    x0, y0, x1, y1 = silhouette_box(row_center(3), 1.2, EYE_ROW)
    span_x = slice(x0 + (x1 - x0) // 5, x1 - (x1 - x0) // 5)
    span_y = slice(y0 + (y1 - y0) // 5, y1 - (y1 - y0) // 5)
    samples = [on[y0 - 9:y0 - 7, span_x] - off[y0 - 9:y0 - 7, span_x], on[y1 + 7:y1 + 9, span_x] - off[y1 + 7:y1 + 9, span_x],
               on[span_y, x0 - 9:x0 - 7] - off[span_y, x0 - 9:x0 - 7], on[span_y, x1 + 7:x1 + 9] - off[span_y, x1 + 7:x1 + 9]]
    ring[colour_set] = [round(float(sample.mean()), 1) for sample in samples]
results["6 neon ring rise top/bottom/left/right (limit 30)"] = ring


# Check 7: largest step of a 3-px smoothed luma profile across the front face (rows and columns averaged over the middle 60 percent).
def seam_step(image_luma, box):
    x0, y0, x1, y1 = box
    face = image_luma[y0:y1, x0:x1]
    h, w = face.shape
    columns = face[int(h * 0.2):int(h * 0.8)].mean(axis=0)
    rows = face[:, int(w * 0.2):int(w * 0.8)].mean(axis=1)

    def smooth(profile):
        return np.convolve(profile, np.ones(3) / 3, mode="valid")
    return max(abs(np.diff(smooth(columns))).max(), abs(np.diff(smooth(rows))).max())


seams = {}
for colour_set in ("red", "blue", "default"):
    rt = luma(load(f"row-{colour_set}.png"))
    for index, name in enumerate(NAMES):
        if name == "glass":
            continue
        box = front_box(row_center(index), 1.2, EYE_ROW)
        seams[f"{colour_set}/{name}"] = round(float(seam_step(rt, (box[0] + 8, box[1] + 8, box[2] - 8, box[3] - 8))), 1)
results["7 max profile step (limit 20)"] = seams

for key, value in results.items():
    print(key, json.dumps(value, default=str))
