import bpy, sys, os, math, random
LIB = os.path.expanduser('~/Documents/social/assets-lib')
OUT = sys.argv[sys.argv.index('--') + 1]
KIND = sys.argv[sys.argv.index('--') + 2]
random.seed(7)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def place(model, loc, rot=0.0, scale=1.0):
    before = set(bpy.data.objects)
    import glob
    path = glob.glob(f'{LIB}/models/{model}/{model}_*k.gltf')[0]
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    holder = bpy.data.objects.new(model + '_at', None)
    bpy.context.scene.collection.objects.link(holder)
    holder.location = loc
    holder.rotation_euler = (0, 0, rot)
    holder.scale = (scale, scale, scale)
    for o in new:
        if o.parent is None or o.parent not in new:
            o.parent = holder

def ground(texture, size, tiles):
    bpy.ops.mesh.primitive_plane_add(size=size)
    plane = bpy.context.object
    plane.name = 'ground'
    for uv in plane.data.uv_layers[0].data:
        uv.uv = (uv.uv[0] * tiles, uv.uv[1] * tiles)
    mat = bpy.data.materials.new('ground_mat')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes['Principled BSDF']
    def image(suffix, colorspace):
        node = nodes.new('ShaderNodeTexImage')
        node.image = bpy.data.images.load(f'{LIB}/textures/{texture}/{texture}_{suffix}_2k.jpg')
        node.image.colorspace_settings.name = colorspace
        return node
    links.new(image('diff', 'sRGB').outputs['Color'], bsdf.inputs['Base Color'])
    links.new(image('rough', 'Non-Color').outputs['Color'], bsdf.inputs['Roughness'])
    normal_map = nodes.new('ShaderNodeNormalMap')
    links.new(image('nor_gl', 'Non-Color').outputs['Color'], normal_map.inputs['Color'])
    links.new(normal_map.outputs['Normal'], bsdf.inputs['Normal'])
    plane.data.materials.append(mat)

reset()
if KIND == 'nature':
    ground('aerial_grass_rock', 300, 150)
    place('boulder_01', (1.8, 0.2, 0), 0.8, 1.0)
    place('rock_07', (-1.6, 0.4, 0), 2.0, 0.9)
    place('rock_07', (3.8, -0.5, 0), 4.0, 0.7)
    place('dead_tree_trunk_02', (-1.0, -0.8, 0), 1.0, 1.0)
    place('shrub_01', (0.6, -0.6, 0), 0.5, 1.0)
    place('shrub_01', (3, -0.5, 0), 2.5, 1.0)
    for i in range(7):
        place('fern_02', (random.uniform(-2.5, 2.5), random.uniform(-1, 3), 0), random.uniform(0, 6.28), random.uniform(1.2, 2.0))
    for i in range(10):
        place('grass_medium_01', (random.uniform(-3, 3), random.uniform(-1.5, 3.5), 0), random.uniform(0, 6.28), random.uniform(1.2, 2.2))
    place('moss_01', (0.5, 1.2, 0), 0.3, 1.5)
elif KIND == 'film':
    ground('forest_ground_04', 300, 200)
    place('stone_fire_pit', (0, 0, 0), 0.0, 1.0)
    place('tree_stump_01', (1.3, 0.5, 0), 1.0, 0.6)
    place('wooden_bucket_01', (-1.0, 0.6, 0), 0.5, 1.0)
    place('treasure_chest', (-1.5, -0.9, 0), 0.6, 0.9)
    place('wooden_lantern_01', (1.3, 0.5, 0.17), 0.0, 0.8)
    place('rock_07', (4, -2, 0), 2.0, 1.0)
    place('shrub_01', (-4.5, 3.0, 0), 0.5, 1.4)
elif KIND == 'modeling':
    place('wooden_table_02', (0, 0, 0), 0.0, 1.0)
    place('vintage_oil_lamp', (0, 0, 0.78), 0.4, 1.0)
    place('wooden_lantern_01', (0.45, -0.15, 0.78), 0.8, 1.0)
    place('tea_set_01', (-0.5, 0.1, 0.78), 0.0, 1.0)
for img in bpy.data.images:
    if img.size[0] > 1024:
        img.scale(1024, 1024)
if KIND == 'clock':
    place('treasure_chest', (0, 0, 0))
for img in bpy.data.images:
    pass
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_image_format='JPEG', export_jpeg_quality=80, export_yup=True, export_apply=True)
print('EXPORTED', OUT, os.path.getsize(OUT))
