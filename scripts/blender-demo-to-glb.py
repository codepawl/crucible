"""Turns a Blender demo scene into a GLB that Crucible can load, for the README hero render (#1043).

Source: the Classroom demo scene by Christophe Seux (CC0), from the Blender demo files, https://download.blender.org/demo/test/classroom.zip
The .blend and the exported GLB stay out of git.

Run it in Blender 5.3 on a copy of the scene, with auto-run scripts off:

  blender -b classroom.blend --disable-autoexec --python scripts/blender-demo-to-glb.py -- <outputDirectory>

Then render the GLB with a scene.json (glb, hdri, eye [2.5764, 1.0945, 4.4658], target [0.9620, 1.1662, -1.7321], frame.fov 39.6, renderer.samples 8; the Blender camera in Y up):

  node scripts/render-media.mjs --kind image --scene file --config <outputDirectory>/scene.json --width 1600 --height 900 --output hero.png

The Lone Monk and Barbershop exports have flat Blender cameras; their eye and target are committed in bench/scene-frames/camera-overrides.json
and written into scene.json by `npm run bench:scene-frames -- <outputDirectory>` (#2158).

Old demo scenes shade with Cycles-only Diffuse, Glossy and Glass nodes, which the glTF exporter skips. This script puts a
Principled BSDF in their place first (preserving linked colour, roughness and normal subtrees, roughness, metal for
a lone Glossy, a soft alpha for Glass), so colours and textures survive. It is an approximation, not a Cycles match.

A base colour built from per-island or per-object nodes with no image texture or spatial procedural nodes upstream
(a ColorRamp on Random Per Island) is dropped by the exporter, which writes only image textures. Such colours are baked per
object to a face-corner colour attribute (Cycles, Diffuse colour only) and wired into the Base Color, so they reach the
GLB as COLOR_0 (#2766).

Materials whose Base Color, Roughness or Normal comes from anything other than a plain UV-mapped image texture (Mapping
nodes, Box projection, Object/Generated coordinates, Bump or procedural trees such as a wall stain) are baked to packed UV
images on a dedicated clean UV layer with texel density sized to the surface area and upstream maps, then rewired into
Principled BSDF before export (#2766). It prints one line per material: kept, approximated, graded or baked.

The exporter also skips hair particles that place objects or collections (the Lone Monk lawn and bushes). Their instances are
made real objects first and joined into one mesh per emitter after the bake (#2761); it prints PARTICLES and JOINED lines.

An image texture on plain UVs tinted on its way to the Base Color by constant nodes only (Hue Saturation Value, a Mix or
Multiply toward a flat colour) is graded instead: the tint is applied to a copy of the image in linear light, as Cycles
does, and that copy is wired in, so the texture keeps its full resolution (#2761). Baking those to vertex colours left
blotches on large plaster walls. Modifiers are applied before the bake so a subdivided wall gets its colour on the vertices
and UVs that are exported.

A world lit by an analytic sky (a Sky Texture node, as the Lone Monk has instead of lamps) is rendered to sky.hdr with its sun
at full strength, and world.json records the scene's view transform and exposure. scripts/blender-world-sky.mjs reads both into
scene.json: the HDRI replaces the airport sky, whose sun Crucible takes out as the shadowed key (#2761).
"""
import json
import math
import os
import sys

try:
    import bpy
except ImportError:
    bpy = None

try:
    import numpy
except ImportError:
    numpy = None

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BAKED_ATTRIBUTE = "baked_base_color"
BAKE_UV_NAME = "baked_uv"
SKY_BAKE_WIDTH = 2048
SKY_BAKE_HEIGHT = 1024
SUN_STRENGTH_BY_DEMO = {"classroom.blend": 40.0}

SPATIAL_NODE_TYPES = frozenset({
    "TEX_NOISE", "TEX_VORONOI", "TEX_WAVE", "TEX_MAGIC", "TEX_MUSGRAVE",
    "TEX_BRICK", "TEX_CHECKER", "TEX_GRADIENT", "TEX_WHITE_NOISE", "TEX_IES",
    "AMBIENT_OCCLUSION", "BEVEL", "BUMP", "DISPLACEMENT", "MAPPING",
})
SPATIAL_GEOMETRY_OUTPUTS = frozenset({
    "Position", "Normal", "Tangent", "True Normal", "Incoming", "Parametric", "Backfacing", "Pointiness",
})
OBJECT_SPACE_NODE_TYPES = frozenset({"AMBIENT_OCCLUSION", "BEVEL"})


def node_identity(node):
    return node.as_pointer() if hasattr(node, "as_pointer") else id(node)


def linked_from(socket):
    return socket.links[0].from_node if socket.is_linked else None


def unwrap_reroutes(socket):
    """Follows Reroute nodes upstream; returns (source_node, source_socket) or (None, None)."""
    visited = set()
    current = socket
    while current is not None and current.is_linked:
        link = current.links[0]
        source_node = link.from_node
        source_socket = link.from_socket
        identity = node_identity(source_node)
        if identity in visited:
            return None, None
        visited.add(identity)
        if source_node.type != "REROUTE":
            return source_node, source_socket
        current = source_node.inputs[0]
    return None, None


def upstream_nodes(socket):
    """All unique nodes reachable upstream from `socket`."""
    pending = [socket]
    visited = set()
    collected = []
    while pending:
        current = pending.pop()
        for link in current.links:
            node = link.from_node
            identity = node_identity(node)
            if identity in visited:
                continue
            visited.add(identity)
            collected.append(node)
            for input_socket in node.inputs:
                pending.append(input_socket)
    return collected


def find_image_node(start_socket):
    for node in upstream_nodes(start_socket):
        if node.type == "TEX_IMAGE" and node.image is not None:
            return node
    return None


