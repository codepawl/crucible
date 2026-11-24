import numpy as np
def cell_hash(cx, cy, cz):
    lx = (np.floor(cx).astype(np.int64) + 32768).astype(np.uint32)
    ly = (np.floor(cy).astype(np.int64) + 32768).astype(np.uint32)
    lz = (np.floor(cz).astype(np.int64) + 32768).astype(np.uint32)
    bits = (lx * np.uint32(1597334673)) ^ (ly * np.uint32(3812015801)) ^ (lz * np.uint32(2798796415))
    bits = (bits ^ (bits >> np.uint32(16))) * np.uint32(2246822519)
    bits = (bits ^ (bits >> np.uint32(13))) * np.uint32(3266489917)
    bits = bits ^ (bits >> np.uint32(16))
    return (bits >> np.uint32(8)).astype(np.float64) / 16777215.0


def noise(x, y, z):
    cx, cy, cz = np.floor(x), np.floor(y), np.floor(z)
    bx, by, bz = x - cx, y - cy, z - cz
    bx, by, bz = [b * b * (3 - 2 * b) for b in (bx, by, bz)]

    def plane(oz):
        low = cell_hash(cx, cy, cz + oz) * (1 - bx) + cell_hash(cx + 1, cy, cz + oz) * bx
        high = cell_hash(cx, cy + 1, cz + oz) * (1 - bx) + cell_hash(cx + 1, cy + 1, cz + oz) * bx
        return low * (1 - by) + high * by
    return plane(0) * (1 - bz) + plane(1) * bz


def basin(x, z):
    wx = noise(x * 1.1, np.full_like(x, 9.3), z * 1.1) - 0.5
    wz = noise(x * 1.1 + 31, np.full_like(x, 2.7), z * 1.1) - 0.5
    px, pz = (x + 0.9 * wx) * 0.55, (z + 0.9 * wz) * 0.55
    broad = 0.8 * noise(px, np.full_like(x, 3.7), pz) + 0.2 * noise(px * 2.3 + 17, np.full_like(x, 3.7 * 2.3 + 17), pz * 2.3 + 17)
    fine = noise(x * 6, np.full_like(x, 1.9), z * 6) - 0.5
    return broad + 0.1 * fine


