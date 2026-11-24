"""Measures the evidence stills of PR #3254 (lights on parts).

Usage: uv run --no-project --with pillow --with numpy --with scipy python -I r13-measure.py <folder> <parameters json file>

The folder holds the lit stills (r13-cart-0/1/2, r13-wall-on), the lights-off stills (cart-off-0/1/2, wall-off), the one-light-at-a-time
stills at 1 s (cart-warm-1, cart-blue-1) and the solid masks (cart-mask-0/1/2, wall-mask: every part but the floor drawn white).
"""
import json
import sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
folder, parameters = sys.argv[1], json.load(open(sys.argv[2], encoding="utf-8"))
prefix = "r13-"
POOL_THRESHOLD = 12
WIDTH, HEIGHT = 1080, 1920


def load(name):
    return np.asarray(Image.open(f"{folder}/{prefix}{name}").convert("RGB")).astype(float)


def luma_of(pixels):
    return 0.2126 * pixels[..., 0] + 0.7152 * pixels[..., 1] + 0.0722 * pixels[..., 2]


def box_of(mask):
    rows, columns = np.where(mask)
    return columns.min(), rows.min(), columns.max(), rows.max()


def solids_of(mask_name):
    return ndimage.binary_dilation(luma_of(load(mask_name)) > 200, iterations=3)


def light_difference(lit_name, off_name):
    return np.abs(load(lit_name) - load(off_name)).max(axis=2)


def cart_report():
    warm = (light_difference("cart-warm-1.png", "cart-off-1.png") > POOL_THRESHOLD) & ~solids_of("cart-mask-1.png")
    blue = (light_difference("cart-blue-1.png", "cart-off-1.png") > POOL_THRESHOLD) & ~solids_of("cart-mask-1.png")
    warm_box, blue_box = box_of(warm), box_of(blue)
    union = (min(warm_box[0], blue_box[0]), min(warm_box[1], blue_box[1]), max(warm_box[2], blue_box[2]), max(warm_box[3], blue_box[3]))
    union_width, union_height = union[2] - union[0] + 1, union[3] - union[1] + 1
    gap = ndimage.distance_transform_edt(~warm)[blue].min()
    centroid_distance = np.linalg.norm(np.array(ndimage.center_of_mass(warm)) - np.array(ndimage.center_of_mass(blue)))
    print(f"CART pools: |lit - lights off| above {POOL_THRESHOLD} on any channel, one light on at a time, parts removed (frame at 1 s)")
    print(f"  warm {warm.sum()} px, blue {blue.sum()} px, blue/warm {blue.sum() / warm.sum():.2f}; edge to edge {gap:.0f} px; centroid to centroid {centroid_distance:.0f} px")
    print(f"  union box {union_width} x {union_height} px = {union_width * union_height / (WIDTH * HEIGHT):.1%} of the frame, {union_width / WIDTH:.0%} of its width")
    print("CART margins: same threshold, both lights on, lights-off still of the same time as the base, parts removed")
    for frame in (0, 1, 2):
        mask = (light_difference(f"cart-{frame}.png", f"cart-off-{frame}.png") > POOL_THRESHOLD) & ~solids_of(f"cart-mask-{frame}.png")
        box = box_of(mask)
        print(f"  frame {frame}: left {box[0]}, right {WIDTH - 1 - box[2]}, top {box[1]}, bottom {HEIGHT - 1 - box[3]}")
    for frame in (0, 1, 2):
        print(f"  cart-{frame}: pixels with a channel at 255: {int((load(f'cart-{frame}.png') >= 255).any(axis=2).sum())}")
    for frame in (0, 1, 2):
        silhouette = luma_of(load(f"cart-mask-{frame}.png")) > 200
        cart_pixels = load(f"cart-{frame}.png")[silhouette]
        print(f"  cart-{frame} silhouette (mask above 200, {int(silhouette.sum())} px): brightest channel {int(cart_pixels.max())}; pixels with a channel above 245: {int((cart_pixels > 245).any(axis=1).sum())} (the emissive bulb and the lit left end edge); 99.9th percentile of the brightest channel {np.percentile(cart_pixels.max(axis=1), 99.9):.0f}")
    solid_mask = luma_of(load("cart-mask-1.png")) > 200
    solid_box = box_of(solid_mask)
    centre = (solid_box[0] + solid_box[2]) // 2
    bottom = np.where(solid_mask[:, centre])[0].max()
    luma = luma_of(load("cart-1.png"))
    rows_below = [luma[bottom + offset, centre - 30:centre + 30].mean() for offset in range(1, 6)]
    floor_side = luma[bottom + 51:bottom + 56, centre - 30:centre + 30].mean()
    print("CART contact shadow (cart-1): mean over the 60 columns around the cart centre, rows 1 to 5 below the last row of the cart silhouette (mask above 200)")
    print(f"  rows below: {[round(value) for value in rows_below]}; darkest row {min(rows_below):.0f}; floor rows 51 to 55 below {floor_side:.0f}; difference {floor_side - min(rows_below):.0f}")
    inside = [luma[bottom - offset, centre - 30:centre + 30].mean() for offset in range(0, 5)]
    print(f"  last 5 rows of the cart itself (its dark lower face): {[round(value) for value in inside]}")


