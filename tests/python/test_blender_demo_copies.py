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


if __name__ == "__main__":
    unittest.main()
