# Material maps

`CrucibleRenderer` supports five texture channels on standard metallic/roughness materials.
Each channel uses an image descriptor. All channels sample `geometry.uvs`, which contains two finite values per vertex.

```js
const colorTexture = { image: colorImage, colorSpace: 'srgb' };
const surfaceTexture = { image: packedImage, colorSpace: 'linear' };
const material = {
  color: [1, 1, 1],
  metallic: 0.8,
  roughness: 0.6,
  emission: 1,
  emissiveColor: [0.1, 0.2, 0.3],
  map: colorTexture,
  normalMap: { image: normalImage, colorSpace: 'linear' },
  normalScale: [1, 1],
  metallicRoughnessMap: surfaceTexture,
  occlusionMap: surfaceTexture,
  occlusionStrength: 0.7,
  emissiveMap: { image: emissionImage, colorSpace: 'srgb' },
};
```

The packed image can contain occlusion in R, roughness in G, and metallic in B.
The renderer applies the following channel rules from the [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials).

| Field | Input | Effect |
| --- | --- | --- |
| `map` | sRGB by default, or explicit linear RGB | Multiplies the linear base color and vertex tint. |
| `normalMap` | Explicit linear RGB | Decodes tangent-space XYZ from `[0, 1]` to `[-1, 1]`. |
| `metallicRoughnessMap` | Explicit linear RGB | Multiplies roughness by G and metallic by B. |
| `occlusionMap` | Explicit linear RGB | Uses R to attenuate indirect lighting. |
| `emissiveMap` | sRGB | Multiplies linear `emissiveColor * emission`. |

WebGL sRGB texture storage decodes color maps before shading. Data maps use linear texture storage.
Occlusion uses `mix(1, R, occlusionStrength)`. It does not attenuate direct lights or emission.
Roughness retains the renderer's minimum of `0.075` and derivative-based specular filtering.

`normalScale` contains two finite floats for X and Y. Negative values can invert either tangent axis.
A geometry with `tangents`, a `Float32Array` of four values per vertex (x, y, z, handedness 1 or -1), shades its normal map with them. They follow glTF: the bitangent is `cross(normal, tangent) * handedness` and points up the image, against the glTF v axis, which runs down it. The tangent is transformed with the model and joint matrices, made perpendicular to the final normal, and its handedness flips on a mirrored node. A part with `tangents` and a `normalMap` is drawn by a program with the `tangents` feature, which reads the tangent from the fourth float of the normal attribute (no extra vertex attribute). A geometry whose `tangents` length does not match its vertices is refused with what to pass.