def first_node(material, node_type):
    for node in material.node_tree.nodes:
        if node.type == node_type:
            return node
    return None


def is_plain_uv_vector(vector_socket):
    """True when a texture Vector socket samples plain UV coordinates without Mapping or Object/Generated inputs."""
    if not vector_socket.is_linked:
        return True
    source_node, source_socket = unwrap_reroutes(vector_socket)
    if source_node is None:
        return True
    if source_node.type == "UVMAP":
        return True
    if source_node.type == "TEX_COORD" and source_socket.name == "UV":
        return True
    return False


def is_plain_uv_image_node(node):
    return (
        node is not None
        and node.type == "TEX_IMAGE"
        and getattr(node, "image", None) is not None
        and getattr(node, "projection", "FLAT") == "FLAT"
        and is_plain_uv_vector(node.inputs["Vector"])
    )


def is_plain_uv_base_color(socket):
    if not socket.is_linked:
        return True
    source_node, _ = unwrap_reroutes(socket)
    if source_node is None:
        return True
    if source_node.type in ("VERTEX_COLOR", "ATTRIBUTE") and getattr(source_node, "layer_name", "") == BAKED_ATTRIBUTE:
        return True
    return is_plain_uv_image_node(source_node)


def is_plain_uv_roughness(socket):
    if not socket.is_linked:
        return True
    source_node, source_socket = unwrap_reroutes(socket)
    if source_node is None:
        return True
    if is_plain_uv_image_node(source_node):
        return True
    if source_node.type == "SEPARATE_COLOR" and getattr(source_node, "mode", "RGB") == "RGB" and source_socket.name == "Green":
        upstream_node, _ = unwrap_reroutes(source_node.inputs["Color"])
        return is_plain_uv_image_node(upstream_node)
    if source_node.type == "SEPRGB" and source_socket.name == "G":
        upstream_node, _ = unwrap_reroutes(source_node.inputs["Image"])
        return is_plain_uv_image_node(upstream_node)
    return False


def is_plain_uv_normal(socket):
    if not socket.is_linked:
        return True
    source_node, _ = unwrap_reroutes(socket)
    if source_node is None:
        return True
    if source_node.type != "NORMAL_MAP" or getattr(source_node, "space", "TANGENT") != "TANGENT":
        return False
    if source_node.inputs["Strength"].is_linked:
        return False
    color_socket = source_node.inputs["Color"]
    if not color_socket.is_linked:
        return True
    color_source, _ = unwrap_reroutes(color_socket)
    return is_plain_uv_image_node(color_source)


def base_color_needs_image_bake(socket, on_realized_particles=False):
    """True when a non-plain-UV Base Color carries mapped images or spatial procedural textures that vertex colors would lose."""
    if is_plain_uv_base_color(socket) or on_realized_particles:
        return False
    if find_image_node(socket) is not None:
        return True
    for node in upstream_nodes(socket):
        if node.type in SPATIAL_NODE_TYPES:
            return True
        if node.type == "TEX_COORD":
            for output_socket in node.outputs:
                if output_socket.is_linked and output_socket.name != "UV":
                    return True
        if node.type == "NEW_GEOMETRY":
            for output_socket in node.outputs:
                if output_socket.is_linked and output_socket.name in SPATIAL_GEOMETRY_OUTPUTS:
                    return True
    return False


def channels_to_bake(material, on_realized_particles=False):
    """Returns the subset of ('Base Color', 'Roughness', 'Normal') on Principled BSDF that need image baking."""
    if not material.use_nodes or material.node_tree is None:
        return []
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return []
    channels = []
    base_color = principled.inputs["Base Color"]
    if base_color_needs_image_bake(base_color, on_realized_particles=on_realized_particles):
        channels.append("Base Color")
    if "Roughness" in principled.inputs and not is_plain_uv_roughness(principled.inputs["Roughness"]):
        channels.append("Roughness")
    if "Normal" in principled.inputs and not is_plain_uv_normal(principled.inputs["Normal"]):
        channels.append("Normal")
    return channels


def uses_object_or_world_space(material, channels):
    """True when any channel to bake depends on per-object or world coordinates, so shared meshes must not share one bake."""
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return False
    for channel in channels:
        socket = principled.inputs.get(channel)
        if socket is None or not socket.is_linked:
            continue
        for node in upstream_nodes(socket):
            if node.type in OBJECT_SPACE_NODE_TYPES:
                return True
            if node.type == "TEX_COORD" and any(output.is_linked and output.name == "Object" for output in node.outputs):
                return True
            if node.type == "NEW_GEOMETRY" and any(output.is_linked and output.name in ("Position", "Normal", "True Normal") for output in node.outputs):
                return True
            if node.type == "OBJECT_INFO" and any(output.is_linked and output.name in ("Location", "Color", "Random", "Object Index") for output in node.outputs):
                return True
    return False


def next_power_of_two(value):
    power = 1
    while power < value:
        power *= 2
    return power


def compute_bake_resolution(surface_area, upstream_max_dimension=0, channel="Base Color"):
    """Picks a power-of-two texture size from world surface area (~192 texels/m) and upstream image sizes."""
    minimum_size = 512 if (upstream_max_dimension >= 512 and channel != "Roughness") else 256
    maximum_size = 1024 if channel == "Roughness" else 2048
    area_target = max(minimum_size, int(math.sqrt(max(surface_area, 0.01)) * 192))
    target = max(area_target, min(upstream_max_dimension, maximum_size))
    rounded = next_power_of_two(target)
    return max(minimum_size, min(rounded, maximum_size))