def project_factory(camera):
    eye = np.array(camera["eye"], float)
    forward = np.array(camera["target"], float) - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    focal = 0.5 * HEIGHT / np.tan(np.radians(camera["fov"]) / 2)

    def project(point):
        relative = np.array(point, float) - eye
        depth = relative @ forward
        return (WIDTH / 2 + focal * (relative @ right) / depth, HEIGHT / 2 - focal * (relative @ up) / depth)

    return project


def crossing(profile, start, step, level):
    index = start
    while 0 <= index + step < len(profile) and profile[index] > level:
        index += step
    return index


def wall_report():
    project = project_factory(parameters["wallCamera"])
    wall_width, wall_height = parameters["wallWidth"], parameters["wallHeight"]
    fixture_x, fixture_y = parameters["fixtureX"], parameters["fixtureY"]
    on, off = load("wall-on.png"), load("wall-off.png")
    luma_on, luma_off = luma_of(on), luma_of(off)
    housing_rows, housing_columns = np.where(luma_of(load("wall-mask.png")) > 250)
    housing = (housing_columns.min(), housing_rows.min(), housing_columns.max(), housing_rows.max())
    blocked = np.zeros((HEIGHT, WIDTH), bool)
    blocked[housing[1] - 8:housing[3] + 9, housing[0] - 8:housing[2] + 9] = True
    rise_full = np.clip(luma_on - luma_off, 0, None)
    rise_full[blocked] = 0
    centroid = ((rise_full * np.arange(WIDTH)[None, :]).sum() / rise_full.sum(), (rise_full * np.arange(HEIGHT)[:, None]).sum() / rise_full.sum())
    hit = project((-4.2, fixture_y, 0))
    face = project((fixture_x - 0.15, fixture_y, 0))
    hit_column, hit_row = int(round(hit[0])), int(round(hit[1]))
    window = (slice(hit_row - 3, hit_row + 4), slice(hit_column - 3, hit_column + 4))
    peak_rise = (luma_on - luma_off)[window].max()
    print("WALL patch: rise = on luma minus off luma (negative values clipped), the fixture box plus 8 px removed")
    print(f"  intensity-weighted centroid over the whole frame ({centroid[0]:.0f}, {centroid[1]:.0f}); the face normal meets the wall at ({hit[0]:.0f}, {hit[1]:.0f}); offset ({centroid[0] - hit[0]:+.0f}, {centroid[1] - hit[1]:+.0f}) px; face centre projects to ({face[0]:.0f}, {face[1]:.0f})")
    print(f"  peak rise within 3 px of the normal's hit point {peak_rise:.0f} levels; on luma there {luma_on[window].max():.0f}; off luma there {luma_off[window].max():.0f}; brightest pixel anywhere {luma_on.max():.0f} (the lit fixture)")
    print(f"  channels at 255: {int((on >= 255).any(axis=2).sum())} in wall-on, {int((off >= 255).any(axis=2).sum())} in wall-off")

    def filled(profile, blocked_profile):
        return np.interp(np.arange(len(profile)), np.where(~blocked_profile)[0], profile[~blocked_profile])

    row = filled(rise_full[hit_row, :], blocked[hit_row, :])
    column = filled(rise_full[:, hit_column], blocked[:, hit_column])
    widths = {}
    ends = {}
    for label, profile, start, step in (("left", row, hit_column, -1), ("right", row, hit_column, 1), ("up", column, hit_row, -1), ("down", column, hit_row, 1)):
        high = crossing(profile, start, step, 0.9 * peak_rise)
        low = crossing(profile, high, step, 0.1 * peak_rise)
        widths[label] = abs(low - high)
        ends[label] = low
    print(f"  falloff 90% to 10% of the peak rise along the row and column through the hit point: {widths}; left/right {max(widths['left'], widths['right']) / min(widths['left'], widths['right']):.2f}")
    patch = rise_full > 0.05 * peak_rise
    patch_box = box_of(patch)
    union = (min(housing[0], patch_box[0]), min(housing[1], patch_box[1]), max(housing[2], patch_box[2]), max(housing[3], patch_box[3]))
    print(f"  union of the patch (rise above 5% of the peak) and the fixture: x {union[0] / WIDTH:.1%} to {union[2] / WIDTH:.1%}, y {union[1] / HEIGHT:.1%} to {union[3] / HEIGHT:.1%}")
    dark = luma_off < 70
    dark_rows, dark_columns = np.where(dark[:HEIGHT * 3 // 4])
    print(f"WALL panel in pixels (wall-off still, pixels darker than 70 above the lower quarter): left {dark_columns.min()}, right {WIDTH - 1 - dark_columns.max()}, top {dark_rows.min()}")
    wall_top_at_column = np.where(luma_off[:, hit_column] < 70)[0].min()
    print(f"  wall top edge in the hit point's column: row {wall_top_at_column}; the patch's 10% level ends at row {ends['up']}, so {ends['up'] - wall_top_at_column} px below the top edge")
    corners = [project((x, y, z)) for x in (-4.4, -4.2) for y in (0, wall_height) for z in (-wall_width / 2, wall_width / 2)]
    print(f"  projected corner margins: left {min(corner[0] for corner in corners):.0f}, right {WIDTH - max(corner[0] for corner in corners):.0f}, top {min(corner[1] for corner in corners):.0f}, bottom {HEIGHT - max(corner[1] for corner in corners):.0f}")
    def floor_mean(point):
        column_at, row_at = project(point)
        column_at, row_at = int(round(column_at)), int(round(row_at))
        return luma_off[row_at - 2:row_at + 3, column_at - 2:column_at + 3].mean(), column_at, row_at

    print("WALL contact shadows (wall-off still): mean luma of a 5 x 5 px window centred on a floor point, projected from world metres")
    wall_front = -4.2
    for side, z in (("wall base, z -2.5", -2.5), ("wall base, z +2.5", 2.5)):
        near, near_column, near_row = floor_mean((wall_front + 0.15, 0, z))
        far, far_column, far_row = floor_mean((wall_front + 2.5, 0, z))
        print(f"  {side}: 0.15 m in front of the wall at ({near_column}, {near_row}) reads {near:.0f}; 2.5 m in front at ({far_column}, {far_row}) reads {far:.0f}; difference {near - far:+.0f}")
    base_half = 0.3
    for label, point in (("0.1 m beyond the plate's +x edge, z 0", (fixture_x + base_half + 0.1, 0, 0)), ("0.1 m beyond the plate's +z edge, x of the stand", (fixture_x, 0, base_half + 0.1)), ("0.1 m beyond the plate's -x edge, z 0 (key light side)", (fixture_x - base_half - 0.1, 0, 0))):
        near, near_column, near_row = floor_mean(point)
        far, far_column, far_row = floor_mean((fixture_x, 0, 3.0))
        print(f"  stand base, {label}: ({near_column}, {near_row}) reads {near:.0f}; open floor at z 3 m at ({far_column}, {far_row}) reads {far:.0f}; difference {near - far:+.0f}")
    base_corners = [project((fixture_x + dx, 0, dz)) for dx in (-base_half, base_half) for dz in (-base_half, base_half)]
    print(f"  stand base plate (projected corners) spans columns {min(corner[0] for corner in base_corners):.0f} to {max(corner[0] for corner in base_corners):.0f}, rows {min(corner[1] for corner in base_corners):.0f} to {max(corner[1] for corner in base_corners):.0f}")


cart_report()
wall_report()