The glTF loader fills `geometry.tangents` for every primitive with a normal map: it reads `TANGENT` when the file has it, and otherwise generates tangents from the UVs the map samples (a unit tangent per triangle, weighted by the corner angle, summed per vertex and made perpendicular to the normal, the MikkTSpace method on a mesh already split at UV seams; it matches meshoptimizer's `Compatible` tangents in the test). A `TANGENT` that is not four finite values per vertex, or that a rotated or mirrored `KHR_texture_transform` no longer fits, is replaced by generated tangents with a note in `warnings`. A Draco `TANGENT` is regenerated. A primitive without the UVs the map samples carries no tangents.

A normal map can hold detail finer than a pixel, such as the one-texel bevel around a mapped sphere. Besides widening the roughness, a shader with a normal map scales the direct specular by `1 / (1 + 32 * w + (w / 0.05)^3)`, where `w = specularAntiAliasing * v` and `v` is the variance of the shading normal across the pixel plus 100 times the spread of the normals under the pixel. That spread is measured at upload, from the full-resolution texels, for every mip level of a normal map (one minus the mean length of the unit normals a level averages) and stored in the alpha channel of that level (`src/normal-map-variance.js`), because the 8-bit colour of a mip cannot show it. Baking a 2048 by 2048 map takes about 0.3 s on the CPU plus a read-back of its base level, and adds no memory. A precompressed map, or one changed with `updateTexture`, has no baked spread and keeps the previous behaviour; the alpha of a normal map is not otherwise used. The roughness widening still comes from the stored normal length only. Sub-pixel detail then averages out instead of lighting one pixel per light along the silhouette. The cubic term is negligible for the variance of an interior highlight (about 0.015, under 2 percent of the specular) and closes the fade where the normal turns fast across a pixel, as it does at a silhouette (variance 0.05 and more), where the linear term alone left a bright pixel. `specularAntiAliasing: 0` switches it off with the widening. A material without a normal map has the same shader text as before.

Without `tangents` (recipe meshes, box-mapped materials, a primitive without UVs) the renderer derives an orthogonal tangent basis from position and UV screen derivatives, including mirrored UV handedness. Degenerate UVs retain the geometric normal because they have no tangent basis. Derivative tangents differ from authored tangent bases on curved meshes, which is why a map baked in MikkTSpace wants `tangents`. The path tracers still use their own frame.

## Descriptors and batching

A descriptor contains `image`, `uvChannel`, `colorSpace`, `flipY`, `wrapS`, `wrapT`, `minFilter`, and `magFilter`.
`uvChannel` defaults to zero. `flipY` defaults to false.

Sampler fields use WebGL enum values. Wrapping supports repeat, clamp-to-edge, and mirrored repeat.
Magnification supports nearest and linear. Minification also supports all four mipmap filters.
A texture whose magnification or minification is nearest stays hard-edged: anisotropic filtering, which would blur it, is applied only to textures that filter linearly in both directions.

That filtering is 16x by default, or the GPU limit when that is lower, so a floor or table seen at a few degrees keeps its grain (#2836). `new CrucibleRenderer(canvas, parts, { maxAnisotropy: 4 })`, or `"renderer": { "maxAnisotropy": 4 }` in a scene file, lowers it for a slower GPU; `1` turns it off. The level is read when a texture is uploaded, so set it at construction.

Descriptor identity determines GPU texture reuse. Repeated parts can share descriptors without duplicating GPU textures or texture-budget charges.
Different descriptors allocate separately even when they reference the same decoded image.
Every channel and its mipmaps contributes to `textureBytes` and the render memory plan.

A batch groups geometry identity, all five map identities, `normalScale` values, `occlusionStrength`, `moss` and `mossColor`.
The renderer uses batch uniforms for scale and strength because its instance attributes fill the 16 vertex attribute slots Safari allows (it counts `gl_InstanceID` as one; `tests/shader-attribute-budget.test.js` fails when a variant goes over).
Changing any of these batch fields requires a new renderer. `updateParts()` rejects changes before uploading instance data.
Color, metallic, roughness, emission, emissive color, and transforms retain their existing update behavior.
Descriptors must remain unchanged while a renderer uses them. Image pixels change only through `updateTexture`.

Two API shapes were considered. A nested channel registry could carry arbitrary channel packing and transforms.
Named per-channel descriptors reuse the existing `material.map` contract and make channel semantics explicit.
The current API uses named descriptors. Arbitrary channel routing and texture transforms remain unsupported.

## Updating pixels

`renderer.updateTexture(descriptor, update)` replaces the pixels of a texture the renderer has already uploaded. It needs `import '@codepawlhq/crucible/addons/texture-update'`, so scenes that never update a texture do not carry the code.

```js
import '@codepawlhq/crucible/addons/texture-update';

renderer.updateTexture(descriptor);
renderer.updateTexture(descriptor, { image: video });
renderer.updateTexture(descriptor, { region: { x: 64, y: 32, width: 16, height: 16, data: rgbaBytes } });
```

Without `update`, the descriptor image uploads again. This suits a canvas that you draw on.
`image` replaces every pixel. It must have the same width and height as the uploaded texture.
`region` replaces one rectangle. `data` holds `width * height * 4` RGBA bytes as a `Uint8Array` or `Uint8ClampedArray`, top row first. `x` and `y` count from the top left of the image, and `flipY` is handled for you. Give `image` or `region`, not both.

Colour space, `flipY` and the unpack state follow the first upload. An `srgb` descriptor keeps sRGB storage, premultiplied alpha stays off, and the previous WebGL unpack state returns afterwards. A texture with mipmaps regenerates all of them after the upload, so a small region still costs one mipmap pass.

The size cannot change, because the texture memory is planned at construction. Compressed textures reject updates, since their mip levels come from the file. A descriptor that was never uploaded, a region outside the texture, or a data length that does not match throws an error that names the problem.
Update between two `render()` calls. The change shows on the next frame.

## glTF import and lifetime

`parseGltf()` and `loadGltf()` import base color, normal, metallic/roughness, occlusion, and emissive textures.
The importer preserves `normalTexture.scale`, `occlusionTexture.strength`, color spaces, samplers, and shared descriptor identities.
A texture reused for color and data receives separate descriptors with the appropriate color spaces.
Existing byte, resource, vertex, and combined image-pixel limits apply before decoding.
Invalid sampler values, texture indices, scales, or missing UVs fail before resources load.

1. Dispose the renderer before disposing its imported asset.
2. Call `asset.dispose()` to release decoded textures and images.

Renderer disposal deletes every cached GPU texture. Asset disposal closes each shared decoded image once.

## Alpha and double-sided materials

| Field | Default | Meaning |
| --- | --- | --- |
| `alphaMode` | `'opaque'` | `'opaque'`, `'mask'` (cutout), `'blend'` (translucent) or `'add'` (additive light). |
| `alphaCutoff` | `0.5` | Mask only. Fragments with alpha below it are discarded. |
| `opacity` | `1` | Multiplies the base map alpha. Ignored by `opaque`. For `blend` and `add` it is a per-part value that `updateParts` may change every frame. |
| `doubleSided` | `false` | Draws both faces and flips the normal on back faces so each side lights correctly. |

Final alpha is the base map alpha (when `material.map` is set) times `opacity`. Vertex colors stay RGB.

- `mask` discards below `alphaCutoff` in the color pass and in the shadow pass, so shadows follow the cutout shape. With MSAA the edge uses alpha-to-coverage, sharpened by `fwidth`, so leaf edges stay smooth.
- `blend` draws after all opaque and masked batches. Texels with alpha 1 (opacity 1) are drawn first as a cutout that writes depth, so an opaque baked mesh hides what lies behind it in any order; the translucent texels then blend with depth writes off. Batches sort back to front by their mean distance to the eye, and instances inside one batch sort by translation distance each frame. Intersecting translucent surfaces and large meshes can still show ordering artifacts. Blend parts skip shadows unless `castShadow: true` is set, and then they cast a fully opaque shadow.
- A `blend` part fades its diffuse body and what shows through it with opacity, but not its specular: lamp highlights and the reflected sky and probe keep the strength they have at opacity 1, as glTF says for a blended dielectric, except where the colour map's own alpha is below 1: that share of the specular is scaled by the texture alpha, so a texel the picture leaves transparent shows no reflection. The shader writes the colour premultiplied (the diffuse share times opacity plus the full specular) and blends with `ONE, ONE_MINUS_SRC_ALPHA`; opaque, `mask` and `add` parts are unchanged. Clear coat and sheen are not split out and fade with opacity.
- `add` draws after all opaque, masked and blend batches with blending `SRC_ALPHA, ONE`: the colour times opacity is added to the frame, so overlaps brighten and opacity 0 adds nothing. It tests depth, writes none, needs no sorting and skips shadows unless `castShadow: true` is set. Fog fades additive light to black instead of mixing it toward the fog colour, so distant sparks dim rather than glow as fog. Additive parts do not occlude bounce, sky-visibility or closed-room checks, like blend parts.
- `alphaMode`, `alphaCutoff`, `doubleSided` and, for `mask`, `opacity` are batch state like `castShadow`. Parts that differ never share a draw call, and `updateParts` rejects changes after upload. Rebuild the renderer to change them. The opacity of `blend` and `add` parts is stored per instance (the last float of each instance), so parts that differ only in opacity share one batch and `updateParts` changes it without a rebuild; a fading trail or particle needs one part, not one per opacity step.
- Invalid values (unknown mode, cutoff or opacity outside zero to one, a non-boolean `doubleSided`) throw.
- The benchmark preset ignores alpha.

glTF import maps `alphaMode` MASK and BLEND, `alphaCutoff`, `doubleSided` and `baseColorFactor[3]` (to `opacity`) onto these fields, and keeps the base color texture alpha. `exportGlb` writes them back. glTF has no additive blending, so an `add` material is exported as `BLEND` and loads back as `blend`.

## Retro look

 gives the PlayStation 1 look in the raster renderer:

\
| Field | Accepts | Does |
|---|---|---|
|  | , whole numbers from 16 to 4096 | Rounds each vertex to a width by height grid across the screen, so vertices jitter as the camera moves. |
|  |  | Interpolates texture coordinates without perspective correction, so textures swim on large triangles. |

- Set either or both. Anything else, or an empty object, throws with what to pass.
- Raster only. The path tracer ignores it, and shadow maps are drawn from the unsnapped mesh.
- A material without  compiles to the same shader as before. The snap grid and the affine switch are batch state like : parts that differ never share a draw call, and  rejects changes after upload.

## Retro look

`material.retro` gives the PlayStation 1 look in the raster renderer:

```json
{ "retro": { "vertexSnap": [160, 120], "affineUV": true } }
```

| Field | Accepts | Does |
|---|---|---|
| `vertexSnap` | `[width, height]`, whole numbers from 16 to 4096 | Rounds each vertex to a width by height grid across the screen, so vertices jitter as the camera moves. |
| `affineUV` | `true` | Interpolates texture coordinates without perspective correction, so textures swim on large triangles. |

- Set either or both. Anything else, or an empty object, throws with what to pass.
- Raster only. The path tracer ignores it, and shadow maps are drawn from the unsnapped mesh.
- The code is the lazy `retro-shader` addon (`@codepawlhq/crucible/addons/retro-shader`; a recipe loads it on its own). A renderer that draws a retro part without it throws an error that names the import. A material without `retro` compiles to the same shader as before.
- The snap grid and the affine switch are batch state like `doubleSided`: parts with different `retro` objects never share a draw call. `updateParts` rejects a `retro` change after the part is created with an error that says to set it when the part is made, which needs a new renderer.

## Water glints

`material.waterGlint` adds stylized highlights to a `water` material (sparkles come on top of the physical sun glint, the edge redraws it). Both parts are off until the field names them, so water without the field draws exactly as before.

```json
{ "tag": "water", "waterGlint": { "edge": { "threshold": 0.4 }, "sparkle": { "shape": "star", "size": 0.4 } } }
```

| Part | Field | Accepts (default) | Does |
|---|---|---|---|
| `edge` | `threshold` | 0.05 to 0.95 (0.4) | Replaces the soft glint with the lobe cut at this share of its peak, so the highlight is a flat shape with a clean border that follows the waves. Higher is smaller. |
| `edge` | `intensity` | 0 to 4 (1) | Brightness of that shape. |
| `sparkle` | `density` | 0 to 1 (0.35) | Share of cells that carry a sparkle. |
| `sparkle` | `size` | 0.02 to 2 m (0.12) | Width of a cell on the water, so how big a sparkle is. |
| `sparkle` | `threshold` | 0.9 to 0.9999 (0.985) | A sparkle lights when its mirror direction has at least this cosine to the sun. Higher is fewer and tighter. |
| `sparkle` | `shape` | `dot` or `star` (`star`) | Four-point star, or a round dot. |
| `sparkle` | `twinkle` | 0 to 8 per second (1) | How fast each facet turns; 0 keeps them still, though waves and camera still move them. |
| `sparkle` | `intensity` | 0 to 4 (1) | Brightness. |

- Sparkles show on the sun path only: toward the sun they glitter, and none appear on the side away from it, in foam or in shadow.
- Cells are on the water plane, so far sparkles are flattened by perspective and a cell under two pixels fades out.
- Painted light streaks are not built.
- Raster only. The path tracer ignores it. The material needs the `water` tag; any other tag throws with what to pass.
- The code is the lazy `glitter-shader` addon (`@codepawlhq/crucible/addons/glitter-shader`; a recipe loads it on its own). Parts with different `waterGlint` objects never share a draw call, and `updateParts` rejects a change after the part is created.

## Moss layer

A standard-tag material can grow moss: `moss` (0 to 1, default 0) sets how much of the up-facing surface it covers, and `mossColor` (linear RGB, default `[0.05, 0.085, 0.02]`) its colour.

```js
const rock = { color: [0.3, 0.29, 0.27], roughness: 0.85, moss: 0.6 };
```

Moss is shaded as its own material, not as a tint. Where it grows, roughness becomes 1 and metal 0, a soft sheen shows at grazing angles, and sunlight wraps through it. Two masks decide it: a sharp one for where moss is shaded, and a blurred one that lifts it into small cushions, so its relief never turns into needles. Coverage follows world position, so moss slides across an object that moves. Use it on static parts. Moss works with or without maps, costs nothing on materials without it, and is part of the batch state: parts with different `moss` or `mossColor` draw separately, and changing either needs a new renderer. Procedural tags reject it.

## Splat layers

A standard-tag material can carry `layers` (up to four `{ color, normal, roughness, height, scale, tint, triplanar }` entries built from `loadTextureSet`) and a `splat` rule object instead of these single maps. The layers are blended by slope, height and a weight mask, sampled in world space and packed into texture arrays and a weight mask on units 11, 12, 14 and 17. They replace `map`, `normalMap`, `metallicRoughnessMap` and `occlusionMap`, which must be absent, and parts batch only when `layers` and `splat` are the same objects. See [Terrain](https://github.com/codepawl/crucible/blob/main/docs/terrain.md).

## Material layers

A material on a standard tag (`surface` in recipes, `gltf` and `armor` in code) can carry these layers. The names are the glTF `KHR_materials_*` names, and each is checked at the boundary with an error that names the fix.

| Field | Range | Meaning |
| --- | --- | --- |
| `clearcoat`, `clearcoatRoughness` | 0 to 1 | A clear lacquer lobe over the base (car paint, varnish). Light it reflects never reaches the base. |
| `transmission` | 0 to 1 | The share of light that passes through. The material draws after the opaque scene and refracts it. A metal does not transmit: the share is multiplied by `1 - metallic` (per texel from `metallicRoughnessMap`), as in Blender and glTF, so `metallic: 1` stays opaque and reflective. |
| `thickness` | 0 to 1000 metres | How far light travels inside. 0 is a thin sheet that does not bend the view. |
| `ior` | 1 to 2.5 | Index of refraction. It bends transmitted light and sets the reflectance at normal incidence, 4 percent at 1.5. |
| `dispersion` | 0 to 10 | Colour fringes through glass, 20 over the Abbe number (diamond 0.36), as in `KHR_materials_dispersion`. The path tracer renders it; the rasterizer ignores it. |
| `attenuationColor`, `attenuationDistance` | colour 0 to 1, distance above 0 | The colour light keeps after that many metres inside. Leave the distance out for no absorption. |
| `sheenColor`, `sheenRoughness` | colour 0 to 1, 0 to 1 | A soft glow at grazing angles for cloth. Black is off. |
| `specular`, `specularColor` | 0 to 4, colour 0 to 1000 | Strength and tint of the non-metal reflection. `specular` scales both normal-incidence `F0` (with `specularColor`) and grazing `F90` (clamped at 1), so `specular: 0` removes grazing Fresnel rims on dielectrics while metals keep `F90 = 1`. |
| `anisotropy`, `anisotropyRotation` | 0 to 1, -2π to 2π | Stretches highlights along a grain (brushed metal, hair): the surface is rougher along the tangent than across it, as in `KHR_materials_anisotropy`. The grain follows the UV direction, or rings the world up axis on a mesh without UVs. The rotation turns it around the normal, in radians. |
| `iridescence`, `iridescenceIor`, `iridescenceThickness` | 0 to 1, 1 to 3, 0 to 1200 nm | A thin film over the surface (soap, oil, beetle shell, anodised metal) that shifts the reflection colour with the view angle, as in `KHR_materials_iridescence`. The film is as thick as `iridescenceThickness` everywhere; the glTF thickness minimum and texture are not kept. |
| `softEdge` | 0 to 8 (0, off) | Fades a translucent surface toward its silhouette: alpha is multiplied by the cosine between the view and the normal, raised to this power, so a sphere has no edge and reads as a soft round blob. Use it with `opacity` on an unlit material for dust or haze; overlapping blobs then blend into one cloud. A material without it draws as before. |
| `subsurface` (`weight`, `radius`, `scale`, `color`) | 0 to 1, each channel 0 to 100 (units of `scale`), 0 to 10 m, 0 to 1 | Light scattered under the surface (skin, wax, leaves), named as Blender's Principled BSDF Subsurface Weight, Radius and Scale. `radius` is the mean free path of red, green and blue in units of `scale` (metres); defaults `[1, 0.2, 0.1]` and `0.05`; `weight` 0 is off. The rasterizer widens the sun's diffuse past the shadow edge per channel and lets light through thin parts by the thickness the sun shadow map gives; the code loads only for a recipe that has a `subsurface` block (`@codepawlhq/crucible/addons/subsurface-shader` otherwise). Sun only, surface tag, no anisotropy; `color` is read by Crucible but Blender takes the base colour. The path tracer ignores it. |

A material that uses none of them costs nothing extra: the shader branches on uniforms that are zero, and transmission only exists in the pass that was already there for `liquid`. Anisotropy and iridescence go further: their shader code is not in the core bundle at all. It lives in `@codepawlhq/crucible/addons/material-layer-shaders`, and the renderer asks for it only when a part uses a layer, so a scene without them downloads and draws with the same shader as before. In code, add `import "@codepawlhq/crucible/addons/material-layer-shaders"` before rendering such a part; without it the renderer throws a message that names the import. A recipe loads it through `await loadAgentSceneModules(recipe)`, the MCP server does so itself, and the glTF loader brings it in for a file that uses `KHR_materials_anisotropy` or `KHR_materials_iridescence`.

Limits, stated plainly:

- Transmission refracts through the front surface, and a closed glass shape bends the ray again where it leaves, found from its own back faces (a ball keeps the sphere estimate where no back face is found). Where the surface curves with a small radius next to a much deeper body, such as the bevel of a thick glass box, that estimate would bend it like a small ball and stripe the wall behind it, so the bevel takes the flat-slab exit instead: the body depth is read from the back faces along the inward normal, and a radius under 0.15 of it is a bevel, over 0.3 a ball, with a blend between. Where no back face is drawn at the pixel the sphere estimate stays. The back-face target keeps the nearest back face per pixel. When one closed glass shape lies inside another (judged by their world boxes) a second target keeps the farthest back face per pixel, each back face carries the identifier of the glass instance that drew it, and a ray takes its exit from the first layer that holds its own shape's back face, so the outer shape leaves where it really does; this costs a second back-face draw only in such frames. Single glass shapes and shapes that overlap without one inside the other keep the nearest back face, and there the exit can still belong to the other shape. Overlapping glass does not show the shape behind it in the refracted colour, because the scene colour holds opaque geometry only. Instances beyond the 254th in one frame reuse identifiers. Roughness blurs the reflection only, not the view behind. The scene colour comes from opaque geometry, so blended surfaces do not show through glass.
- A transmissive material does not take a clear coat, sheen or maps. Its base map and normal map are ignored.
- The clear coat uses the surface normal and the key light. Point lights add no coat highlight.
- Sheen is the Charlie distribution on the key light plus an ambient rim. It does not use a lookup table for energy loss.
- A transmissive material draws in its own pass and ignores anisotropy and iridescence; `scene_inspect` diagnostics say so.
- Anisotropy shapes the key light, the fill, point, spot and area lights and the reflected environment (the lookup is bent along the grain). The clear coat above it stays isotropic.
- Iridescence uses the thin-film model of Belcour and Barla at the view angle, so the film colour follows the viewer but not each light separately. The clear coat stays plain.
- Textures inside the layer extensions are ignored. Only the factors are read.

glTF import and export carry these layers through `KHR_materials_clearcoat`, `transmission`, `volume`, `ior`, `specular`, `sheen`, `anisotropy` and `iridescence`. `bench/reference` scores `glass`, `car-paint` and `brushed-film` against Blender's Principled BSDF with the same values.

## Baked graphs and UV patterns

A recipe material `pattern` of type `graph` bakes a bounded node graph into `map`, `normalMap` (from the graph's height),
`metallicRoughnessMap` and `emissiveMap`, each only when the graph has that output; `opacity` goes into the alpha of `map`, `clearcoat` into `layerMaps.clearcoatTexture` and `transmission` into `transmissionMap`. With `mapping: "uv"` the descriptors carry
`boxMapScale: 0`, so the renderer samples every map, the emissive map included, with the geometry's UV channel 0, and GLB
export writes the maps with the authored UVs. With the default `box` mapping the maps are projected along the object axes.
The graph never becomes shader source: the shader gains no code per graph. See "Material graphs" in agent-scene.md.

## Limits

Texture transforms, UV channels beyond zero, and vertex alpha below one remain unsupported.
Skinning, morph targets, compressed texture formats, and unsupported glTF extensions fail explicitly.
The new PBR maps require a standard material tag, including `gltf` or `armor`.
Procedural tags such as water, terrain, foliage, floor, fire, and smoke reject the new channels.
Unlit materials accept base and emissive maps only.
Texture alpha is ignored for opaque materials, as required by glTF's opaque mode.

This feature does not complete the full material system.
Texture slots inside the layer extensions and node graphs remain missing.
GLB export of these material maps is outside this feature.

See also [Material layer stack](https://github.com/codepawl/crucible/blob/main/docs/material-layers.md) for blending up to four PBR materials with `heightBlend`.
