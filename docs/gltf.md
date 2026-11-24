# glTF asset bridge

`src/gltf.js` converts glTF 2.0 assets into CrucibleRenderer parts.
It decodes GLB and glTF files with its own parser (`src/gltf-decode.js`), so the addon does not import Three.js.
A box with the addon is 67,467 bytes gzip, against 159,422 when it used `GLTFLoader`.
The core renderer does not import this addon.

```js
import { loadGltf } from 'crucible/addons/gltf';
import { CrucibleRenderer } from 'crucible';

const asset = await loadGltf('/models/object.glb');
const renderer = new CrucibleRenderer(canvas, asset.parts, {
  ground: false,
  samples: 4,
  memoryBudgetMiB: 256,
});
renderer.render({ eye: [0, 2, 5], target: [0, 1, 0] });
```

## Input

`loadGltf(source, options)` accepts a URL string, a `URL`, a local `File`, or a `Blob`.
`parseGltf(data, options)` accepts an `ArrayBuffer` or a glTF JSON string.
Both functions return a promise for the decoded asset.

URL loading derives the resource directory from the asset URL.
An explicit `baseUrl` overrides that directory.
Relative external resources in a local glTF file require `baseUrl`.
GLB files can contain their buffers and images without external resources.

HTTP, HTTPS, blob URLs, and base64 data URIs are supported. A data URI must hold standard base64 (no `-` or `_`); the marker may be in any case.
External requests use bounded streaming fetches.
The optional `signal` aborts those fetches.
`allowExternalResources: false` refuses every non-data resource uri with an error that names it, before any request. The MCP server decodes catalog files with it, so a file there carries its buffers and images as GLB or data URIs.
`textures: false` skips texture image decoding while keeping material factors, so textured files parse in Node for geometry, skeleton and pose checks.

Mesh checks are off by default, because the counts cost load time (about 10 to 90 percent on the shipped showcase meshes, measured without textures). `checkMesh: true` adds one warning per primitive naming how many triangles repeat an earlier one (same corner positions and winding) and how many edges more than two triangles share. Both are judged by position, with vertices at the same spot treated as one, so a seam that repeats its vertices does not hide them; nothing is merged or rewritten. `keepDegenerateTriangles: true` keeps the repeated-index and zero-area triangles instead of dropping them (the warning still counts them). `strict: true` with `validator: await import('gltf-validator')` runs the Khronos glTF-Validator on the file bytes first and fails on any error, naming the first few; Crucible does not bundle the validator, and `strict` without it throws with that instruction.

Through MCP, `scene_create_asset` takes `checkMesh: true` and returns the decoder's warnings, the mesh-check counts among them, in `assetWarnings` (they also show in `scene_inspect` diagnostics). The counts keep the 600,000-triangle limit per primitive. `strict` and `validator` are not offered there: a validator is code, and the tool takes none.

To run the Khronos validator over real files, use `npm run validate:gltf -- [--validator <folder>] [file or folder ...]`, for example `npm run validate:gltf -- public/sample-model.glb`. It loads each GLB with `strict` and `checkMesh` and prints one line per file (`pass` or `FAIL` with the first errors, and how many mesh-check warnings it got), then one summary line. A failing file prints `FAIL public/broken.glb: glTF-Validator reported 1 error(s): <code> at <json pointer>` and the command exits 1; with no path it checks the GLBs the repository ships. `gltf-validator` is a devDependency, never part of the core; `--validator` or `GLTF_VALIDATOR` names a package folder instead. The exit code is 0 when every file passes, 1 when one fails and 2 when the validator or the files are missing. Textures decode to a 1 x 1 stand-in there, so the run judges structure and meshes, not pixels.

| Option | Default | Limit |
| --- | ---: | --- |
| `maxBytes` | 268,435,456 | Total encoded input and fetched external resources. |
| `maxDecodedBytes` | 1,073,741,824 | Decoded accessor bytes and skinned-primitive pose copies (448 bytes per joint, one copy per skinned primitive), estimated from the counts before anything is decoded. Left unset while `maxBytes` is set, it is four times `maxBytes`. |
| `maxVertices` | 8,000,000 | Declared and decoded geometry vertices. Indices have a separate ceiling of twelve times this value. |
| `maxParts` | 65,536 | Declared nodes and decoded mesh parts. |
| `maxResources` | 256 | Unique resource URIs. |
| `maxTexturePixels` | 16,777,216 | Combined texture image pixels, checked from the file headers before decoding. Over the budget, the largest images are halved together until they fit, with base color and emission maps kept at twice the size of the normal, roughness and occlusion maps, and `asset.scaledTextures` lists each one as `{ name, from, to }` (also summarised in `asset.warnings`). |
| `maxTextureImagePixels` | 67,108,864 | Hard ceiling for one image, checked before decoding. Larger images are rejected, never scaled. |
| `maxJoints` | 4,096 | Joints declared by all skins; a skin worn by many primitives counts once. Pose copies count against `maxDecodedBytes`. |
| `maxCheckedTriangles` | 600,000 | Most triangles of one primitive that `checkMesh` counts; a larger primitive skips the counts with a warning. |
| `maxInstances` | 65,536 | Instances of one `EXT_mesh_gpu_instancing` node. |

