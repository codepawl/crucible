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


if __name__ == "__main__":
    unittest.main()
