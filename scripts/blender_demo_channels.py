"""Which Principled BSDF channels of a Blender material the glTF exporter can write, without Blender (#2766).

The exporter writes an image texture wired straight into a Principled input, read through the first UV layer, optionally
through one Mapping node whose values are fixed. It drops everything else: a texture whose coordinates come from Object or
Generated space, a Box projection, a Mix between two UV mappings, a noise-driven colour. scripts/blender-demo-to-glb.py
bakes the channels classified "warped" or "procedural" here, and prints one status per material.

A graph is a dict of node name to {"type", "projection", "inputs"}. "inputs" maps a socket name to the list of
(upstream node name, upstream socket name) links wired into it, so this module reads the same shape in a unit test
as the adapter in the Blender script builds from a real node tree.
"""

import math

PLAIN = "plain"
WARPED = "warped"
PROCEDURAL = "procedural"
UNLINKED = "unlinked"

CHANNEL_SOCKETS = ("Base Color", "Roughness", "Normal")

FIXED_MAPPING_SOCKETS = ("Location", "Rotation", "Scale")


def upstream_links(graph, node_name, socket_name=None):
    node = graph[node_name]
    if socket_name is not None:
        return list(node["inputs"].get(socket_name, []))
    return [link for links in node["inputs"].values() for link in links]


def coordinate_is_plain(graph, link):
    """True when the vector reaching an image is the first UV layer, directly or through one mapping with fixed values."""
    node_name, socket_name = link
    node = graph[node_name]
    if node["type"] == "TEX_COORD":
        return socket_name == "UV"
    if node["type"] == "UVMAP":
        return True
    if node["type"] == "REROUTE":
        vector_links = node["inputs"].get("Input", [])
        return len(vector_links) == 1 and coordinate_is_plain(graph, vector_links[0])
    if node["type"] == "MAPPING":
        if any(node["inputs"].get(name) for name in FIXED_MAPPING_SOCKETS):
            return False
        vector_links = node["inputs"].get("Vector", [])
        return len(vector_links) == 1 and coordinate_is_plain(graph, vector_links[0])
    return False


def image_is_plain(graph, image_name):
    node = graph[image_name]
    if node.get("projection", "FLAT") != "FLAT":
        return False
    vector_links = node["inputs"].get("Vector", [])
    return not vector_links or (len(vector_links) == 1 and coordinate_is_plain(graph, vector_links[0]))


def reachable_nodes(graph, start_links):
    """Every node name upstream of the given links, nearest first, each once."""
    order = []
    pending = [name for name, _ in start_links]
    seen = set()
    while pending:
        name = pending.pop(0)
        if name in seen:
            continue
        seen.add(name)
        order.append(name)
        pending.extend(upstream for upstream, _ in upstream_links(graph, name))
    return order


def classify_channel(graph, principled_name, socket_name):
    """unlinked, plain (the exporter writes it), warped (an image with coordinates it drops) or procedural (no image)."""
    start_links = upstream_links(graph, principled_name, socket_name)
    if not start_links:
        return UNLINKED
    images = [name for name in reachable_nodes(graph, start_links) if graph[name]["type"] == "TEX_IMAGE"]
    if not images:
        return PROCEDURAL
    for image_name in images:
        if not image_is_plain(graph, image_name):
            return WARPED
    return PLAIN


def classify_material(graph, principled_name):
    """Per channel classification of a material's Base Color, Roughness and Normal."""
    return {socket_name: classify_channel(graph, principled_name, socket_name) for socket_name in CHANNEL_SOCKETS}


def channels_to_bake(channels):
    """The channels that need a bake: warped images always, and a procedural colour (the vertex-colour bake owns those)."""
    return [socket_name for socket_name, kind in channels.items() if kind == WARPED]


def baked_texture_size(surface_area, texels_per_metre, minimum_size, maximum_size):
    """A power of two that gives the surface about texels_per_metre across, held between the two limits."""
    wanted = max(1.0, (surface_area ** 0.5) * texels_per_metre)
    size = minimum_size
    while size < wanted and size < maximum_size:
        size *= 2
    return min(size, maximum_size)


def power_of_two_sizes(minimum_size, maximum_size):
    size = minimum_size
    while size < maximum_size:
        yield size
        size *= 2
    yield maximum_size


def shelf_pack(sides, atlas_size):
    """Places squares left to right in rows, tallest first. Returns the (x, y) of each square in the order given, or None."""
    placements = [None] * len(sides)
    cursor_x = 0
    cursor_y = 0
    row_height = 0
    for index in sorted(range(len(sides)), key=lambda position: -sides[position]):
        side = sides[index]
        if side > atlas_size:
            return None
        if cursor_x + side > atlas_size:
            cursor_x = 0
            cursor_y += row_height
            row_height = 0
        if cursor_y + side > atlas_size:
            return None
        placements[index] = (cursor_x, cursor_y)
        cursor_x += side
        row_height = max(row_height, side)
    return placements


def plan_atlas(areas, texels_per_metre, gutter, minimum_size, maximum_size, minimum_side=16):
    """One shared bake image for every object that uses a material (#2766).

    areas is the surface area in square metres each object has in the material. Each object gets a square region sized to
    about texels_per_metre across its surface, plus a gutter of empty texels on every side, and the regions are packed into
    the smallest power-of-two square between minimum_size and maximum_size. When they do not fit at maximum_size the texel
    density drops by a tenth until they do. Returns {"size", "texels_per_metre", "regions"}, regions being one
    (x, y, side) per area, side including both gutters.
    """
    if not areas:
        raise ValueError("plan_atlas needs at least one surface area; pass the areas of the objects that use the material.")
    density = float(texels_per_metre)
    while density > 0.5:
        sides = [max(minimum_side, math.ceil((area ** 0.5) * density)) + 2 * gutter for area in areas]
        for size in power_of_two_sizes(minimum_size, maximum_size):
            placements = shelf_pack(sides, size)
            if placements is not None:
                return {"size": size, "texels_per_metre": density,
                        "regions": [(x, y, side) for (x, y), side in zip(placements, sides)]}
        density *= 0.9
    raise ValueError(f"{len(areas)} objects do not fit a {maximum_size} px atlas even at 0.5 texels per metre; raise DEMO_BAKE_MAX_SIZE.")