Every numeric limit must be a positive safe integer.
The defaults take one large exported scene, such as a 240 MB GLB with 8 million vertices and 8192 x 8192 textures, and `GLTF_CAPABILITIES.limits` holds them.
A file over its limits fails with one `RangeError` that names each limit it goes over, the measured value and the value that fits, for example `glTF over its limits: vertices 9120000, over maxVertices 8000000; image 6 (6144x3072) pixels 18874368, over maxTextureImagePixels 16777216. Fix: pass { maxVertices: 9120000, maxTextureImagePixels: 18874368 }.`
The file size and the decoded geometry and parts are checked as they are read, so they fail on their own.
The MCP server decodes catalog files with tighter limits: 64 MiB a file, 1,000,000 vertices, 4,096 parts, 1,024 joints, 4,194,304 texture pixels (larger images are scaled down), 256 clips and 256 catalog files (a scene places at most 32 different assets), all from `src/agent-asset-limits.js`. The reason is the hand-off: the server reads the whole file, base64-encodes it and sends it to the preview page in one browser call. Measured with a local Chrome, a 64 MiB file crossed that call (a 128 MiB rise in server memory, 2.7 s), 72 MiB took 4.9 s, and 80 MiB and above crashed the page. A file over a limit fails with an error that names the limit and the value it hit. A larger scene loads through `loadGltf` in code, where the defaults above apply and the file never crosses that call; meshopt compression shrinks a file for the catalog. See [mcp.md](mcp.md).
The importer rejects cyclic hierarchies, multiple parents, and hierarchies deeper than 256 levels.
It checks PNG, JPEG and WebP dimensions before browser image decoding.
Decoded accessor data has its own budget, `maxDecodedBytes`, and a file over it fails before any accessor is read: `decoded accessor bytes 1200000000, over maxDecodedBytes 1073741824. Fix: pass { maxDecodedBytes: 1200000000 }`.

A file also fails when its meshopt-compressed buffer views would decode to more than `maxDecodedBytes` in total, even a view no accessor uses; the views and the accessors then share that one budget. A meshopt view whose `byteLength`, extension `byteLength`, `count` or `byteStride` is not a non-negative safe integer fails by field name. The check names the total, for example `decoded meshopt view bytes 4800000000, over maxDecodedBytes 1073741824`, and is raised before the decoder runs; when the accessors then push the shared total over, the error reads `decoded accessor and meshopt view bytes`. A scene `nodes` that is not an array fails by field name too. So does any of `nodes`, `meshes`, `accessors`, `bufferViews`, `buffers`, `materials`, `textures`, `images`, `skins` or `animations` that is neither absent, `null` nor an array (`Invalid glTF meshes: expected an array of objects.`), or that holds a `null` or non-object entry (the error names the array and the index of the bad entry); a `null` array is treated as absent. So does any of `nodes[i].children`, `animations[i].channels`, `animations[i].samplers`, `extensionsUsed` or `extensionsRequired` that is not an array (a `null` one is treated as absent), a `null` animation channel, and a node or mesh `name` that is not a string. A dangling index (`primitive.material`, a scene node, an accessor `bufferView`, a mesh without `primitives`) fails with the field and the valid range. A buffer view `byteStride` below the element size or not a multiple of 4, an accessor or sparse `byteOffset` that is negative or fractional, and a sparse index type other than 5121, 5123 or 5125, fail by name. A `normalized` flag on a float or 32-bit integer accessor is ignored. A MAT2 or MAT3 accessor of byte or short components is read with the padding the glTF spec gives each column (to a multiple of 4 bytes). A node `mesh`, a child of `nodes[i].children`, an accessor `count` or a `POSITION` that is not an integer index fails or skips with its path.
Accessors are decoded one primitive at a time while the scene is converted, and each is released after the last node that uses it, so decoding holds the file bytes plus the converted geometry plus one primitive, not every accessor at once. The file bytes stay until the last primitive is read; drop your own reference to them after the call returns.
These limits bound asset inputs and geometry, rather than the renderer's total GPU allocation.
The renderer retains its separate memory budget.

## Output

The result contains `parts`, `warnings`, `animations`, `applyAnimation`, `dispose`, and `capabilities`.
Each part contains `name`, `label`, `geometry`, `matrix`, and `material`.
Three.js strips periods, slashes, brackets and colons from node names, so `name` is the decoded name that clip tracks and `pose.jointWorld` address. `label` is the node name exactly as authored in the file (the same string as the `label` of the matching entry in `nodes`), so metadata or frame tracks keyed by an authored name such as `Ship_Cargo_-2.5_-0.46_0` find their part with `asset.parts.find(part => part.label === authored)`. A part of an unnamed node has the same generated name in both fields.
The column-major matrix contains the complete world transform, including parent transforms.
Repeated primitives share geometry objects.
Static mirrored instances keep their authored winding and world matrices; the renderer batches parts with a negative-determinant matrix apart and draws them with clockwise front faces.

Geometry contains `positions` and `normals` as `Float32Array` values, plus `indices` as a `Uint32Array`.
The importer computes missing normals and normalizes supplied normals.
It rejects non-finite attributes, invalid indices, singular transforms, and unusable normals.
`geometry.uvs` preserves `TEXCOORD_0` as two floats per vertex.
A primitive with a normal map also gets `geometry.tangents` (four floats per vertex): the file's `TANGENT` when it has a usable one, otherwise tangents generated from the UVs the map samples. [Material maps](material-maps.md) describes the frame and when the loader replaces an authored `TANGENT`.
`geometry.colors` preserves the RGB of `COLOR_0` as three linear RGB floats per vertex. An RGBA `COLOR_0` with an alpha below one also fills `geometry.colorAlpha`, one float per vertex. The rasterizer multiplies it into the opacity of `blend` and `mask` materials, lit or unlit (so a `flatten: { unlit: true }` ribbon fades at its edges); an opaque material ignores it, as glTF says. The alpha shares the fourth vertex-colour component with baked sky visibility (two 10 bit levels), so both survive; a part with `surfaceMasks` (material wear) keeps those instead of the alpha, and the scene diagnostics warn with `vertex-alpha-dropped`. The CPU and WebGL (`backend: "gpu"`) path tracers read it too, interpolated at the hit: a `mask` material multiplies it into the alpha it tests against its cutoff, and a `blend` material is traced as a cutout at 0.5 (the tracers have no blending), so a vertex alpha below half lets a ray through. The WebGL tracer uploads one extra texel per triangle only for a scene that has such a part. The WebGPU tracer and the native Cook kernel do not read it yet (`traceNotes` says so).

Materials preserve linear `color`, `metallic`, `roughness`, and `emissiveColor` factors.
`emission` contains the emissive intensity.
The `gltf` tag uses standard PBR shading without studio finish overrides.
An emissive-strength extension preserves its intensity.
The source [exporter](export-glb.md) preserves opaque colors, UVs and active HDR emission when creating static GLB snapshots.

A base color texture adds this descriptor:

