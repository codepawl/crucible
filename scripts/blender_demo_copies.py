"""Array maths for writing many copies of one mesh into a single mesh, without Blender (#2766).

scripts/blender-demo-to-glb.py realizes 86,000 grass and bush instances. Writing each as its own Blender object took 518 s;
the copies of one source mesh are instead placed here with numpy and written to one mesh in a few array calls.
"""
import numpy


def place_copies(positions, matrices):
    """Vertex positions of every copy: an array of shape (copies, vertices, 3), copy n moved by matrices[n] (4 by 4)."""
    positions = numpy.asarray(positions, dtype=numpy.float32).reshape(-1, 3)
    matrices = numpy.asarray(matrices, dtype=numpy.float32).reshape(-1, 4, 4)
    return numpy.einsum("vj,nij->nvi", positions, matrices[:, :3, :3]) + matrices[:, None, :3, 3]


def mirrored_copy_count(matrices):
    """How many matrices flip handedness (negative determinant), so their faces would wind inside out."""
    matrices = numpy.asarray(matrices, dtype=numpy.float32).reshape(-1, 4, 4)
    return int((numpy.linalg.det(matrices[:, :3, :3]) < 0).sum())


def repeat_with_offset(indices, copy_count, stride):
    """An index array repeated once per copy, copy n's indices raised by n * stride, flattened."""
    offsets = numpy.arange(copy_count, dtype=numpy.int32)[:, None] * stride
    return (numpy.asarray(indices, dtype=numpy.int32)[None, :] + offsets).reshape(-1)
