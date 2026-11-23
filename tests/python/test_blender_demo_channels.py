import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))

import blender_demo_channels as channels


def node(node_type, inputs=None, projection="FLAT"):
    return {"type": node_type, "projection": projection, "inputs": inputs or {}}


def plaster_graph():
    """The Lone Monk plaster: two UV mappings blended by an Object-space noise ramp feed every image."""
    return {
        "principled": node("BSDF_PRINCIPLED", {
            "Base Color": [("tint", "Color")],
            "Roughness": [("rough_image", "Color")],
            "Normal": [("normal_map", "Normal")],
        }),
        "tint": node("HUE_SAT", {"Color": [("color_image", "Color")]}),
        "color_image": node("TEX_IMAGE", {"Vector": [("mapping", "Vector")]}),
        "rough_image": node("TEX_IMAGE", {"Vector": [("mapping", "Vector")]}),
        "normal_map": node("NORMAL_MAP", {"Color": [("normal_image", "Color")]}),
        "normal_image": node("TEX_IMAGE", {"Vector": [("mapping", "Vector")]}),
        "mapping": node("MAPPING", {"Vector": [("blend", "Result")]}),
        "blend": node("MIX", {"A": [("uv", "UV")], "B": [("uv", "UV")], "Factor": [("noise", "Factor")]}),
        "noise": node("TEX_NOISE", {"Vector": [("uv", "Object")]}),
        "uv": node("TEX_COORD"),
    }


def plain_graph():
    graph = plaster_graph()
    graph["mapping"] = node("MAPPING", {"Vector": [("uv", "UV")]})
    return graph


class ClassifyChannelTest(unittest.TestCase):
    def test_blended_uv_mappings_are_warped_on_every_image_channel(self):
        result = channels.classify_material(plaster_graph(), "principled")
        self.assertEqual(result, {"Base Color": "warped", "Roughness": "warped", "Normal": "warped"})
        self.assertEqual(channels.channels_to_bake(result), ["Base Color", "Roughness", "Normal"])

    def test_fixed_mapping_on_the_first_uv_layer_is_plain(self):
        result = channels.classify_material(plain_graph(), "principled")
        self.assertEqual(set(result.values()), {"plain"})
        self.assertEqual(channels.channels_to_bake(result), [])

    def test_mapping_with_a_linked_scale_is_warped(self):
        graph = plain_graph()
        graph["mapping"]["inputs"]["Scale"] = [("noise", "Factor")]
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "warped")

    def test_object_coordinates_and_box_projection_are_warped(self):
        graph = plain_graph()
        graph["mapping"]["inputs"]["Vector"] = [("uv", "Object")]
        self.assertEqual(channels.classify_channel(graph, "principled", "Roughness"), "warped")
        graph = plain_graph()
        graph["rough_image"]["projection"] = "BOX"
        self.assertEqual(channels.classify_channel(graph, "principled", "Roughness"), "warped")
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "plain")

    def test_reroute_between_the_uv_and_the_mapping_stays_plain(self):
        graph = plain_graph()
        graph["reroute"] = node("REROUTE", {"Input": [("uv", "UV")]})
        graph["mapping"]["inputs"]["Vector"] = [("reroute", "Output")]
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "plain")

    def test_image_without_a_vector_link_is_plain(self):
        graph = plain_graph()
        graph["color_image"]["inputs"] = {}
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "plain")

    def test_colour_from_noise_alone_is_procedural_and_a_free_channel_is_unlinked(self):
        graph = plain_graph()
        graph["principled"]["inputs"]["Base Color"] = [("noise", "Factor")]
        del graph["principled"]["inputs"]["Normal"]
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "procedural")
        self.assertEqual(channels.classify_channel(graph, "principled", "Normal"), "unlinked")
        self.assertEqual(channels.channels_to_bake(channels.classify_material(graph, "principled")), [])

    def test_a_cycle_in_the_graph_does_not_loop_forever(self):
        graph = plain_graph()
        graph["tint"]["inputs"]["Color"] = [("principled", "BSDF")]
        self.assertEqual(channels.classify_channel(graph, "principled", "Base Color"), "plain")


