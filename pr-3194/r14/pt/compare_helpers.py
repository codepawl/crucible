"""uv run --no-project --with numpy --with pillow python compare.py <glaze-folder>
Glaze (raster, 8-bit display) against the CPU path tracer (tone mapped the same way) at 480x270, over the same ground pixels.
Masks come from the JS noise port of the shader: puddle interior = basin depth above 0.03, road = depth below -0.12.
Ground pixels are the ones whose path tracer depth equals the ground plane distance (no pole, wall or tree in front)."""
import json
import os
import sys
import numpy as np
from PIL import Image
from basin_port import basin

GLAZE = "diag"
LEVEL = 0.678
W, H = 480, 270
CENTRE = (-8.9, -21.7)
VIEWS = {
    'hero-clouds': ('hero-clouds-wet1', {'eye': [CENTRE[0], 1.6, CENTRE[1] + 3.2], 'target': [CENTRE[0], 0, CENTRE[1]], 'fov': 40}),
    'hero-tree': ('hero-tree-wet1', {'eye': [CENTRE[0], 1.6, CENTRE[1] + 3.2], 'target': [CENTRE[0], 0.4, CENTRE[1]], 'fov': 40}),
    'hero-sky': ('hero-sky-wet1', {'eye': [CENTRE[0], 1.6, CENTRE[1] + 3.2], 'target': [CENTRE[0], 1.6 + 3.2 * np.tan(np.radians(15)), CENTRE[1]], 'fov': 40}),
}


def to_linear(srgb):
    return np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)


def luminance(srgb):
    return to_linear(srgb) @ np.array([0.2126, 0.7152, 0.0722])


def glaze_image(name):
    image = Image.open(f'{GLAZE}/{name}.png').convert('RGB').resize((W, H), Image.BOX)
    return np.asarray(image, float) / 255


def pt_image(name):
    raw = np.fromfile(f'pt/{name}.rgba', dtype=np.uint8).reshape(H, W, 4)[..., :3]
    return raw.astype(float) / 255


def rays(camera):
    eye, target = np.array(camera['eye'], float), np.array(camera['target'], float)
    forward = target - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0, 1, 0])
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    half = np.tan(np.radians(camera['fov']) / 2)
    px, py = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    ndc_x, ndc_y = px / W * 2 - 1, 1 - py / H * 2
    return eye, forward + right * ndc_x[..., None] * half * W / H + up * ndc_y[..., None] * half


def masks(view, camera):
    eye, directions = rays(camera)
    valid = directions[..., 1] < -1e-4
    t = np.where(valid, -eye[1] / np.where(valid, directions[..., 1], -1), np.nan)
    x, z = eye[0] + directions[..., 0] * t, eye[2] + directions[..., 2] * t
    depth = basin(np.nan_to_num(x), np.nan_to_num(z)) - LEVEL
    pt_depth = np.fromfile(f'pt/{view}-road.depth.f32', dtype=np.float32).reshape(H, W)
    ground = valid & (np.abs(pt_depth - t) < 0.02 * t)
    # Skip a ring of pixels at the shore and the far road beyond 12 m, where pixels are wider than the road detail.
    near = ground & (t < 12)
    return near & (depth > 0.03), near & (depth < -0.12), ground
