import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

import numpy

import blender_demo_copies as copies


def translation(x, y, z):
    matrix = numpy.eye(4, dtype=numpy.float32)
    matrix[:3, 3] = (x, y, z)
    return matrix


def scale(x, y, z):
    return numpy.diag([x, y, z, 1.0]).astype(numpy.float32)


class PlaceCopiesTest(unittest.TestCase):
    def test_every_copy_is_moved_by_its_own_matrix(self):
        triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
        placed = copies.place_copies(triangle, [translation(10, 0, 0), scale(2, 2, 2) @ translation(0, 0, 5)])
        self.assertEqual(placed.shape, (2, 3, 3))
        self.assertEqual(placed[0].tolist(), [[10, 0, 0], [11, 0, 0], [10, 1, 0]])
        self.assertEqual(placed[1].tolist(), [[0, 0, 10], [2, 0, 10], [0, 2, 10]])

    def test_a_flipped_matrix_is_counted_as_mirrored(self):
        self.assertEqual(copies.mirrored_copy_count([translation(1, 0, 0), scale(-1, 1, 1), scale(1, -1, -1)]), 1)


class RepeatWithOffsetTest(unittest.TestCase):
    def test_copy_n_is_raised_by_n_strides(self):
        repeated = copies.repeat_with_offset([0, 1, 2], 3, 4)
        self.assertEqual(repeated.tolist(), [0, 1, 2, 4, 5, 6, 8, 9, 10])
        self.assertEqual(repeated.dtype, numpy.int32)



class FitIslandIntoRegionTest(unittest.TestCase):
    def test_the_island_lands_inside_its_region_without_the_gutter_and_keeps_its_shape(self):
        island = [[0.2, 0.2], [0.4, 0.2], [0.4, 0.3]]
        placed = copies.fit_island_into_region(island, (100, 50, 40), 400, 4)
        pixels = placed * 400
        self.assertGreaterEqual(pixels[:, 0].min(), 104 - 1e-3)
        self.assertLessEqual(pixels[:, 0].max(), 136 + 1e-3)
        self.assertGreaterEqual(pixels[:, 1].min(), 54 - 1e-3)
        self.assertLessEqual(pixels[:, 1].max(), 86 + 1e-3)
        self.assertAlmostEqual(float((pixels[1, 0] - pixels[0, 0]) / (pixels[2, 1] - pixels[1, 1])), 2.0, places=4)

    def test_a_single_point_still_lands_in_the_region(self):
        placed = copies.fit_island_into_region([[0.5, 0.5]], (0, 0, 16), 64, 4) * 64
        self.assertEqual(placed.tolist(), [[4.0, 4.0]])


if __name__ == "__main__":
    unittest.main()