```js
material.map = {
  image,                 // Decoded browser image or ImageBitmap.
  uvChannel: 0,
  wrapS: 10497,          // Native WebGL sampler enum.
  wrapT: 33071,
  minFilter: 9729,
  magFilter: 9729,
  flipY: false,
  colorSpace: 'srgb',
};
```

Texture descriptors share identity when materials reuse the same texture.
Texture rendering requires batches grouped by geometry and texture identity.
The image descriptor requires sRGB sampling with conversion to linear RGB before lighting.
The importer rejects a requested texture that fails to decode, rather than returning an untextured material.

## Memory of a very large file

A 224 MiB GLB (5.4 million vertices, 65 small textures) takes about 460 MB of the page's JavaScript heap once decoded, plus the 225 MB of file bytes, and the converted vertex arrays come on top. `parseGltf` now keeps less of that alive:
- it drops its reference to the file bytes as soon as the decoder has read them, and the returned release function no longer holds the decoder's file bytes or accessor reader;
- it frees a primitive's decoded attribute arrays right after the last node that uses them is converted, so decoded and converted copies are not both alive for the whole file. On the Barbershop export this took the heap after loading from 734 MB to 541 MB `[measured, usedJSHeapSize, same scene, same box]`.

A file over `maxBytes` (256 MiB by default) fails before decoding with an error that names the size, the limit and the value to pass. A file with too many texture pixels is scaled down to `maxTexturePixels`, or fails naming that option.

`scripts/render-media.mjs --scene file` and `scripts/render-file-native.mjs` serve a GLB above 32 MiB from a local HTTP server that streams it from disk. Handing a file that size to the page through a Playwright route copies it through the browser protocol as one message and closed the whole browser tab (a 225 MB file did, with nothing else loading).

