import importlib.util
import json
import os
import shutil
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPOSITORY_ROOT / "scripts" / "blender-demo-to-glb.py"


def load_exporter_module():
    spec = importlib.util.spec_from_file_location("blender_demo_to_glb", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXPORTER = load_exporter_module()


class MockSocketDict:
    def __init__(self, pairs):
        self._items = list(pairs)
        self._by_name = dict(self._items)

    def __iter__(self):
        return (socket for _, socket in self._items)

    def __contains__(self, key):
        return key in self._by_name

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._items[key][1]
        return self._by_name[key]

    def get(self, key, default=None):
        return self._by_name.get(key, default)


class MockSocket:
    def __init__(self, node, name):
        self.node = node
        self.name = name
        self.links = []
        self.default_value = (1.0, 1.0, 1.0, 1.0)
        self.enabled = True

    @property
    def is_linked(self):
        return len(self.links) > 0


class MockLink:
    def __init__(self, from_socket, to_socket):
        self.from_socket = from_socket
        self.from_node = from_socket.node
        self.to_socket = to_socket
        self.to_node = to_socket.node


class MockNode:
    def __init__(self, node_type, input_names=(), output_names=(), **attributes):
        self.type = node_type
        self.inputs = MockSocketDict((name, MockSocket(self, name)) for name in input_names)
        self.outputs = MockSocketDict((name, MockSocket(self, name)) for name in output_names)
        for key, value in attributes.items():
            setattr(self, key, value)


class MockTree:
    def __init__(self, nodes):
        self.nodes = nodes


class MockMaterial:
    def __init__(self, name, nodes):
        self.name = name
        self.use_nodes = True
        self.node_tree = MockTree(nodes)


def connect(from_node, from_name, to_node, to_name):
    from_socket = from_node.outputs[from_name]
    to_socket = to_node.inputs[to_name]
    link = MockLink(from_socket, to_socket)
    from_socket.links.append(link)
    to_socket.links.append(link)


def make_principled():
    return MockNode("BSDF_PRINCIPLED", input_names=("Base Color", "Roughness", "Normal"), output_names=("BSDF",))


def find_blender_executable():
    configured = os.environ.get("BLENDER")
    if configured and Path(configured).exists():
        return configured
    for candidate in (
        Path(r"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe"),
        Path(r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"),
        shutil.which("blender"),
    ):
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


class ChannelAnalysisTests(unittest.TestCase):
    def test_plain_uv_channels_are_kept(self):
        principled = make_principled()
        uv_coord = MockNode("TEX_COORD", output_names=("UV", "Object", "Generated"))
        color_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        reroute = MockNode("REROUTE", input_names=("Input",), output_names=("Output",))
        rough_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        sep_color = MockNode("SEPARATE_COLOR", input_names=("Color",), output_names=("Red", "Green", "Blue"), mode="RGB")
        normal_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        normal_map = MockNode("NORMAL_MAP", input_names=("Strength", "Color"), output_names=("Normal",), space="TANGENT")

        connect(uv_coord, "UV", color_tex, "Vector")
        connect(color_tex, "Color", reroute, "Input")
        connect(reroute, "Output", principled, "Base Color")
        connect(rough_tex, "Color", sep_color, "Color")
        connect(sep_color, "Green", principled, "Roughness")
        connect(normal_tex, "Color", normal_map, "Color")
        connect(normal_map, "Normal", principled, "Normal")

        material = MockMaterial("PlainWall", [principled, uv_coord, color_tex, reroute, rough_tex, sep_color, normal_tex, normal_map])
        self.assertEqual(EXPORTER.channels_to_bake(material), [])
        self.assertFalse(EXPORTER.base_color_from_nodes(material))

    def test_mapping_box_and_object_coords_require_image_bake(self):
        principled = make_principled()
        uv_coord = MockNode("TEX_COORD", output_names=("UV", "Object", "Generated"))
        mapping = MockNode("MAPPING", input_names=("Vector",), output_names=("Vector",))
        mapped_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        box_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="BOX")
        gen_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        normal_map = MockNode("NORMAL_MAP", input_names=("Strength", "Color"), output_names=("Normal",), space="TANGENT")

        connect(uv_coord, "UV", mapping, "Vector")
        connect(mapping, "Vector", mapped_tex, "Vector")
        connect(mapped_tex, "Color", principled, "Base Color")
        connect(box_tex, "Color", principled, "Roughness")
        connect(uv_coord, "Generated", gen_tex, "Vector")
        connect(gen_tex, "Color", normal_map, "Color")
        connect(normal_map, "Normal", principled, "Normal")

        material = MockMaterial("MappedMaterial", [principled, uv_coord, mapping, mapped_tex, box_tex, gen_tex, normal_map])
        self.assertEqual(EXPORTER.channels_to_bake(material), ["Base Color", "Roughness", "Normal"])

    def test_wall_stain_mix_and_bump_require_image_bake(self):
        principled = make_principled()
        plaster = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="FLAT")
        tex_coord = MockNode("TEX_COORD", output_names=("UV", "Object"))
        noise = MockNode("TEX_NOISE", input_names=("Vector",), output_names=("Fac",))
        mix = MockNode("MIX", input_names=("Factor", "A", "B"), output_names=("Result",), data_type="RGBA", blend_type="MULTIPLY")
        bump = MockNode("BUMP", input_names=("Height",), output_names=("Normal",))

        connect(tex_coord, "Object", noise, "Vector")
        connect(noise, "Fac", mix, "Factor")
        connect(plaster, "Color", mix, "A")
        connect(mix, "Result", principled, "Base Color")
        connect(noise, "Fac", bump, "Height")
        connect(bump, "Normal", principled, "Normal")

        material = MockMaterial("WallStain", [principled, plaster, tex_coord, noise, mix, bump])
        self.assertEqual(EXPORTER.channels_to_bake(material), ["Base Color", "Normal"])
        self.assertTrue(EXPORTER.uses_object_or_world_space(material, ["Base Color", "Normal"]))

    def test_per_island_color_ramp_stays_vertex_color_bake(self):
        principled = make_principled()
        geometry = MockNode("NEW_GEOMETRY", output_names=("Position", "Random Per Island"))
        ramp = MockNode("VALTORGB", input_names=("Fac",), output_names=("Color",))
        connect(geometry, "Random Per Island", ramp, "Fac")
        connect(ramp, "Color", principled, "Base Color")

        material = MockMaterial("RoofTiles", [principled, geometry, ramp])
        self.assertEqual(EXPORTER.channels_to_bake(material), [])
        self.assertTrue(EXPORTER.base_color_from_nodes(material))

    def test_constant_tint_only_grades_plain_uv_images(self):
        principled = make_principled()
        box_tex = MockNode("TEX_IMAGE", input_names=("Vector",), output_names=("Color",), image=object(), projection="BOX")
        hue_sat = MockNode("HUE_SAT", input_names=("Hue", "Saturation", "Value", "Fac", "Color"), output_names=("Color",))
        hue_sat.inputs["Hue"].default_value = 0.5
        hue_sat.inputs["Saturation"].default_value = 0.8
        hue_sat.inputs["Value"].default_value = 0.9
        hue_sat.inputs["Fac"].default_value = 1.0
        connect(box_tex, "Color", hue_sat, "Color")
        connect(hue_sat, "Color", principled, "Base Color")

        box_material = MockMaterial("BoxTinted", [principled, box_tex, hue_sat])
        self.assertIsNone(EXPORTER.graded_image_chain(box_material))
        self.assertEqual(EXPORTER.channels_to_bake(box_material), ["Base Color"])

        box_tex.projection = "FLAT"
        self.assertIsNotNone(EXPORTER.graded_image_chain(box_material))

    def test_bake_resolution_scales_with_area_and_upstream_image(self):
        self.assertEqual(EXPORTER.compute_bake_resolution(0.25, 0, "Base Color"), 256)
        self.assertEqual(EXPORTER.compute_bake_resolution(4.0, 0, "Base Color"), 512)
        self.assertEqual(EXPORTER.compute_bake_resolution(16.0, 1024, "Base Color"), 1024)
        self.assertEqual(EXPORTER.compute_bake_resolution(16.0, 2048, "Roughness"), 1024)


