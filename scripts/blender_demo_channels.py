"""Which Principled BSDF channels of a Blender material the glTF exporter can write, without Blender (#2766).

The exporter writes an image texture wired straight into a Principled input, read through the first UV layer, optionally
through one Mapping node whose values are fixed. It drops everything else: a texture whose coordinates come from Object or
Generated space, a Box projection, a Mix between two UV mappings, a noise-driven colour. scripts/blender-demo-to-glb.py
bakes the channels classified "warped" or "procedural" here, and prints one status per material.

A graph is a dict of node name to {"type", "projection", "inputs"}. "inputs" maps a socket name to the list of
(upstream node name, upstream socket name) links wired into it, so this module reads the same shape in a unit test
as the adapter in the Blender script builds from a real node tree.
"""

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