A scene file whose GLB has an animation clip plays the first clip on a loop in `scripts/render-media.mjs --scene file`, the way the showcase page does: the pose at a frame time is the clip at that time modulo the clip length. Staged files (`glbRest`) are not posed. `scripts/render-file-native.mjs` poses the same clip before it packs the scene, at `--time <seconds>` (default 0); render a video as one run per frame time. A GLB without a clip renders as before. A frame range and motion blur on this path are in [agent-render-jobs.md](agent-render-jobs.md#a-scene-file-as-a-numbered-frame-range-3233).

**Large rigid animation (#3232).** The supported route for a character made of rigid parts joined by parent-child nodes, with no skinning (for example Roblox-style scenes exported from Roblox Studio), is one GLB per shot with baked translation, rotation and scale channels per node and `LINEAR` interpolation, rendered with `--scene file`. It does not go through the motion recipe, whose cap is 2048 keyframes in total. Write one key per frame, with the key time `frame / fps` as float32, and render the frame at `frame / fps` seconds. The clip time is that time, held on the last key for times within 0.1 ms of the clip length (float32 key times can make the clip one rounding step shorter than `frame / fps`, and the last frame used to wrap to the first pose) and wrapped modulo the length after that. `tests/baked-node-animation.test.js` builds a 120 node by 90 frame rig (`tests/helpers/baked-rig-glb.mjs`) and compares every node's world matrix with the baked values on all 90 frames (largest difference 3e-6). `node scripts/make-baked-rig-scene.mjs <folder>` writes the same rig and its scene file for `render-media.mjs --scene file --config <folder>/scene.json`. Measured at 120 nodes by 90 frames, 1080x1920, 30 fps, on the GPU: 42 frames per second including capture and encode (peak render estimate 172 MiB, node heap 138 MiB, browser heap 6 MiB), and posing alone takes 0.2 ms per frame. Limits: the first clip only, one clip per file, no skin (a skinned character keeps its joints through the skin path), the clip loops, staged files (`glbRest`) are not posed, and the file is read whole, so a shot with many more nodes or frames grows the GLB (this one is 523 KiB) and the per-frame pose cost with the node count.

## Loading a large scene without a long freeze

Building a renderer on a big asset blocks the page while the driver links the shader program, uploads textures and packs batches.
Three pieces split that work across frames:

```js
import { CrucibleRenderer, shaderFeatureRepresentatives } from 'crucible';
import 'crucible/addons/replace-textured-parts';

// 1. Start on a few parts that need the same shader features as the whole scene, and do not wait for the link.
const renderer = new CrucibleRenderer(canvas, shaderFeatureRepresentatives(asset.parts), { deferProgramLink: true });
// 2. Upload textures in short slices: renderer.createTexture(descriptor) caches each one, then yield to the page.
// 3. Wait for the program with a poll that leaves the main thread free, then take the whole scene.
await renderer.programsReady();
renderer.replaceParts(asset.parts);
```

`programsReady()` polls `KHR_parallel_shader_compile` and then finishes construction; a renderer made with `deferProgramLink` must not render before it resolves. After `dispose()`, `programsReady()` resolves at once and `prepareFrame()` resolves `false` without drawing, so a world swap that disposes a renderer mid-compile never leaves a promise hanging. Programs a draw started are tracked per context, so two live renderers on one canvas context are not supported: disposing one deletes the in-flight programs of the other.
`await renderer.prepareFrame(frame)` is the matching last step before a hidden renderer is shown: it draws `frame` once without freezing the page for the programs a first draw links (the post pass of a fog or sky frame, liquids, ambient occlusion, the reversed-depth copy). A draw that meets a program the driver is still building stops, the page waits in short timers, and the draw runs again until one completes; it resolves `true`. A main program that is rebuilt for a new shader feature is started once and finished by the draw that comes back. After `timeoutMilliseconds` (6000 by default) it draws the frame in one block and resolves `false`, so a slow driver costs a stall, never a hang. Start the next scene's `prepareFrame` while the current scene plays and begin the fade when it resolves.
Starting on `shaderFeatureRepresentatives` matters: a scene whose first parts lack a feature recompiles the program inside `replaceParts`, which blocks again.
When a world arrives in growing prefixes, call `renderer.replaceParts(prefix, { retainedUnchanged: true })`: only the parts appended since the last call are grouped and checked, and the batches built before are kept as they are. An appended part joins the batch that already has its geometry and material, or starts a new batch after the others, exactly where grouping the whole list would put it. A prefix that changes, reorders or removes earlier parts groups the whole list as before. Shader status and logs are read only when a program fails to link, and the shadow framebuffer and the anisotropy limit are asked for once, because each read is a round trip to the GPU process that waits for all the work queued before it (30 to 70 ms each on a busy card).
Before `replaceParts`, `await renderer.preloadTextures(parts)` uploads the textures that are larger than `maximumBytes` (1 MiB by default) a band of rows at a time, with `checkpoint` (an async function that yields, `createSlicer()` by default) after each band, so one upload never hands the driver a whole image. The pixels equal a single upload, including `flipY`; `replaceParts` then finds the textures ready. Compressed and small textures are left to the call that needs them, and the constructor still uploads synchronously.
`node bench/incremental-grouping/run.mjs` times it for 100,000 parts of 2,000 geometries in 20 prefixes; the grouping step is about ten times shorter in total and in its longest slice, and the numbers move with machine load.

## Animation and ownership

`animations` contains the decoded animation clips, including their names, durations, and tracks. Each track has `name` (`Node.position`, `Node.quaternion`, `Node.scale` or `Node.morphTargetInfluences`), `times`, `values`, `getInterpolation()` and `createInterpolant(result)`, the same fields the Three.js clips had.
`applyAnimation(time, clipIndex = 0)` evaluates node and joint animation at an absolute time in seconds.
Time clamps to the selected clip's duration.
The hook updates the existing part matrices and returns the same `parts` array.
Seeking in a different order produces the same matrices.

```js
const changedParts = asset.applyAnimation(1.25, 0);
renderer.updateParts(changedParts);
renderer.render(camera);
```

Translation, rotation, and scale tracks are supported.
The importer rejects animation poses that become singular or change triangle winding.

To hide one instance of a crowd, set `visible = false` on its parts (all of an asset's `parts`) and skip `applyAnimation` for it. `renderer.updateParts` then draws it nowhere, casts no shadow, and does not check its matrix or skin pose, so a hidden part may keep a zero-scale matrix. A zero-scale matrix on a visible part is still refused with `Singular transform`; hide the part instead. A hidden part's material is still checked.

The current source supports four-influence [GPU skinning](https://crucible.codepawl.com/skinning.md). GPU skinning is available from version `0.4.0`.

Negative skin weights, which three.js and Blender also accept, are clamped to 0 and each vertex is renormalised. A vertex left with no positive weight binds fully to joint 0. `warnings` names the primitive and counts the clamped weights. NaN and Infinity weights still fail.
The current source also supports relative POSITION/NORMAL morph targets and weight animations. See [morph import](https://crucible.codepawl.com/gltf-morph.md).
A morph primitive without an authored base NORMAL loads with normals generated from its triangles; its morph NORMAL deltas are dropped, with a warning. TANGENT morph deltas are ignored with a warning (`unsupported-asset-feature` in `scene_create_asset`); any other morph semantic is refused, and the error says to re-export the GLB without it.

The caller owns the CrucibleRenderer instance.
`asset.dispose()` releases importer textures, image bitmaps, parser resources, and temporary object URLs.
It does not dispose the renderer.
Disposal is idempotent, and subsequent animation calls fail explicitly.

1. Call `renderer.dispose()` before replacing its imported asset.
2. Call `asset.dispose()` after the renderer finishes using the asset's images.

## Supported subset

`GLTF_CAPABILITIES` lists the supported and unsupported features.
The bridge supports triangle meshes, PNG/JPEG base color textures, rigid animations, and metallic-roughness material factors.
It also supports `KHR_mesh_quantization` and `KHR_materials_emissive_strength`.

Quantized positions load exactly as stored, so their precision is set when the file is packed. `gltfpack` merges a scene's meshes and puts the positions of all of them on one grid sized to the whole scene: with the default 14 bits, a 170 m street (the ORCA Bistro) gets a 9.7 cm step, and a scooter's wheels come out square. gltfpack warns about it ("position data has significant error"). Pack a large scene with `-vp 16` (about 1 cm there) or `-vpf` (float positions); both still compress with `-cc`.

Alpha masking, alpha blending and double-sided materials import onto `alphaMode`, `alphaCutoff`, `opacity` and `doubleSided` (see the material maps guide). Vertex alpha is not drawn: an RGBA `COLOR_0` loads with its RGB, and `warnings` names the meshes whose alpha was below one and was dropped.
It supports base-color, normal, metallic-roughness, occlusion and emissive texture channels.
An optional extension that Crucible does not read is ignored and named in `warnings`, as the glTF specification allows. An extension listed in `extensionsRequired` that Crucible does not read still fails the load with `Unsupported glTF extension`.
`KHR_materials_pbrSpecularGlossiness` (also when listed in `extensionsRequired`) is converted to metallic-roughness: the diffuse color and texture become the base color, metallic is 0, roughness is 1 minus `glossinessFactor`. The specular color and `specularGlossinessTexture` are not read, and `warnings` says so. The base color and layer maps may read `TEXCOORD_1` beside maps on `TEXCOORD_0`, and so may every other texture. If every map of a material reads `TEXCOORD_1` and one is a base color or layer map or carries a real `KHR_texture_transform` (an identity transform counts as none), the primitives take that set as `TEXCOORD_0` and the maps move with it, with a warning naming the material, because the light bake reads only the first set and a transform is baked into one set only. If the material also has maps on `TEXCOORD_0`, only a map on `TEXCOORD_1` that carries a transform is dropped, with a warning naming the material; the others keep reading their own set (every path tracer reads each map with its own set: the WebGL and WebGPU tracers keep both UV sets in the triangle record, ten texels a triangle, and a bit mask in the material record names the maps on `TEXCOORD_1`). A map on `TEXCOORD_1` needs `geometry.lightUvs` on every part that uses it: the path tracer refuses the scene with a message naming the part otherwise, instead of sampling UV (0, 0). The native Cook kernel reads each map with its own set too: the trace scene hands it each map's set as `uvSet` and the second UV set as `uv1s` (on a flattened scene, and on the geometry of an instanced one, taken from `lightUvs`). The refusal above covers the maps the tracer reads: the base color, normal, metallic-roughness, transmission and clearcoat maps, and the emissive map while the material emits. A light bake skips a part whose maps or layer maps read `TEXCOORD_1` and names its material in `report.skipped`, because the bake replaces that set with the lightmap atlas. A texture on a primitive without the UV set it reads is dropped from that primitive with a warning that names the materials, and the mesh still loads. A negative `texCoord` (Blender writes -1 for a map on a mesh without UVs) or one above 1 (Crucible reads two UV sets) drops that map, and a `metallicFactor` or `roughnessFactor` outside 0..1 is clamped, each with a warning naming the material, the way three.js reads such files.
A triangle primitive that cannot be drawn is skipped with one warning that names its mesh, its index and the reason, and the rest of the file loads: a missing or short POSITION accessor (fewer than 3 vertices), an index accessor with fewer than 3 indices or a count that is not a multiple of 3, an index outside the POSITION range (the warning gives the bad value, its position in the index list and the vertex count), or only zero-area triangles. A file with no primitive left, no skin and no animation throws, and the error repeats those warnings.
Repairs keep the file loading and add one warning each: triangles with a repeated index or zero area are dropped from the primitive (the other triangles keep their order, a mesh without any is untouched) and the warning counts both kinds, authored vertex normals of zero length are rebuilt from the triangles ("Repaired primitive ..."), and a mesh on a node whose world transform is non-finite or singular is skipped ("Skipped node ..."), and the warning names the axis scales and the limit. A transform is singular when its smallest axis scale is not above 1e-12 times its largest, so a zero scale on one axis is skipped while a uniform scale of 1e-7 loads at its real size. A pose that later makes a node singular still throws.
A file with a skin or animation but no mesh (a skeleton-only clip such as the 100STYLE skeletons) loads with `parts: []`. `nodes` marks the skin's joints with `joint: true` and `animations` holds the clips, so `clipFromGltfAnimation`, `createAssetPose` and `pose.jointWorld` work on it. `skins` is empty because no mesh uses one.
POINTS, LINES, LINE_LOOP and LINE_STRIP primitives are skipped with a warning that names the mesh and their count. Drawing them is not supported. TRIANGLE_STRIP and TRIANGLE_FAN primitives are still refused.

## Extensions

| Extension | Behavior |
| --- | --- |
| `KHR_mesh_quantization`, `KHR_materials_emissive_strength` | Supported. |
| `KHR_texture_transform` | Offset, rotation and scale are baked into `geometry.uvs`. The maps of one material share one baked transform. A normal map may differ by an offset and a positive scale (same rotation), which the shader applies on top of the baked UVs (`normalMapTransform` in `material-layer-shaders`). Any other map that differs is resampled at load into the shared UV space and named in `warnings`: the loader keeps the transform most maps have and tiles the rest, so it must differ by whole-number tilings (a tiled base color beside an untransformed emissive map). A resampled map grows to at most 4 times the pixels of its source and never past `maxTextureImagePixels`. A map that cannot be resampled (a clamped or mirrored sampler, a compressed texture, a non-integer ratio such as scale 2 against scale 3) fails the import with the material named. `texCoord` overrides are rejected. |
| `EXT_mesh_gpu_instancing` | The node expands into one part per instance and primitive. Parts of one primitive share one geometry object, so the renderer batches them. Skinned or morphed instancing is rejected. |
| `KHR_materials_unlit` | The material gets the renderer's `unlit` tag and shows its base color and base color map alone. Emissive, normal, occlusion and metallic-roughness maps and layers are dropped. |
| `KHR_lights_punctual` | Point and spot lights (up to the renderer limits of 16 point and 8 spot lights, in candela like the renderer) and the first directional light become `asset.lights`, a partial `environment`: `pointLights`, `spotLights`, and `keyColor` (color times lux), `lightDirection` and `keyIntensity` for the key light. A file with lights also sets `fillIntensity` to 0, and `keyIntensity` to 0 when none of its lights is directional, so the renderer's studio key and fill lights do not add light the file does not have. Pass it as `CrucibleRenderer`'s `environment` option or a `frame.environment`. A spot's `penumbra` is `(outer - inner) / outer`. A light over the limits, a second directional light, a spot or directional light scaled to a zero direction and an invalid light are skipped with a warning. Light directions are normalized, and a range that is not a number is ignored with a warning. The renderer has no calibrated photometric units, so judge the level by eye. |
| `KHR_materials_variants`, `KHR_materials_diffuse_roughness`, `EXT_materials_bump`, `EXT_texture_avif` and any other optional extension | Ignored, named in `warnings`. |
| `KHR_draco_mesh_compression` | Needs `options.decoders.draco`. |
| `EXT_meshopt_compression` | Decoded by Crucible: attribute, triangle and index modes with the NONE, OCTAHEDRAL, QUATERNION and EXPONENTIAL filters. The decoder is a separate chunk that loads only when `extensionsUsed` or `extensionsRequired` lists the extension. The fallback buffer is never read, so it may be absent, zero-filled or an unreachable `uri`, and it does not count against `maxBytes`. A view with a bad `byteOffset`, `byteLength`, `count`, `byteStride` (a multiple of 4 from 4 to 256 for ATTRIBUTES, 2 or 4 for TRIANGLES and INDICES), `mode` or `filter` fails before decoding with an error that names the buffer view, the field, the value and what to pass. A buffer view that fails to decode throws a named error. `options.decoders.meshopt` still replaces the built-in decoder. |
| `KHR_texture_basisu` | Needs `options.decoders.ktx2`. MCP catalog assets are transcoded to PNG on the server first. |
| `EXT_texture_webp` | The WebP source is decoded by the browser like PNG and JPEG. When the texture also has a PNG or JPEG `source` and the browser cannot decode WebP, that source is used instead. |
| `KHR_materials_clearcoat`, `_transmission`, `_ior`, `_dispersion`, `_specular`, `_sheen`, `_volume`, `_anisotropy`, `_iridescence` | Read as factors and rendered as material layers, see `docs/material-maps.md`. The textures `clearcoatTexture`, `clearcoatRoughnessTexture`, `clearcoatNormalTexture`, `anisotropyTexture`, `sheenColorTexture` and `sheenRoughnessTexture` are read too, into `material.layerMaps` (their GLSL loads with `material-layer-shaders`); a renderer draws at most three different ones, and none beside splat layers. The transmission, iridescence and specular textures are not read: their factors are used. An `ior` above 2.5 (exporters write 1000 for a mirror-like surface) loads as 2.5 with a warning, and an `ior` of 0 (which glTF allows) loads as 1; anything else below 1 is refused. `specularColorFactor` may be any value up to 1000 (Blender writes 10): the reflectance is capped at 1 after the IOR term, so size beyond that point changes nothing. `occlusionTexture`, `emissiveTexture` and `metallicRoughnessTexture` may use TEXCOORD_1 (the mesh's `lightUvs`, which a light bake also uses); the normal texture may use TEXCOORD_1 too (its tangent frame is built from that set); so may the base color map (also in the shadow alpha pass) and the layer maps, and a texture left on TEXCOORD_1 cannot carry `KHR_texture_transform` (see the text above). The anisotropy tangent frame always follows TEXCOORD_0, so an `anisotropyTexture` on TEXCOORD_1 samples its own set but its direction is right only when both sets are oriented alike. Their textures are ignored, and an iridescent film takes the thickness maximum. Export writes them back. |

`KHR_materials_transmission` with a factor above zero sets `material.transmission` to that factor. The rasterizer refracts the opaque scene behind a transmissive part with the part's `ior` and `thickness` (a thickness of 0 is thin-walled and does not bend the view; glass bends the ray where it enters and again where it leaves, as a sphere tangent to the surface with the curvature the shader reads from the screen, so a thick sphere magnifies what sits close behind it), tints it with the attenuation, and blurs it with the roughness: it reads a mip level of the scene that grows as `log2(larger frame side) * roughness * roughness` (the microfacet width, as the path tracer's GGX lobe), scaled to 0 as `ior` falls to 1 and full from 1.5 (`src/transmission-blur.js`). The mip chain is built only on frames that draw glass with a roughness above about 0.16 at 960 x 540 (a cornea of roughness 0.08 reads the sharp image). A blended material with transmission still draws in this pass: its alpha only counts for the part of the light that does not transmit, so a cornea authored with alpha 0.25 and transmission 1 shows the full refracted picture, not a quarter of it over an unbent copy. Thickness, in the mesh's own units (the renderer scales it by the placement): an explicit `KHR_materials_volume` `thicknessFactor` always wins, 0 included (0 is thin-walled and does not bend the view); a recipe material's `thickness` is used as given, never derived. Only a transmissive mesh with no `KHR_materials_volume` gets a derived one: a closed shell takes its smallest extent, an open cap that bulges (smallest extent at least a tenth of the largest, a cornea) takes half its largest extent and bends the ray once because the glass continues behind it, and a flat open sheet stays thin-walled (`src/glass-thickness.js`). Glass bends the ray where it enters and where it leaves (a sphere tangent to the surface, with the curvature the shader reads from the screen), then marches the bent ray through the opaque scene's depth (32 steps spaced closer near the glass, 6 halvings, up to 16 thicknesses) and reads the colour at the first surface it goes behind, so a thick sphere magnifies what sits close behind it and flips what lies beyond its focal length, as the path tracer shows, and an iris behind a cornea shifts and magnifies. The depth is resolved into its own texture (4 bytes a pixel) on frames that draw glass only. A ray that leaves the screen or reaches the sky reads the scene a quarter of a thickness along the ray instead (`src/glass-depth-march.js`, `src/glass-ball-lens.js`). The march sees only what the opaque pass drew: glass behind glass, and objects hidden from the camera, do not appear in the refraction. A transmissive part also glows: its `emission` (and a material graph's `fresnel` factor of emission) is added to the surface light, not to the refracted picture, so a blended pane with `transmission` above 0 shows a Fresnel rim like the same pane at `transmission` 0 (#3279). The transmissive pass reads the `emission` and `emissiveColor` of the part only; an `emissiveMap` or an `emissionMask` is not applied to it yet.
The renderer draws a transmissive part in its liquid pass: it refracts the opaque scene and reflects the environment by Fresnel.
A flat, smooth, transmissive part with an `ior` below 1.45 (water is 1.33) also takes part in the water reflection when the scene asks for it (`waterReflection` in a file scene, or `applyWaterReflection` in code), and the liquid pass shows the mirror picture in place of the sky alone.
A transmissive part with an `ior` of 1.45 or more, or none (glass is 1.5), is not taken for water. A vertical glass wall shows the environment only, not the building beside it.

Without the matching decoder, a file that uses Draco or KTX2 fails with `Unsupported glTF extension` and the option name. Meshopt needs no option.
A `sparse` block on an accessor of a Draco-compressed primitive is applied on top of the decoded data, as it is for any other accessor.
Through MCP an agent cannot pass a decoder, so the server decodes Draco catalog assets itself with the optional `draco3d` package, and transcodes KTX2 textures to PNG with the Basis transcoder of the optional `three` package (base mip level only, so the GPU-compressed upload of a `ktx2` loader does not apply) ([mcp.md](mcp.md)).

### Decoders

The Draco and KTX2 decoders are the Three.js loaders, and they stay yours: only an application that passes one imports Three.js. Crucible does not bundle or fetch their wasm files, so you choose where they are served.
A Draco loader needs `decodeDracoFile(buffer, onLoad, attributeIds, attributeTypes, colorSpace, onError)`, and a KTX2 loader needs `load(url, onLoad, onProgress, onError)`.

```js
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { loadGltf, ktx2WorkerConfigFor } from 'crucible/addons/gltf';

const draco = new DRACOLoader().setDecoderPath('/vendor/draco/');   // copy three/examples/jsm/libs/draco/
const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/');  // copy three/examples/jsm/libs/basis/
// Transcode to a GPU-compressed format the renderer's context takes, or to RGBA8 where it takes none.
ktx2.workerConfig = ktx2WorkerConfigFor(renderer.context);

const asset = await loadGltf('/models/car.glb', { decoders: { draco, ktx2 } });
```

Any subset works. Draco and KTX2 decode in browser workers. Dispose the loaders yourself when done (`draco.dispose()`, `ktx2.dispose()`).

### KTX2 texture formats

`ktx2WorkerConfigFor(context)` (exported next to `loadGltf`) reads the extensions of a WebGL2 context and returns the `workerConfig` for the loader. The loader then picks one format per file.
The renderer uploads these GPU-compressed formats as they are, with `texStorage2D` and `compressedTexSubImage2D` for each mip:

| Format | Needs | Bytes a texel |
| --- | --- | --- |
| BC7 | `EXT_texture_compression_bptc` | 1 |
| BC1 or BC3 | `WEBGL_compressed_texture_s3tc` and `WEBGL_compressed_texture_s3tc_srgb` | 0.5 or 1 |
| ASTC 4x4 | `WEBGL_compressed_texture_astc` | 1 |
| ETC2 | `WEBGL_compressed_texture_etc` | 0.5 or 1 |

A context with none of these, such as SwiftShader, gets RGBA8 (4 bytes a texel). Set `workerConfig` before the first load. A loader that you leave without a config throws.
Color maps upload as sRGB and data maps as linear. A file with a partial mip chain keeps only its first level. A compressed texture cannot be exported to GLB or read by the path tracer, so transcode to RGBA8 for those. A mip level that is missing from a full chain fails the load, naming the level.
`asset.textureFormats` lists `{ format, width, height, colorSpace, bytes }` for each texture, with `format` set to `bc7`, `bc1-rgb`, `bc1-rgba`, `bc3`, `astc-4x4`, `etc2-rgb`, `etc2-rgba` or `rgba8`.
KTX2 dimensions count toward `maxTexturePixels` before decoding. KTX2 images are never scaled. When the loader's `workerConfig` allows a compressed format, a KTX2 image counts a quarter of its pixels, because it takes at most one byte a texel on the GPU. A KTX2-heavy file over the budget still fails.

three's KTX2Loader picks the format from the context. For this file it chose ASTC 4x4 where ASTC is available and BC7 where it is not, and the renderer falls back to RGBA8 when the context offers none of the formats above. On the RTX 3060 (Direct3D 11 through ANGLE) the Khronos `AnisotropyBarnLamp` KTX2 variant loads as `bc7`. On Chrome's SwiftShader it loads as `astc-4x4`, because SwiftShader advertises ASTC, ETC2, S3TC and BPTC and decodes them on the CPU. Only a context with none of these extensions gets `rgba8`; the table above is the list.

#### Measured 2026-11-04 (issue #304, `bench/ktx2/measure.mjs`)

`AnisotropyBarnLamp` from [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets) (CC BY 4.0, Analytical Graphics, Inc. and Wayfair, LLC), four 2048 x 2048 maps (base color, anisotropy, normal, occlusion-roughness-metal), PNG against `glTF-KTX-BasisU`, median of three loads:

| | PNG, `rgba8` | KTX2, `bc7` |
| --- | --- | --- |
| Texture bytes the engine accounts for (computed from block size and mip count, not read from the driver) | 89,478,480 (85.3 MiB, with mips) | 16,777,216 (16.0 MiB, one level) |
| Load time on the RTX 3060 | 0.12 s | 0.27 s |
| Load time on SwiftShader | 0.15 s | 0.21 s |

The Khronos KTX2 files hold no mip chain, so the 5.3x saving mixes the format (4 bytes to 1 a texel) with the missing mips; with a full chain BC7 would take 21.3 MiB, 4.2x less. WebGL does not report driver memory, so these are not driver readings. KTX2 loads slower because of the Basis transcode. Drawn through the reference suite's Khronos framing and scored against the stored Cycles array, the PNG variant gets FLIP 0.0386 over the whole frame and 0.3341 over the pixels the lamp covers; the KTX2 variant gets 0.0385 and 0.3330, a difference of 0.0001 and 0.0011.

### Making KTX2 textures

`scripts/encode-glb-ktx2.mjs` re-encodes the textures of a GLB as KTX2 (`KHR_texture_basisu`) with `toktx` from [KTX-Software](https://github.com/KhronosGroup/KTX-Software/releases). It is a script, so the engine gains no dependency.

```sh
node scripts/encode-glb-ktx2.mjs scan.glb scan-ktx2.glb [--max-texture 2048] [--toktx <path>] [--threads 2] [--quality default|high]
```

- Colour maps (base colour, emissive) and data maps (roughness, occlusion and the rest) become ETC1S. Normal maps become UASTC with RDO, and are capped at 1024 pixels.
- `--quality high` encodes colour maps as UASTC with RDO instead of ETC1S. Use it for assets with small printed text or fine lines, where ETC1S blurs and flattens colour. Data and normal maps stay as above. On two scanned objects the KTX2 GLB grew from 163 KB to 694 KB (Perricone, 129 KB as WebP) and from 345 KB to 1.91 MB (Pass_The_Popcorn, 440 KB as WebP). Drawn in Crucible from one camera against the WebP file, the RMSE (0 to 255) fell from 1.89 to 0.74 and from 4.69 to 1.96. The GPU copy is BC7 either way, so memory does not change; only the download does.
- Every image gets a full mip chain and both edges are rounded to a multiple of 4.
- PNG, JPEG and WebP images are read (a WebP texture is found through `EXT_texture_webp`, which is dropped once nothing uses it). Images that are already KTX2 stay. Meshopt geometry is copied byte for byte.
- `toktx` comes from `--toktx`, then `CRUCIBLE_TOKTX`, then `~/.local/bin/ktx-software`, then `PATH`. Without it the script stops and says where to get it.
- The file needs a KTX2 decoder to load (see above). The MCP server keeps KTX2 textures GPU-compressed on the preview and realtime render path using the Basis transcoder bundled by `three`, and falls back to RGBA8 or PNG automatically when the WebGL context lacks compression, a shared texture transform needs resampling, or a path tracer, light bake or web export runs ([mcp.md](mcp.md)); unchanged KTX2 textures also stay compressed on `exportGlb`.

### Instancing limits

`maxInstances` (default 65,536) caps the instances of one node, and `maxParts` still caps the total number of parts.
Both are checked from the accessor counts before any data is decoded.
The bridge does not import cameras or scene environments into CrucibleRenderer. The caller supplies its own camera and base lighting.
Lights from `KHR_lights_punctual` come back in `asset.lights` and are applied only when the caller passes them on (see the extension table). A scene file (`scripts/render-media.mjs --scene file` and `scripts/render-file-native.mjs`) passes them on: the GLB's lights are its environment, and keys in the scene file's `renderer.environment` override them one by one.

A scene file whose GLB has no lights of its own, and whose `renderer.environment` names no key light, is lit by the HDRI's sun (#2761). `splitHdriSun` (`src/hdri.js`) takes the sun disc out of the map and turns its energy into the key light, with fill set to 0. The background still draws the disc. The sun then lights only the points it can reach, instead of reaching every point through the unshadowed sky term. On the Lone Monk courtyard this took the frame median from 183 to 110 and the darkest 5% from 114 to 47 (luma 0 to 255). Set `"hdriSun": false` in the scene file to keep the whole map and the renderer's default key. The native trace (`render-file-native.mjs`) always gets the whole map. Such a frame also fits the sun's shadow view to the scene (`sunShadowBounds`, as world scenes do since #1695), rather than using the 7 m studio box at the origin; a scene file's `renderer.shadowBounds` overrides it. A scene whose GLB has lights of its own is drawn as before.

**Sky light under cover (#3289).** `"renderer": { "environment": { "skyOcclusion": true } }` takes sky light away under canopies, eaves and porch roofs, which the screen-space `ambientOcclusion` cannot see from below. When the scene loads (`withFileSceneInteriorLight`, `src/sky-occlusion-grid.js`), a coarse grid over the parts is traced once: nodes 2 m apart (coarser when the scene would need more than 8,192 nodes), 32 cosine-weighted rays up from each, the share that leaves the scene stored per node. The grid is an irradiance grid that carries no light, so the shader reads it through the samples and uniforms it already has and multiplies it into the light the HDRI and the sky give a surface: the sun and the other lights are not scaled, and no shader code or uniform is added. It is off by default. Opaque parts block the sky; blended and additive parts let it through. A scene with baked light (a light map or an irradiance grid), no parts or more than 2,000,000 triangles is drawn as before with a console warning. The grid reads about 2 m coarser than a mesh: a surface at the edge of a canopy gets a blend of covered and open nodes, and the sun bounce and the sky trace of a closed room are not changed by it. Fog does not see the grid: a sky-only grid holds no light, so it does not switch on the fog's irradiance grid lighting (`fogIsLitByGrid`). A coarsened cell size and a scene left out because baked light wins are each logged once with a console warning. `node scripts/make-canopy-street-scene.mjs <folder>` writes the test street (code-built trees, a house with an eave, a lawn) as scene files for `render-media.mjs --scene file`; the numbers are in the pull request for #3289.

A scene file that lists its own `pointLights`, `spotLights` or emitting `areaLights` in `renderer.environment` (a portal emits nothing) is lit by them alone, as a GLB with `KHR_lights_punctual` is: the renderer's studio fill goes off, and so does the studio key, unless the file writes `keyIntensity`, `fillIntensity`, `lightDirection` or `keyColor` itself, which then wins (#2765). A scene file with no lights of its own keeps the studio key and fill. The HDRI sun of the previous paragraph still becomes the key when the file names no key.

## Verification

`node --test tests/gltf.test.js` covers generated GLB triangles and the existing `exportGlb` roundtrip.
The tests cover parent transforms, missing normals, UVs, shared geometry, PBR factors, mirrored winding, and animation seeks.
The tests also cover input limits, unsupported features, compressed image dimensions, and oversized fetch cancellation.

`node --test tests/gltf-extensions.test.js` covers texture transform baking, instancing, ignored material extensions and the decoder options.
The meshopt tests decode real encoded buffers (all modes and filters, a fixture encoded in the test) without any option.
The Draco and KTX2 tests use stand-in loaders, because no encoder is installed: they prove the wiring, not the wasm decoders.

`tests/fixtures/textured-triangle.gltf` contains an original triangle and a generated two-pixel-square PNG.
Chrome loading preserved its UVs, linear material factors, sampler values, and decoded image dimensions.
Renderer integration owns the final textured rendering check.

**Grass on named surfaces (#3290).** A scene file can grow grass on parts of its GLB. Add `environment.groundCover` to scene.json and render with `scripts/render-media.mjs --scene file`:

```json
{ "environment": { "groundCover": [{ "surfaces": "Lawn", "length": 0.12, "density": 900 }] } }
```

- `surfaces` is a node name, a material name, or a list of them. If none match, the error lists the names the GLB has.
- Blades grow on the upward faces of those parts. They skip any spot where another part stands within `length` above the surface, so a path or slab on the lawn stays clear.
- Optional fields: `preset` (`lawn` by default; also `meadow`, `savanna`, `wild`), `density` (blades per square metre), `length` (metres), `color` (`"preset"`, `"surface"` for the surface material colour, or three linear RGB numbers), `wind` (0 to 1, default 1: the share of the scene wind these blades feel) and `seed`.
- The field is seeded and built once, for the first camera frame. Every frame and every rerender draws the same blades. The blades sway with the frame time, so a video shows the wind and a single frame at one time is always the same.
- The limit is 2,000,000 blades for all entries together. Crucible estimates the lowest possible count for each entry (area times density times 0.12) and adds them up. If the total is over the limit, it refuses before it grows anything.
- Wind is per field. The wind moves a blade tip by metres, so a short lawn under the scene wind (0.3 unless `frame.wind` sets it) would lie flat. The ground-cover blades feel the scene wind times `length` over 0.6 m (0.06 for 0.12 m blades at the default wind), times the entry's `wind`. Trees and every other grass field keep the scene wind exactly. Scaling by length inside the shader is #3347.
- A scene without the field loads nothing and renders as before.
- `showcase.html` does not draw it. It logs a warning and ignores the field.
- Measured: a 16 m lawn at 900 blades per square metre has 182,561 blades and 1.18 million triangles, and takes 2.4 s to grow.