class BlenderHeadlessBakeSmokeTests(unittest.TestCase):
    def test_synthesized_scene_bakes_procedural_mapped_materials_without_clobbering_kept_images(self):
        blender = find_blender_executable()
        if blender is None:
            self.skipTest("Blender executable not installed locally")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            blend_file = temp_path / "demo.blend"
            out_dir = temp_path / "export"
            out_dir.mkdir()
            build_script = temp_path / "build_scene.py"
            build_script.write_text(
                f"""
import bpy

bpy.ops.wm.read_factory_settings(use_empty=True)

# 1. Wall with plaster image + Object-coord Noise stain + Bump normal + Noise roughness, sharing mesh with KeptWood
bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, 0.0))
wall_cube = bpy.context.active_object
wall_cube.name = "WallCube"

kept_img = bpy.data.images.new("kept_wood_img", 16, 16)
kept_img.pixels[:] = [0.15, 0.35, 0.65, 1.0] * (16 * 16)
kept_img.pack()

kept_mat = bpy.data.materials.new("KeptWood")
kept_tree = kept_mat.node_tree
kept_bsdf = next(node for node in kept_tree.nodes if node.type == "BSDF_PRINCIPLED")
kept_tex = kept_tree.nodes.new("ShaderNodeTexImage")
kept_tex.image = kept_img
kept_tree.links.new(kept_tex.outputs["Color"], kept_bsdf.inputs["Base Color"])
kept_tree.nodes.active = kept_tex

plaster_img = bpy.data.images.new("wall_plaster", 32, 32)
plaster_img.pixels[:] = [0.85, 0.80, 0.72, 1.0] * (32 * 32)
plaster_img.pack()

stain_mat = bpy.data.materials.new("WallStain")
stain_tree = stain_mat.node_tree
stain_bsdf = next(node for node in stain_tree.nodes if node.type == "BSDF_PRINCIPLED")
stain_tex = stain_tree.nodes.new("ShaderNodeTexImage")
stain_tex.image = plaster_img
tex_coord = stain_tree.nodes.new("ShaderNodeTexCoord")
noise = stain_tree.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 3.0
stain_tree.links.new(tex_coord.outputs["Object"], noise.inputs["Vector"])
ramp = stain_tree.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position = 0.35
ramp.color_ramp.elements[1].position = 0.65
mix = stain_tree.nodes.new("ShaderNodeMix")
mix.data_type = "RGBA"
mix.blend_type = "MULTIPLY"
mix.inputs["B"].default_value = (0.18, 0.14, 0.10, 1.0)
stain_tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
stain_tree.links.new(ramp.outputs["Color"], mix.inputs["Factor"])
stain_tree.links.new(stain_tex.outputs["Color"], mix.inputs["A"])
stain_tree.links.new(mix.outputs["Result"], stain_bsdf.inputs["Base Color"])

stain_tree.links.new(noise.outputs["Fac"], stain_bsdf.inputs["Roughness"])
bump = stain_tree.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.4
stain_tree.links.new(noise.outputs["Fac"], bump.inputs["Height"])
stain_tree.links.new(bump.outputs["Normal"], stain_bsdf.inputs["Normal"])

wall_cube.data.materials.append(stain_mat)
wall_cube.data.materials.append(kept_mat)
for index, poly in enumerate(wall_cube.data.polygons):
    poly.material_index = 0 if index < 4 else 1

# 2. Box-projected stone block with Mapping node
bpy.ops.mesh.primitive_cube_add(size=1.5, location=(3.5, 0.0, 0.0))
box_cube = bpy.context.active_object
box_cube.name = "BoxStoneCube"
stone_img = bpy.data.images.new("stone_box_img", 32, 32)
stone_img.pixels[:] = [0.4, 0.42, 0.44, 1.0] * (32 * 32)
stone_img.pack()
box_mat = bpy.data.materials.new("BoxStone")
box_tree = box_mat.node_tree
box_bsdf = next(node for node in box_tree.nodes if node.type == "BSDF_PRINCIPLED")
box_tex = box_tree.nodes.new("ShaderNodeTexImage")
box_tex.image = stone_img
box_tex.projection = "BOX"
box_coord = box_tree.nodes.new("ShaderNodeTexCoord")
mapping = box_tree.nodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (2.0, 2.0, 2.0)
box_tree.links.new(box_coord.outputs["Generated"], mapping.inputs["Vector"])
box_tree.links.new(mapping.outputs["Vector"], box_tex.inputs["Vector"])
box_tree.links.new(box_tex.outputs["Color"], box_bsdf.inputs["Base Color"])
box_cube.data.materials.append(box_mat)

# 3. Roof tile with Random Per Island ColorRamp + kept normal map
bpy.ops.mesh.primitive_plane_add(size=2.0, location=(-3.5, 0.0, 0.0))
roof_plane = bpy.context.active_object
roof_plane.name = "RoofPlane"
roof_mat = bpy.data.materials.new("RoofTiles")
roof_tree = roof_mat.node_tree
roof_bsdf = next(node for node in roof_tree.nodes if node.type == "BSDF_PRINCIPLED")
geom = roof_tree.nodes.new("ShaderNodeNewGeometry")
roof_ramp = roof_tree.nodes.new("ShaderNodeValToRGB")
roof_ramp.color_ramp.elements[0].color = (0.35, 0.18, 0.10, 1.0)
roof_tree.links.new(geom.outputs["Random Per Island"], roof_ramp.inputs["Fac"])
roof_tree.links.new(roof_ramp.outputs["Color"], roof_bsdf.inputs["Base Color"])
roof_nor_img = bpy.data.images.new("roof_nor", 16, 16)
roof_nor_img.colorspace_settings.name = "Non-Color"
roof_nor_img.pixels[:] = [0.5, 0.5, 1.0, 1.0] * (16 * 16)
roof_nor_img.pack()
roof_nor_tex = roof_tree.nodes.new("ShaderNodeTexImage")
roof_nor_tex.image = roof_nor_img
roof_nor_map = roof_tree.nodes.new("ShaderNodeNormalMap")
roof_tree.links.new(roof_nor_tex.outputs["Color"], roof_nor_map.inputs["Color"])
roof_tree.links.new(roof_nor_map.outputs["Normal"], roof_bsdf.inputs["Normal"])
roof_plane.data.materials.append(roof_mat)

# 4. Legacy Cycles Diffuse material
bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0.0, 3.5, 0.0))
cloth_plane = bpy.context.active_object
cloth_plane.name = "ClothPlane"
cloth_mat = bpy.data.materials.new("LegacyCloth")
cloth_tree = cloth_mat.node_tree
cloth_tree.nodes.clear()
cloth_out = cloth_tree.nodes.new("ShaderNodeOutputMaterial")
cloth_diff = cloth_tree.nodes.new("ShaderNodeBsdfDiffuse")
cloth_img = bpy.data.images.new("cloth_img", 16, 16)
cloth_img.pixels[:] = [0.7, 0.2, 0.2, 1.0] * (16 * 16)
cloth_img.pack()
cloth_tex = cloth_tree.nodes.new("ShaderNodeTexImage")
cloth_tex.image = cloth_img
cloth_tree.links.new(cloth_tex.outputs["Color"], cloth_diff.inputs["Color"])
cloth_tree.links.new(cloth_diff.outputs["BSDF"], cloth_out.inputs["Surface"])
cloth_plane.data.materials.append(cloth_mat)

bpy.ops.wm.save_as_mainfile(filepath=r"{blend_file}")
""",
                encoding="utf-8",
            )

            create_result = subprocess.run(
                [blender, "-b", "--factory-startup", "--python", str(build_script)],
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(create_result.returncode, 0)

            verify_script = temp_path / "run_and_verify.py"
            verify_script.write_text(
                f"""
import sys
import bpy

argv_before = sys.argv
sys.argv = ["blender", "--", r"{out_dir}"]
with open(r"{SCRIPT_PATH}", "r", encoding="utf-8") as handle:
    code = compile(handle.read(), r"{SCRIPT_PATH}", "exec")
namespace = {{"__name__": "__main__", "__file__": r"{SCRIPT_PATH}"}}
exec(code, namespace)

kept_img = bpy.data.images["kept_wood_img"]
print("KEPT_PIXEL_CHECK", round(kept_img.pixels[0], 3), round(kept_img.pixels[1], 3), round(kept_img.pixels[2], 3))
""",
                encoding="utf-8",
            )

            export_result = subprocess.run(
                [blender, "-b", str(blend_file), "--disable-autoexec", "--python", str(verify_script)],
                capture_output=True,
                text=True,
                check=True,
            )
            stdout = export_result.stdout
            self.assertIn("MATERIAL baked WallStain", stdout)
            self.assertIn("BAKED_CHANNELS WallStain Base Color,Roughness,Normal", stdout)
            self.assertIn("MATERIAL baked BoxStone", stdout)
            self.assertIn("MATERIAL baked RoofTiles", stdout)
            self.assertIn("MATERIAL kept KeptWood", stdout)
            self.assertIn("MATERIAL approximated LegacyCloth", stdout)
            self.assertIn("KEPT_PIXEL_CHECK 0.149 0.349 0.651", stdout)
            self.assertIn("EXPORTED", stdout)

            glb_path = out_dir / "scene.glb"
            self.assertTrue(glb_path.exists())
            raw = glb_path.read_bytes()
            json_length = struct.unpack_from("<I", raw, 12)[0]
            gltf = json.loads(raw[20:20 + json_length].decode("utf-8"))
            materials_by_name = {entry["name"]: entry for entry in gltf["materials"]}

            wall_material = materials_by_name["WallStain"]
            self.assertIn("baseColorTexture", wall_material["pbrMetallicRoughness"])
            self.assertIn("metallicRoughnessTexture", wall_material["pbrMetallicRoughness"])
            self.assertIn("normalTexture", wall_material)

            box_material = materials_by_name["BoxStone"]
            self.assertIn("baseColorTexture", box_material["pbrMetallicRoughness"])

            roof_material = materials_by_name["RoofTiles"]
            self.assertIn("normalTexture", roof_material)

            kept_material = materials_by_name["KeptWood"]
            self.assertIn("baseColorTexture", kept_material["pbrMetallicRoughness"])


if __name__ == "__main__":
    unittest.main()