def srgb_to_linear(values):
    return numpy.where(values <= 0.04045, values / 12.92, ((values + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(values):
    values = numpy.clip(values, 0.0, 1.0)
    return numpy.where(values <= 0.0031308, values * 12.92, 1.055 * values ** (1 / 2.4) - 0.055)


def rgb_to_hsv(rgb):
    maximum = rgb.max(axis=1)
    minimum = rgb.min(axis=1)
    delta = maximum - minimum
    safe_delta = numpy.where(delta > 0, delta, 1.0)
    red, green, blue = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    hue = numpy.where(maximum == red, ((green - blue) / safe_delta) % 6, numpy.where(maximum == green, (blue - red) / safe_delta + 2, (red - green) / safe_delta + 4))
    hue = numpy.where(delta > 0, hue / 6, 0.0)
    saturation = numpy.where(maximum > 0, delta / numpy.where(maximum > 0, maximum, 1.0), 0.0)
    return numpy.stack([hue, saturation, maximum], axis=1)


def hsv_to_rgb(hsv):
    hue, saturation, value = hsv[:, 0] * 6, hsv[:, 1], hsv[:, 2]
    sector = numpy.floor(hue).astype(int) % 6
    fraction = hue - numpy.floor(hue)
    low = value * (1 - saturation)
    falling = value * (1 - saturation * fraction)
    rising = value * (1 - saturation * (1 - fraction))
    choices = [
        numpy.stack([value, rising, low], axis=1), numpy.stack([falling, value, low], axis=1), numpy.stack([low, value, rising], axis=1),
        numpy.stack([low, falling, value], axis=1), numpy.stack([rising, low, value], axis=1), numpy.stack([value, low, falling], axis=1),
    ]
    result = numpy.zeros_like(hsv)
    for index, choice in enumerate(choices):
        result = numpy.where((sector == index)[:, None], choice, result)
    return result


def constant_color(socket):
    return numpy.array(socket.default_value[:3], dtype=numpy.float64)


def colour_step(node):
    """(operation, upstream socket) for a node that changes each pixel by constants only, or None when it does more.
    The operation is None for a node that leaves the colour as it is."""
    if node.type == "REROUTE":
        return None, node.inputs[0]
    if node.type == "HUE_SAT":
        if any(node.inputs[name].is_linked for name in ("Hue", "Saturation", "Value", "Fac")):
            return None
        hue, saturation, value, factor = (node.inputs[name].default_value for name in ("Hue", "Saturation", "Value", "Fac"))
        if factor == 0 or (hue == 0.5 and saturation == 1 and value == 1):
            return None, node.inputs["Color"]

        def hue_saturation(rgb):
            # Cycles' HSV node: hue shifts by hue + 0.5 (so 0.5 changes nothing), saturation is clamped, value scales.
            hsv = rgb_to_hsv(rgb)
            hsv[:, 0] = (hsv[:, 0] + hue + 0.5) % 1.0
            hsv[:, 1] = numpy.clip(hsv[:, 1] * saturation, 0.0, 1.0)
            hsv[:, 2] = hsv[:, 2] * value
            return numpy.maximum(rgb * (1 - factor) + hsv_to_rgb(hsv) * factor, 0.0)
        return hue_saturation, node.inputs["Color"]
    if node.type == "MIX" and node.data_type == "RGBA" and node.blend_type in ("MIX", "MULTIPLY"):
        factor_socket = next(socket for socket in node.inputs if socket.enabled and socket.name == "Factor")
        first, second = (next(socket for socket in node.inputs if socket.enabled and socket.name == name) for name in ("A", "B"))
        if factor_socket.is_linked or first.is_linked == second.is_linked:
            return None
        factor = factor_socket.default_value
        image_first = first.is_linked
        other = constant_color(second if image_first else first)
        if node.blend_type == "MIX":
            image_weight = 1 - factor if image_first else factor
            return (lambda rgb: rgb * image_weight + other * (1 - image_weight)), (first if image_first else second)
        if image_first:
            return (lambda rgb: rgb * (1 - factor + factor * other)), first
        # Multiply mixes A toward A x B: with the image as B that is A x (1 - factor) + factor x A x image.
        return (lambda rgb: other * (1 - factor) + factor * other * rgb), second
    return None


def graded_image_chain(material):
    """The plain-UV image node and the per-pixel steps between it and the Base Color, nearest the image first; None otherwise."""
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return None
    steps = []
    node = linked_from(principled.inputs["Base Color"])
    while node is not None and node.type != "TEX_IMAGE":
        step = colour_step(node)
        if step is None:
            return None
        operation, upstream = step
        if operation is not None:
            steps.append(operation)
        node = linked_from(upstream)
    if not is_plain_uv_image_node(node) or not steps:
        return None
    return node, list(reversed(steps))


def grade_image(image_node, steps):
    """A copy of the node's image with the colour steps applied to every pixel, in linear light like Cycles."""
    source = image_node.image
    width, height = source.size
    pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
    source.pixels.foreach_get(pixels)
    pixels = pixels.reshape(-1, 4).astype(numpy.float64)
    stored_as_srgb = source.colorspace_settings.name == "sRGB"
    rgb = srgb_to_linear(pixels[:, :3]) if stored_as_srgb else pixels[:, :3]
    for step in steps:
        rgb = step(rgb)
    pixels[:, :3] = linear_to_srgb(rgb) if stored_as_srgb else numpy.clip(rgb, 0.0, 1.0)
    graded = bpy.data.images.new(source.name + " graded", width, height, alpha=True)
    graded.colorspace_settings.name = source.colorspace_settings.name
    graded.pixels.foreach_set(pixels.astype(numpy.float32).ravel())
    graded.pack()
    return graded


def wire_graded_image(material, image_node, graded):
    tree = material.node_tree
    graded_node = tree.nodes.new("ShaderNodeTexImage")
    graded_node.image = graded
    graded_node.interpolation = image_node.interpolation
    graded_node.extension = image_node.extension
    graded_node.projection = image_node.projection
    if image_node.inputs["Vector"].is_linked:
        tree.links.new(image_node.inputs["Vector"].links[0].from_socket, graded_node.inputs["Vector"])
    tree.links.new(graded_node.outputs["Color"], first_node(material, "BSDF_PRINCIPLED").inputs["Base Color"])


def replace_legacy_bsdfs():
    """Replaces Cycles-only Diffuse/Glossy/Emission/Glass BSDFs with Principled BSDF, preserving linked colour/roughness/normal."""
    approximated = set()
    for material in bpy.data.materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        tree = material.node_tree
        if first_node(material, "BSDF_PRINCIPLED"):
            continue
        output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
        diffuse = first_node(material, "BSDF_DIFFUSE")
        glossy = first_node(material, "BSDF_GLOSSY")
        emission = first_node(material, "EMISSION")
        glass = first_node(material, "BSDF_GLASS") or first_node(material, "BSDF_TRANSPARENT")
        if output is None or not (diffuse or glossy or emission or glass):
            continue
        principled = tree.nodes.new("ShaderNodeBsdfPrincipled")
        principled.inputs["Roughness"].default_value = 0.6
        source = diffuse or glossy or glass
        if source is not None:
            color_input = source.inputs["Color"]
            if color_input.is_linked:
                tree.links.new(color_input.links[0].from_socket, principled.inputs["Base Color"])
            else:
                principled.inputs["Base Color"].default_value = color_input.default_value
            if "Roughness" in source.inputs:
                roughness_input = source.inputs["Roughness"]
                if roughness_input.is_linked:
                    tree.links.new(roughness_input.links[0].from_socket, principled.inputs["Roughness"])
                else:
                    principled.inputs["Roughness"].default_value = roughness_input.default_value
            if "Normal" in source.inputs and source.inputs["Normal"].is_linked:
                tree.links.new(source.inputs["Normal"].links[0].from_socket, principled.inputs["Normal"])
        if glossy is not None and diffuse is None:
            principled.inputs["Metallic"].default_value = 1.0
        elif glossy is not None:
            glossy_roughness = glossy.inputs["Roughness"]
            if glossy_roughness.is_linked and not principled.inputs["Roughness"].is_linked:
                tree.links.new(glossy_roughness.links[0].from_socket, principled.inputs["Roughness"])
            elif not principled.inputs["Roughness"].is_linked:
                principled.inputs["Roughness"].default_value = glossy_roughness.default_value
            principled.inputs["Metallic"].default_value = 0.0
            if not principled.inputs["Normal"].is_linked and "Normal" in glossy.inputs and glossy.inputs["Normal"].is_linked:
                tree.links.new(glossy.inputs["Normal"].links[0].from_socket, principled.inputs["Normal"])
        if emission is not None and diffuse is None and glossy is None:
            if emission.inputs["Color"].is_linked:
                tree.links.new(emission.inputs["Color"].links[0].from_socket, principled.inputs["Emission Color"])
            else:
                principled.inputs["Emission Color"].default_value = emission.inputs["Color"].default_value
            principled.inputs["Emission Strength"].default_value = emission.inputs["Strength"].default_value
        if glass is not None:
            principled.inputs["Alpha"].default_value = 0.25
            material.surface_render_method = "BLENDED"
        tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
        approximated.add(material.name)
    return approximated


def base_color_from_nodes(material):
    """True when Base Color is wired to per-island/per-object nodes with no image or spatial procedural nodes upstream."""
    if not material.use_nodes or material.node_tree is None:
        return False
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return False
    base_color = principled.inputs["Base Color"]
    return base_color.is_linked and not is_plain_uv_base_color(base_color) and find_image_node(base_color) is None


def mesh_users(material):
    return [
        candidate for candidate in bpy.context.view_layer.objects
        if candidate.type == "MESH" and candidate.visible_get() and not candidate.hide_render
        and any(slot.material == material for slot in candidate.material_slots)
    ]


def apply_modifiers(objects):
    """Applies each object's modifiers, so the bake writes one colour/UV per exported mesh corner (#2761)."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for candidate in objects:
        if not candidate.modifiers:
            continue
        evaluated = candidate.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
        candidate.modifiers.clear()
        candidate.data = mesh


def bake_base_colors(objects):
    apply_modifiers(objects)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    bake = scene.render.bake
    bake.target = "VERTEX_COLORS"
    bake.use_pass_direct = False
    bake.use_pass_indirect = False
    bake.use_pass_color = True
    for candidate in bpy.context.view_layer.objects:
        candidate.select_set(False)
    for candidate in objects:
        attributes = candidate.data.color_attributes
        attribute = attributes.get(BAKED_ATTRIBUTE) or attributes.new(BAKED_ATTRIBUTE, "BYTE_COLOR", "CORNER")
        attributes.active_color = attribute
        candidate.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.bake(type="DIFFUSE", target="VERTEX_COLORS")


def wire_baked_color(material):
    tree = material.node_tree
    principled = first_node(material, "BSDF_PRINCIPLED")
    attribute_node = tree.nodes.new("ShaderNodeVertexColor")
    attribute_node.layer_name = BAKED_ATTRIBUTE
    tree.links.new(attribute_node.outputs["Color"], principled.inputs["Base Color"])


def one_object_per_mesh(objects):
    """Copies sharing one plain mesh datablock share UVs and vertex attributes, so they only need one bake."""
    kept = {}
    for candidate in objects:
        key = ("object", candidate.name) if candidate.modifiers else ("mesh", candidate.data.name)
        kept.setdefault(key, candidate)
    return list(kept.values())


def world_surface_area(objects):
    total = 0.0
    for candidate in objects:
        scale = candidate.matrix_world.to_scale()
        area_scale = (abs(scale.x * scale.y) + abs(scale.y * scale.z) + abs(scale.z * scale.x)) / 3.0
        total += sum(polygon.area for polygon in candidate.data.polygons) * area_scale
    return total


def max_upstream_image_dimension(material, channels):
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return 0
    largest = 0
    for channel in channels:
        socket = principled.inputs.get(channel)
        if socket is None or not socket.is_linked:
            continue
        for node in upstream_nodes(socket):
            if node.type == "TEX_IMAGE" and node.image is not None:
                width, height = node.image.size
                largest = max(largest, width, height)
    return largest


def active_render_uv_name(mesh):
    if mesh.uv_layers.active_render is not None:
        return mesh.uv_layers.active_render.name
    return mesh.uv_layers[0].name if len(mesh.uv_layers) else None


def referenced_uv_names_on_mesh(mesh):
    """UV layer names referenced by live shader nodes reachable from Material Output on `mesh`."""
    names = set()
    default_uv = active_render_uv_name(mesh)
    for slot in mesh.materials:
        if slot is None or not slot.use_nodes or slot.node_tree is None:
            continue
        output = next((node for node in slot.node_tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
        if output is None or not output.inputs["Surface"].is_linked:
            continue
        for node in upstream_nodes(output.inputs["Surface"]):
            if node.type == "UVMAP" and node.uv_map:
                names.add(node.uv_map)
            elif node.type == "NORMAL_MAP" and node.uv_map:
                names.add(node.uv_map)
            elif node.type == "TEX_IMAGE" and not node.inputs["Vector"].is_linked and default_uv:
                names.add(default_uv)
            elif node.type == "TEX_COORD" and node.outputs["UV"].is_linked and default_uv:
                names.add(default_uv)
    return names


def clear_all_material_node_selections():
    for candidate in bpy.data.materials:
        if not candidate.use_nodes or candidate.node_tree is None:
            continue
        candidate.node_tree.nodes.active = None
        for node in candidate.node_tree.nodes:
            node.select = False


def pin_unlinked_uv_images(material, default_uv_name):
    """Pins any unlinked plain-UV image nodes on kept channels to `default_uv_name` before adding a bake UV layer."""
    if not default_uv_name or not material.use_nodes or material.node_tree is None:
        return
    tree = material.node_tree
    for node in tree.nodes:
        if node.type == "TEX_IMAGE" and node.image is not None and not node.inputs["Vector"].is_linked:
            uv_node = tree.nodes.new("ShaderNodeUVMap")
            uv_node.uv_map = default_uv_name
            tree.links.new(uv_node.outputs["UV"], node.inputs["Vector"])


def ensure_unique_meshes_for_bake(material, objects, channels):
    if not uses_object_or_world_space(material, channels):
        all_mesh_users = {candidate.data.name: 0 for candidate in objects}
        for candidate in bpy.data.objects:
            if candidate.type == "MESH" and candidate.data.name in all_mesh_users:
                all_mesh_users[candidate.data.name] += 1
        in_group = {}
        for candidate in objects:
            in_group[candidate.data.name] = in_group.get(candidate.data.name, 0) + 1
        for candidate in objects:
            if all_mesh_users[candidate.data.name] > in_group[candidate.data.name]:
                candidate.data = candidate.data.copy()
        return one_object_per_mesh(objects)
    seen_meshes = set()
    for candidate in objects:
        if candidate.data.name in seen_meshes or candidate.data.users > 1:
            candidate.data = candidate.data.copy()
        seen_meshes.add(candidate.data.name)
    return objects


def bake_channel_emit(material, source_socket, image, margin):
    tree = material.node_tree
    output = next((node for node in tree.nodes if node.type == "OUTPUT_MATERIAL"), None)
    if output is None:
        return
    original_surface = output.inputs["Surface"].links[0].from_socket if output.inputs["Surface"].is_linked else None
    emission = tree.nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    tree.links.new(source_socket, emission.inputs["Color"])
    tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    bake_node = tree.nodes.new("ShaderNodeTexImage")
    bake_node.image = image
    clear_all_material_node_selections()
    tree.nodes.active = bake_node
    bake_node.select = True
    bpy.ops.object.bake(type="EMIT", uv_layer=BAKE_UV_NAME, margin=margin, use_clear=True)
    if original_surface is not None:
        tree.links.new(original_surface, output.inputs["Surface"])
    tree.nodes.remove(emission)
    tree.nodes.remove(bake_node)


def bake_channel_normal(material, image, margin):
    tree = material.node_tree
    bake_node = tree.nodes.new("ShaderNodeTexImage")
    bake_node.image = image
    clear_all_material_node_selections()
    tree.nodes.active = bake_node
    bake_node.select = True
    bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT", uv_layer=BAKE_UV_NAME, margin=margin, use_clear=True)
    tree.nodes.remove(bake_node)


def rewire_baked_channels(material, baked_images):
    tree = material.node_tree
    principled = first_node(material, "BSDF_PRINCIPLED")
    uv_node = tree.nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = BAKE_UV_NAME
    if "Base Color" in baked_images:
        color_tex = tree.nodes.new("ShaderNodeTexImage")
        color_tex.image = baked_images["Base Color"]
        tree.links.new(uv_node.outputs["UV"], color_tex.inputs["Vector"])
        tree.links.new(color_tex.outputs["Color"], principled.inputs["Base Color"])
    if "Roughness" in baked_images:
        rough_tex = tree.nodes.new("ShaderNodeTexImage")
        rough_tex.image = baked_images["Roughness"]
        tree.links.new(uv_node.outputs["UV"], rough_tex.inputs["Vector"])
        tree.links.new(rough_tex.outputs["Color"], principled.inputs["Roughness"])
    if "Normal" in baked_images:
        normal_tex = tree.nodes.new("ShaderNodeTexImage")
        normal_tex.image = baked_images["Normal"]
        normal_map = tree.nodes.new("ShaderNodeNormalMap")
        normal_map.space = "TANGENT"
        normal_map.uv_map = BAKE_UV_NAME
        tree.links.new(uv_node.outputs["UV"], normal_tex.inputs["Vector"])
        tree.links.new(normal_tex.outputs["Color"], normal_map.inputs["Color"])
        tree.links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])


def prepare_bake_uv_for_plan(image_bake_plan):
    """Prepares unique meshes and unwraps `baked_uv` once per connected group of materials and meshes."""
    plan_targets = []
    for material, channels in image_bake_plan:
        objects = [candidate for candidate in mesh_users(material) if len(candidate.data.polygons) > 0]
        if not objects:
            continue
        apply_modifiers(objects)
        bake_targets = ensure_unique_meshes_for_bake(material, objects, channels)
        plan_targets.append((material, channels, bake_targets))

    mesh_to_groups = {}
    for index, (_, _, bake_targets) in enumerate(plan_targets):
        for candidate in bake_targets:
            mesh_to_groups.setdefault(candidate.data.name, set()).add(index)

    visited_groups = set()
    components = []
    for start_index in range(len(plan_targets)):
        if start_index in visited_groups:
            continue
        queue = [start_index]
        component_targets = {}
        while queue:
            group_index = queue.pop()
            if group_index in visited_groups:
                continue
            visited_groups.add(group_index)
            for candidate in plan_targets[group_index][2]:
                component_targets[candidate.name] = candidate
                for neighbor in mesh_to_groups[candidate.data.name]:
                    if neighbor not in visited_groups:
                        queue.append(neighbor)
        components.append(list(component_targets.values()))

    for component_objects in components:
        original_uv_by_mesh = {}
        for candidate in component_objects:
            mesh = candidate.data
            original_uv = active_render_uv_name(mesh)
            original_uv_by_mesh[mesh.name] = original_uv
            if len(mesh.uv_layers) >= 2:
                needed = referenced_uv_names_on_mesh(mesh)
                for layer in list(mesh.uv_layers):
                    if layer.name != BAKE_UV_NAME and layer.name not in needed and len(mesh.uv_layers) >= 2:
                        mesh.uv_layers.remove(layer)
            if original_uv:
                for slot in mesh.materials:
                    if slot is not None:
                        pin_unlinked_uv_images(slot, original_uv)
            if BAKE_UV_NAME not in mesh.uv_layers:
                mesh.uv_layers.new(name=BAKE_UV_NAME, do_init=False)
            mesh.uv_layers.active = mesh.uv_layers[BAKE_UV_NAME]

        for candidate in bpy.context.view_layer.objects:
            candidate.select_set(False)
        for candidate in component_objects:
            candidate.select_set(True)
        bpy.context.view_layer.objects.active = component_objects[0]
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_mode(type="FACE")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=1.1519173, island_margin=0.02, correct_aspect=True)
        bpy.ops.object.mode_set(mode="OBJECT")

        for candidate in component_objects:
            mesh = candidate.data
            original_uv = original_uv_by_mesh.get(mesh.name)
            if original_uv and original_uv in mesh.uv_layers:
                mesh.uv_layers[original_uv].active_render = True
                mesh.uv_layers.active = mesh.uv_layers[original_uv]

    return plan_targets


def bake_material_channels(material, channels, bake_targets):
    """Bakes non-plain-UV channels of `material` onto `baked_uv` images without clobbering existing UV images."""
    if not bake_targets:
        return False

    area = world_surface_area(bake_targets)
    upstream_max = max_upstream_image_dimension(material, channels)
    base_size = compute_bake_resolution(area, upstream_max, "Base Color")

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.bake.target = "IMAGE_TEXTURES"

    for candidate in bpy.context.view_layer.objects:
        candidate.select_set(False)
    for candidate in bake_targets:
        candidate.select_set(True)
    bpy.context.view_layer.objects.active = bake_targets[0]

    principled = first_node(material, "BSDF_PRINCIPLED")
    baked_images = {}
    if "Base Color" in channels and principled.inputs["Base Color"].is_linked:
        size = compute_bake_resolution(area, upstream_max, "Base Color")
        color_image = bpy.data.images.new(f"{material.name}_baked_color", size, size, alpha=False)
        color_image.colorspace_settings.name = "sRGB"
        bake_channel_emit(material, principled.inputs["Base Color"].links[0].from_socket, color_image, max(4, size // 128))
        color_image.pack()
        baked_images["Base Color"] = color_image
    if "Roughness" in channels and principled.inputs["Roughness"].is_linked:
        size = compute_bake_resolution(area, upstream_max, "Roughness")
        rough_image = bpy.data.images.new(f"{material.name}_baked_roughness", size, size, alpha=False)
        rough_image.colorspace_settings.name = "Non-Color"
        bake_channel_emit(material, principled.inputs["Roughness"].links[0].from_socket, rough_image, max(4, size // 128))
        rough_image.pack()
        baked_images["Roughness"] = rough_image
    if "Normal" in channels and principled.inputs["Normal"].is_linked:
        size = base_size
        normal_image = bpy.data.images.new(f"{material.name}_baked_normal", size, size, alpha=False)
        normal_image.colorspace_settings.name = "Non-Color"
        bake_channel_normal(material, normal_image, max(4, size // 128))
        normal_image.pack()
        baked_images["Normal"] = normal_image

    rewire_baked_channels(material, baked_images)
    return bool(baked_images)


def remove_unused_bake_source_uvs(prepared_plan):
    seen_meshes = set()
    for _, _, bake_targets in prepared_plan:
        for candidate in bake_targets:
            mesh = candidate.data
            if mesh.name in seen_meshes:
                continue
            seen_meshes.add(mesh.name)
            needed = referenced_uv_names_on_mesh(mesh)
            for layer in list(mesh.uv_layers):
                if layer.name != BAKE_UV_NAME and layer.name not in needed:
                    mesh.uv_layers.remove(layer)
            if BAKE_UV_NAME in mesh.uv_layers and len(mesh.uv_layers) == 1:
                mesh.uv_layers[BAKE_UV_NAME].active_render = True
                mesh.uv_layers.active = mesh.uv_layers[BAKE_UV_NAME]


def realize_particle_instances():
    """The glTF exporter skips hair particles that place objects or collections, so the Lone Monk lawn left as bare
    mud and its bushes went missing (#2761). Each emitter's instances become real objects that share their mesh
    for the bake, and an emitter Blender would not render is hidden. It runs before the bake,
    which applies modifiers and so would drop a particle system whose emitter carries a baked material (the lawn)."""
    realized_instances = []
    emitters = [
        candidate for candidate in bpy.context.view_layer.objects
        if candidate.visible_get() and any(
            modifier.type == "PARTICLE_SYSTEM" and modifier.show_render
            and modifier.particle_system.settings.render_type in {"OBJECT", "COLLECTION"}
            for modifier in candidate.modifiers
        )
    ]
    for emitter in emitters:
        for candidate in bpy.context.view_layer.objects:
            candidate.select_set(False)
        emitter.select_set(True)
        bpy.context.view_layer.objects.active = emitter
        # Making instances real reads the viewport counts; the lawn renders 20 children per hair but shows 1.
        for modifier in emitter.modifiers:
            if modifier.type == "PARTICLE_SYSTEM":
                settings = modifier.particle_system.settings
                settings.display_percentage = 100
                settings.child_percent = settings.rendered_child_count
        existing_names = set(bpy.data.objects.keys())
        bpy.ops.object.duplicates_make_real(use_base_parent=False, use_hierarchy=False)
        realized = [candidate for candidate in bpy.data.objects if candidate.name not in existing_names]
        systems = [modifier for modifier in emitter.modifiers if modifier.type == "PARTICLE_SYSTEM"]
        for modifier in systems:
            emitter.modifiers.remove(modifier)
        if not emitter.show_instancer_for_render:
            emitter.hide_render = True
        realized_instances.append(realized)
        print("PARTICLES", emitter.name, len(realized), "instances")
    return realized_instances


def join_realized_instances(realized_instances):
    """The exporter writes each realized instance as its own node, and 87,000 nodes pass the loader's part limit, so
    after the bake each emitter's instances become one mesh. The joined copies keep their baked vertex colours."""
    for realized in realized_instances:
        meshes = [candidate for candidate in realized if candidate.type == "MESH" and candidate.name in bpy.data.objects]
        if len(meshes) < 2:
            continue
        for candidate in bpy.context.view_layer.objects:
            candidate.select_set(False)
        for candidate in meshes:
            candidate.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        print("JOINED", len(meshes), "instances into", meshes[0].name)


def find_analytic_sky(world):
    """The Sky Texture node of a world that is lit by an analytic sky (Nishita and its siblings), or None."""
    if world is None or not world.use_nodes or world.node_tree is None:
        return None
    return first_node(world, "TEX_SKY")


def bake_world_sky(directory):
    """A world lit by an analytic sky has no light in the glTF, so the sky is rendered to sky.hdr with its sun at full
    strength (a Cycles equirectangular view, Standard view transform so the file is linear), and world.json records the
    view transform and exposure for the scene file (#2761). The map faces Blender +Y, which is glTF -Z, the middle of
    Crucible's equirectangular map. Worlds without a Sky Texture write nothing, and the scene keeps its default sky."""
    scene = bpy.context.scene
    world = scene.world
    sky = find_analytic_sky(world)
    if sky is None:
        return
    settings = scene.view_settings
    world_description = {
        "viewTransform": settings.view_transform,
        "look": settings.look,
        "exposureStops": settings.exposure,
        "gamma": settings.gamma,
        "sky": {"type": sky.sky_type, "sunDisc": bool(getattr(sky, "sun_disc", False)),
                "sunElevationRadians": getattr(sky, "sun_elevation", None), "sunRotationRadians": getattr(sky, "sun_rotation", None),
                "sunSizeRadians": getattr(sky, "sun_size", None), "sunIntensity": getattr(sky, "sun_intensity", None)},
    }
    bake_scene = bpy.data.scenes.new("sky-bake")
    bake_scene.world = world
    bake_scene.render.engine = "CYCLES"
    bake_scene.cycles.device = "CPU"
    bake_scene.cycles.samples = 16
    bake_scene.cycles.use_denoising = False
    bake_scene.render.resolution_x = SKY_BAKE_WIDTH
    bake_scene.render.resolution_y = SKY_BAKE_HEIGHT
    bake_scene.render.resolution_percentage = 100
    bake_scene.render.film_transparent = False
    bake_scene.view_settings.view_transform = "Standard"
    bake_scene.view_settings.look = "None"
    bake_scene.view_settings.exposure = 0.0
    bake_scene.render.image_settings.file_format = "HDR"
    bake_scene.render.image_settings.color_depth = "32"
    camera_data = bpy.data.cameras.new("sky-bake-camera")
    camera_data.type = "PANO"
    camera_data.panorama_type = "EQUIRECTANGULAR"
    camera_data.clip_start = 0.1
    camera = bpy.data.objects.new("sky-bake-camera", camera_data)
    # Cycles' equirectangular camera puts its own forward axis at the map centre, so the camera is turned -90 degrees
    # about Z as well: measured with marker spheres, Blender +X lands on Crucible +X and +Y on -Z, the map centre.
    # Without the turn the sun came out 90 degrees off its Cycles azimuth (#2761).
    camera.rotation_euler = (1.5707963267948966, 0.0, -1.5707963267948966)
    bake_scene.collection.objects.link(camera)
    bake_scene.camera = camera
    bake_scene.render.filepath = directory + "/sky.hdr"
    bpy.ops.render.render(write_still=True, scene=bake_scene.name)
    with open(directory + "/world.json", "w", encoding="utf-8") as world_file:
        json.dump(world_description, world_file, indent=2)
    print("SKY", sky.sky_type, "baked to sky.hdr; view", settings.view_transform, "exposure", settings.exposure)


def export_demo_scene(output_directory):
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    approximated = replace_legacy_bsdfs()

    graded_images = {}
    graded = set()
    for material in bpy.data.materials:
        if material.users == 0 or not material.use_nodes or material.node_tree is None:
            continue
        chain = graded_image_chain(material)
        if chain is None:
            continue
        image_node, steps = chain
        key = (image_node.image.name, material.name)
        graded_images[key] = grade_image(image_node, steps)
        wire_graded_image(material, image_node, graded_images[key])
        graded.add(material.name)

    realized_instances = realize_particle_instances()
    realized_object_names = {candidate.name for group in realized_instances for candidate in group}

    image_bake_plan = []
    vertex_bake_candidates = []
    for material in bpy.data.materials:
        if material.users == 0 or not material.use_nodes or material.node_tree is None:
            continue
        users = mesh_users(material)
        if not users:
            continue
        on_realized = all(candidate.name in realized_object_names for candidate in users)
        image_channels = channels_to_bake(material, on_realized_particles=on_realized)
        if image_channels:
            image_bake_plan.append((material, image_channels))
        if "Base Color" not in image_channels and base_color_from_nodes(material):
            vertex_bake_candidates.append(material)

    vertex_baked_objects = {candidate.name: candidate for material in vertex_bake_candidates for candidate in mesh_users(material)}
    if vertex_baked_objects:
        bake_base_colors(one_object_per_mesh(vertex_baked_objects.values()))
        for material in vertex_bake_candidates:
            wire_baked_color(material)

    prepared_plan = prepare_bake_uv_for_plan(image_bake_plan)
    image_baked_channels = {}
    for material, image_channels, bake_targets in prepared_plan:
        if bake_material_channels(material, image_channels, bake_targets):
            image_baked_channels[material.name] = image_channels
    remove_unused_bake_source_uvs(prepared_plan)

    baked = {material.name for material in vertex_bake_candidates} | set(image_baked_channels)
    for material in bpy.data.materials:
        if material.users == 0:
            continue
        if material.name in baked:
            state = "baked"
        elif material.name in graded:
            state = "graded"
        elif material.name in approximated:
            state = "approximated"
        else:
            state = "kept"
        print("MATERIAL", state, material.name)
        if material.name in image_baked_channels:
            print("BAKED_CHANNELS", material.name, ",".join(image_baked_channels[material.name]))
    print(
        "APPROXIMATED", len(approximated),
        "GRADED", len(graded),
        "BAKED", len(baked),
        "materials (vertex:", len(vertex_bake_candidates), "image:", len(image_baked_channels), ")",
        "of", len(bpy.data.materials),
    )

    # The published Classroom render lit the sun at strength 40, which the owner picked from previews at 15, 40 and 100 (#1083).
    # The .blend ships it at 15 (energy 1 times an Emission strength of 15 in the light's node tree), and the glTF exporter
    # writes their product, so the export sets energy 40 and Emission 1 to keep the README picture at its published brightness.
    sun_strength = SUN_STRENGTH_BY_DEMO.get(os.path.basename(bpy.data.filepath))
    if sun_strength is not None:
        for light in bpy.data.lights:
            if light.type != "SUN":
                continue
            if light.use_nodes and light.node_tree is not None:
                for node in light.node_tree.nodes:
                    if node.type == "EMISSION":
                        node.inputs["Strength"].default_value = 1.0
            light.energy = sun_strength
            print("SUN", light.name, sun_strength)

    # A glTF sun has no size, so each sun lamp's half-angle goes to its extras (export_extras below) and Crucible softens the sun's
    # shadow edge by it (#2761). The lamp angle is a diameter.
    for light in bpy.data.lights:
        if light.type == "SUN" and light.angle > 0:
            light["sunAngularRadius"] = light.angle / 2

    bake_world_sky(output_directory)
    join_realized_instances(realized_instances)
    bpy.ops.export_scene.gltf(
        filepath=output_directory + "/scene.glb", export_format="GLB", export_apply=True, export_gpu_instances=True,
        export_image_format="JPEG", export_jpeg_quality=85, export_cameras=False, export_lights=True, export_extras=True,
        export_import_convert_lighting_mode="COMPAT", export_vertex_color="MATERIAL",
        use_renderable=True, use_visible=True, export_yup=True, export_texcoords=True, export_normals=True,
    )
    print("EXPORTED")


if __name__ == "__main__" and bpy is not None and "--" in sys.argv:
    export_demo_scene(sys.argv[sys.argv.index("--") + 1])
