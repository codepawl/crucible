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
Principled BSDF in their place first (base colour or the first image texture upstream of the Diffuse colour, roughness, metal for
a lone Glossy, a soft alpha for Glass), so colours and textures survive. It is an approximation, not a Cycles match.

A base colour built from nodes with no image texture upstream (a ColorRamp on Random Per Island, a Noise texture on Object
coordinates) is dropped by the exporter, which writes only image textures. Such colours are baked per object to a face-corner
colour attribute (Cycles, Diffuse colour only) and wired into the Base Color, so they reach the GLB as COLOR_0 (#2766). It prints
one line per material: kept, approximated (a Cycles-only BSDF replaced), graded or baked.

The exporter also skips hair particles that place objects or collections (the Lone Monk lawn and bushes). Their instances are
made real objects first and joined into one mesh per emitter after the bake (#2761); it prints PARTICLES and JOINED lines.

An image texture tinted on its way to the Base Color by constant nodes only (Hue Saturation Value, a Mix or Multiply toward a
flat colour) is graded instead: the tint is applied to a copy of the image in linear light, as Cycles does, and that copy is
wired in, so the texture keeps its full resolution (#2761). Baking those to vertex colours left blotches on large plaster walls.
Modifiers are applied before the bake so a subdivided wall gets its colour on the vertices that are exported.

A world lit by an analytic sky (a Sky Texture node, as the Lone Monk has instead of lamps) is rendered to sky.hdr with its sun
at full strength, and world.json records the scene's view transform and exposure. scripts/blender-world-sky.mjs reads both into
scene.json: the HDRI replaces the airport sky, whose sun Crucible takes out as the shadowed key (#2761).
"""
import json
import os
import sys

import bpy
import numpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import blender_demo_channels as demo_channels

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
output_directory = sys.argv[sys.argv.index("--") + 1]


def find_image_node(start_socket):
    pending = [start_socket]
    visited = set()
    while pending:
        socket = pending.pop()
        for link in socket.links:
            node = link.from_node
            if node.as_pointer() in visited:
                continue
            visited.add(node.as_pointer())
            if node.type == "TEX_IMAGE" and node.image is not None:
                return node
            for input_socket in node.inputs:
                pending.append(input_socket)
    return None


def first_node(material, node_type):
    for node in material.node_tree.nodes:
        if node.type == node_type:
            return node
    return None


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
        image_node = find_image_node(color_input)
        if image_node is not None:
            tree.links.new(image_node.outputs["Color"], principled.inputs["Base Color"])
        else:
            principled.inputs["Base Color"].default_value = color_input.default_value
        if "Roughness" in source.inputs:
            principled.inputs["Roughness"].default_value = source.inputs["Roughness"].default_value
    if glossy is not None and diffuse is None:
        principled.inputs["Metallic"].default_value = 1.0
    elif glossy is not None:
        principled.inputs["Roughness"].default_value = glossy.inputs["Roughness"].default_value
        principled.inputs["Metallic"].default_value = 0.0
    if emission is not None and diffuse is None and glossy is None:
        principled.inputs["Emission Color"].default_value = emission.inputs["Color"].default_value
        principled.inputs["Emission Strength"].default_value = emission.inputs["Strength"].default_value
    if glass is not None:
        principled.inputs["Alpha"].default_value = 0.25
        material.surface_render_method = "BLENDED"
    tree.links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    approximated.add(material.name)


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


def linked_from(socket):
    return socket.links[0].from_node if socket.is_linked else None


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
    """The image node and the per-pixel steps between it and the Base Color, nearest the image first; None otherwise."""
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
    if node is None or node.image is None or not steps:
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


# An image texture tinted by constant colour nodes (a Mix toward a flat colour, Hue Saturation Value) reaches the GLB as
# the raw image, because the exporter keeps only the image. The tint is applied to a copy of the image instead (#2761).
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

BAKED_ATTRIBUTE = "baked_base_color"


def base_color_from_nodes(material):
    """True when the Base Color is wired to nodes with no image texture upstream: the exporter drops such a colour."""
    if not material.use_nodes or material.node_tree is None:
        return False
    principled = first_node(material, "BSDF_PRINCIPLED")
    if principled is None:
        return False
    base_color = principled.inputs["Base Color"]
    return base_color.is_linked and find_image_node(base_color) is None


def mesh_users(material):
    return [
        candidate for candidate in bpy.context.view_layer.objects
        if candidate.type == "MESH" and candidate.visible_get() and not candidate.hide_render and any(slot.material == material for slot in candidate.material_slots)
    ]


def apply_modifiers(objects):
    """Applies each object's modifiers, so the bake writes one colour per corner of the mesh that is exported: an Array
    of roof tiles baked on the source tile would give every copy the colour of the first one (#2761)."""
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


def realize_particle_instances():
    """The glTF exporter skips hair particles that place objects or collections, so the Lone Monk lawn left as bare
    mud and its bushes went missing (#2761). Each emitter's instances become real objects that share their mesh
    for the bake, and an emitter Blender would not render is hidden. It runs before the bake,
    which applies modifiers and so would drop a particle system whose emitter carries a baked material (the lawn)."""
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


def join_realized_instances():
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


realized_instances = []
realize_particle_instances()


def one_object_per_mesh(objects):
    """Vertex colours live on the mesh, so the copies of a realized particle that share one plain mesh need one bake."""
    kept = {}
    for candidate in objects:
        key = ("object", candidate.name) if candidate.modifiers else ("mesh", candidate.data.name)
        kept.setdefault(key, candidate)
    return list(kept.values())


to_bake = [material for material in bpy.data.materials if base_color_from_nodes(material) and mesh_users(material)]
baked_objects = {candidate.name: candidate for material in to_bake for candidate in mesh_users(material)}
if baked_objects:
    bake_base_colors(one_object_per_mesh(baked_objects.values()))
    for material in to_bake:
        wire_baked_color(material)
BAKED_UV = "baked_uv"
BAKE_TEXELS_PER_METRE = 160
BAKE_MIN_SIZE = 512
BAKE_MAX_SIZE = 2048
BAKE_PASSES = (("Base Color", "DIFFUSE"), ("Roughness", "ROUGHNESS"), ("Normal", "NORMAL"))


def material_graph(material):
    """The material's node tree as the plain graph that blender_demo_channels reads."""
    graph = {}
    for node in material.node_tree.nodes:
        inputs = {}
        for socket in node.inputs:
            for link in socket.links:
                inputs.setdefault(socket.name, []).append((link.from_node.name, link.from_socket.name))
        graph[node.name] = {"type": node.type, "projection": getattr(node, "projection", "FLAT"), "inputs": inputs}
    return graph


def warped_channels_by_material():
    """Material name to the Principled channels whose image coordinates the exporter drops."""
    found = {}
    for material in bpy.data.materials:
        if material.users == 0 or not material.use_nodes or material.node_tree is None:
            continue
        principled = first_node(material, "BSDF_PRINCIPLED")
        if principled is None:
            continue
        sockets = demo_channels.channels_to_bake(demo_channels.classify_material(material_graph(material), principled.name))
        if sockets:
            found[material.name] = sockets
    return found


def slot_surface_area(candidate, slot_index):
    scale = candidate.matrix_world.to_scale()
    return sum(polygon.area for polygon in candidate.data.polygons if polygon.material_index == slot_index) * abs(scale.x * scale.y)


def unwrap_slot_faces(candidate, slot_index):
    """Smart UV Project of this slot's faces onto the active baked_uv layer, so each texel is used once."""
    import bmesh
    bpy.context.view_layer.objects.active = candidate
    bpy.ops.object.mode_set(mode="EDIT")
    edit_mesh = bmesh.from_edit_mesh(candidate.data)
    for face in edit_mesh.faces:
        face.select_set(face.material_index == slot_index)
    edit_mesh.select_flush(True)
    bmesh.update_edit_mesh(candidate.data)
    bpy.ops.uv.smart_project(angle_limit=1.1519, island_margin=0.004, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def add_image_node(material, image):
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    return node


def new_bake_image(name, size, is_colour):
    image = bpy.data.images.new(name, size, size, alpha=False)
    image.colorspace_settings.name = "sRGB" if is_colour else "Non-Color"
    return image


def wire_baked_channel(material, socket_name, image):
    tree = material.node_tree
    principled = first_node(material, "BSDF_PRINCIPLED")
    for link in list(principled.inputs[socket_name].links):
        tree.links.remove(link)
    image_node = add_image_node(material, image)
    uv_node = tree.nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = BAKED_UV
    tree.links.new(uv_node.outputs["UV"], image_node.inputs["Vector"])
    if socket_name == "Normal":
        normal_node = tree.nodes.new("ShaderNodeNormalMap")
        normal_node.space = "TANGENT"
        normal_node.uv_map = BAKED_UV
        tree.links.new(image_node.outputs["Color"], normal_node.inputs["Color"])
        tree.links.new(normal_node.outputs["Normal"], principled.inputs["Normal"])
    else:
        tree.links.new(image_node.outputs["Color"], principled.inputs[socket_name])


def bake_object_warped_slots(candidate, warped, report):
    """Gives each warped material of one object a copy that reads baked images on a unique UV layer."""
    if candidate.data.users > 1:
        candidate.data = candidate.data.copy()
    mesh = candidate.data
    mesh.uv_layers.active = mesh.uv_layers.get(BAKED_UV) or mesh.uv_layers.new(name=BAKED_UV)
    targets = {}
    for slot_index, slot in enumerate(candidate.material_slots):
        original = slot.material
        if original is None or original.name not in warped:
            continue
        sockets = warped[original.name]
        size = demo_channels.baked_texture_size(slot_surface_area(candidate, slot_index), BAKE_TEXELS_PER_METRE, BAKE_MIN_SIZE, BAKE_MAX_SIZE)
        copy = original.copy()
        copy.name = original.name + " baked " + candidate.name
        slot.material = copy
        unwrap_slot_faces(candidate, slot_index)
        images = {socket: new_bake_image(copy.name + " " + socket, size, socket == "Base Color") for socket in sockets}
        targets[slot_index] = {"material": copy, "original": original.name, "sockets": sockets, "size": size, "images": images,
                               "nodes": {socket: add_image_node(copy, images[socket]) for socket in sockets}}
    # Cycles refuses to bake when a material of the object has no active image node, so every slot gets a scratch one.
    scratch = bpy.data.images.new("bake scratch", 4, 4)
    scratch_nodes = {index: add_image_node(slot.material, scratch) for index, slot in enumerate(candidate.material_slots) if slot.material is not None}
    scene = bpy.context.scene
    scene.render.bake.target = "IMAGE_TEXTURES"
    scene.render.bake.margin = 16
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.normal_space = "TANGENT"
    for other in bpy.context.view_layer.objects:
        other.select_set(False)
    candidate.select_set(True)
    bpy.context.view_layer.objects.active = candidate
    for socket_name, bake_type in BAKE_PASSES:
        if not any(socket_name in target["sockets"] for target in targets.values()):
            continue
        for slot_index, scratch_node in scratch_nodes.items():
            target_node = targets.get(slot_index, {}).get("nodes", {}).get(socket_name)
            candidate.material_slots[slot_index].material.node_tree.nodes.active = target_node or scratch_node
        bpy.ops.object.bake(type=bake_type)
    for slot_index, scratch_node in scratch_nodes.items():
        candidate.material_slots[slot_index].material.node_tree.nodes.remove(scratch_node)
    bpy.data.images.remove(scratch)
    mesh.uv_layers.active = mesh.uv_layers[0]  # the materials that keep their own UVs read the first layer
    for target in targets.values():
        for socket_name in target["sockets"]:
            target["images"][socket_name].pack()
            target["material"].node_tree.nodes.remove(target["nodes"][socket_name])
            wire_baked_channel(target["material"], socket_name, target["images"][socket_name])
        entry = report.setdefault(target["original"], {"channels": target["sockets"], "objects": 0, "sizes": set()})
        entry["objects"] += 1
        entry["sizes"].add(target["size"])


def bake_warped_images():
    """Bakes the channels the exporter drops because of their texture coordinates (a blend of two UV mappings by
    Object-space noise, Object or Generated coordinates, Box projection) to images on a unique UV layer (#2766)."""
    warped = warped_channels_by_material()
    report = {}
    if not warped:
        return report
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 1
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    users = [
        candidate for candidate in bpy.context.view_layer.objects
        if candidate.type == "MESH" and candidate.visible_get() and not candidate.hide_render
        and any(slot.material is not None and slot.material.name in warped for slot in candidate.material_slots)
    ]
    for candidate in users:
        bake_object_warped_slots(candidate, warped, report)
    return report


original_material_names = {material.name for material in bpy.data.materials if material.users > 0}
image_baked = bake_warped_images()
baked = {material.name for material in to_bake}
for material_name in sorted(original_material_names):
    if material_name in image_baked:
        entry = image_baked[material_name]
        sizes = "/".join(str(size) for size in sorted(entry["sizes"]))
        print("MATERIAL baked", material_name, "(images:", ", ".join(entry["channels"]), "at", sizes, "px on", entry["objects"], "objects)")
        continue
    state = "baked" if material_name in baked else "graded" if material_name in graded else "approximated" if material_name in approximated else "kept"
    print("MATERIAL", state, material_name)
print("APPROXIMATED", len(approximated), "GRADED", len(graded), "BAKED", len(baked) + len(image_baked), "materials on", len(baked_objects), "objects, of", len(original_material_names))

# The published Classroom render lit the sun at strength 40, which the owner picked from previews at 15, 40 and 100 (#1083).
# The .blend ships it at 15 (energy 1 times an Emission strength of 15 in the light's node tree), and the glTF exporter
# writes their product, so the export sets energy 40 and Emission 1 to keep the README picture at its published brightness.
SUN_STRENGTH_BY_DEMO = {"classroom.blend": 40.0}
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




SKY_BAKE_WIDTH = 2048
SKY_BAKE_HEIGHT = 1024


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


bake_world_sky(output_directory)
join_realized_instances()
bpy.ops.export_scene.gltf(
    filepath=output_directory + "/scene.glb", export_format="GLB", export_apply=True, export_gpu_instances=True,
    export_image_format="JPEG", export_jpeg_quality=85, export_cameras=False, export_lights=True,
    export_import_convert_lighting_mode="COMPAT", export_vertex_color="MATERIAL",
    use_renderable=True, use_visible=True, export_yup=True, export_texcoords=True, export_normals=True,
)
print("EXPORTED")