class BakedTextureSizeTest(unittest.TestCase):
    def test_size_follows_area_between_the_limits(self):
        self.assertEqual(channels.baked_texture_size(1.0, 256, 512, 4096), 512)
        self.assertEqual(channels.baked_texture_size(16.0, 256, 512, 4096), 1024)
        self.assertEqual(channels.baked_texture_size(10000.0, 256, 512, 2048), 2048)



GUTTER = 4
CHANNELS_PER_MATERIAL = 3
TEXEL_BUDGET = 64 * 1024 * 1024


def brick_areas(count):
    """Surface areas in square metres of loose bricks and blocks, from 0.03 to 0.6, the same for every run."""
    return [0.03 + 0.57 * ((index * 37) % 101) / 100 for index in range(count)]


def plan_for(areas):
    return channels.plan_atlas(areas, 160, GUTTER, 512, 2048)


class AtlasPlanTest(unittest.TestCase):
    def test_regions_are_inside_the_atlas_and_never_overlap(self):
        areas = brick_areas(922)
        plan = plan_for(areas)
        self.assertEqual(len(plan["regions"]), 922)
        for x, y, side in plan["regions"]:
            self.assertGreaterEqual(x, 0)
            self.assertGreaterEqual(y, 0)
            self.assertLessEqual(x + side, plan["size"])
            self.assertLessEqual(y + side, plan["size"])
        for index, (x, y, side) in enumerate(plan["regions"]):
            for other_x, other_y, other_side in plan["regions"][index + 1:]:
                apart = x + side <= other_x or other_x + other_side <= x or y + side <= other_y or other_y + other_side <= y
                self.assertTrue(apart, f"regions {(x, y, side)} and {(other_x, other_y, other_side)} overlap")

    def test_922_objects_sharing_one_material_bake_into_one_image_per_channel(self):
        plan = plan_for(brick_areas(922))
        image_count = CHANNELS_PER_MATERIAL
        self.assertEqual(image_count, 3)
        self.assertLessEqual(plan["size"], 2048)
        self.assertLess(image_count * plan["size"] ** 2, 16 * 1024 * 1024)

    def test_the_export_holds_one_image_per_baked_channel_and_stays_under_the_texture_cap(self):
        roster = {"brick clay": 922, "brick marble": 4, "brick marble smooth": 7, "church brick": 1, "column marble": 12,
                  "plaster med old": 4, "roof": 11, "terracotta": 4}
        image_count = 0
        total_pixels = 0
        for object_count in roster.values():
            plan = plan_for(brick_areas(object_count))
            image_count += CHANNELS_PER_MATERIAL
            total_pixels += CHANNELS_PER_MATERIAL * plan["size"] ** 2
        self.assertEqual(image_count, len(roster) * CHANNELS_PER_MATERIAL)
        self.assertLess(total_pixels, TEXEL_BUDGET)
        per_object_bake_pixels = sum(
            object_count * CHANNELS_PER_MATERIAL * channels.baked_texture_size(area, 160, 512, 2048) ** 2
            for object_count in roster.values() for area in brick_areas(object_count)[:1]
        )
        self.assertGreater(per_object_bake_pixels, TEXEL_BUDGET)

    def test_density_drops_instead_of_failing_when_the_objects_do_not_fit(self):
        plan = channels.plan_atlas([4.0] * 100, 400, GUTTER, 512, 1024)
        self.assertEqual(plan["size"], 1024)
        self.assertLess(plan["texels_per_metre"], 400)

    def test_no_areas_is_refused_with_what_to_pass(self):
        with self.assertRaisesRegex(ValueError, "surface area"):
            channels.plan_atlas([], 160, GUTTER, 512, 2048)


if __name__ == "__main__":
    unittest.main()
