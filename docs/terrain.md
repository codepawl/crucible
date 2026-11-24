# Terrain and splat ground

`crucible/addons/terrain` and `crucible/addons/texture-set` are available from version `0.10.0`.
Together they replace a flat, noise-tinted ground with a chunked heightfield and a four-layer ground material made from real scanned textures.

```js
import { CrucibleRenderer } from 'crucible';
import { loadHdri } from 'crucible/addons/hdri';
import { createTerrain } from 'crucible/addons/terrain';
import { loadTextureSet } from 'crucible/addons/texture-set';
import { scatterVegetation } from 'crucible/addons/vegetation';

const terrain = createTerrain({ size: 600, chunks: 10, resolution: 32, levels: 4, seed: 11 });
const [grass, forest, mud, rock] = await Promise.all(
  ['leafy_grass', 'forest_ground_04', 'brown_mud_leaves_01', 'aerial_rocks_02'].map(name => loadTextureSet(`/textures/${name}`)),
);
const material = {
  color: [1, 1, 1], metallic: 0, roughness: 1,
  layers: [
    { ...grass, scale: 3.2, tint: [0.58, 0.88, 0.38] },
    { ...forest, scale: 3.5 },
    { ...mud, scale: 2.6 },
    { ...rock, scale: 6, triplanar: true },
  ],
  splat: {
    rules: [undefined, { height: [-9, -2] }, { mask: 'r' }, { slope: [31, 90] }],
    maskMap: pathWeights, maskBounds: [-300, -300, 300, 300],
  },
};
for (const part of terrain.parts) part.material = material;

const trees = scatterVegetation({ area, terrainHeight: terrain.heightAt, slopeLimit: 24, leaves: 'cards' });
const renderer = new CrucibleRenderer(canvas, [...terrain.parts, ...treeParts], { world: true, ground: false, hdr: true, environment: { map: await loadHdri('/hdri/sky.hdr') } });
```

Each frame, `if (terrain.update(eye).length) renderer.replaceParts(sceneParts)` swaps the chunks whose level of detail changed.
Textured parts such as leaf cards can be added and removed in `replaceParts` after `import '@codepawlhq/crucible/addons/replace-textured-parts'`; their textures are freed once no part uses them.

## loadTextureSet

`loadTextureSet(baseUrl, { channels, extension = 'webp', colorSpaces, fetchBlob, decodeBlob })` fetches `<baseUrl>/color.webp`, `normal.webp`, `roughness.webp` and `height.webp` and returns `{ color, normal, roughness, height }` texture descriptors (`{ image, colorSpace }`).

- `color` is `srgb`; `normal`, `roughness` and `height` are `linear`. Normal maps use the OpenGL convention (green up), as the Poly Haven files in `public/textures/` do.
- Without `channels`, every channel that exists loads and a missing file is skipped (the bark scans have no height). With `channels: [...]`, a missing file throws.
- Decoding uses `createImageBitmap` with colour conversion off. In Node, pass `fetchBlob` and `decodeBlob`; the splat code also accepts `{ width, height, data }` pixel objects.
- The result spreads into a layer: `{ ...set, scale: 4 }`.

## Splat material

A material with `layers` (1 to 4) draws as splat ground. It needs a standard PBR tag (no `terrain`, `floor` and the like) and no `map`, `normalMap`, `metallicRoughnessMap` or `occlusionMap`; the layers replace them. `color` multiplies the result.

| Layer field | Meaning |
| --- | --- |
| `color`, `normal`, `roughness`, `height` | Descriptors from `loadTextureSet`. Missing ones fall back to mid grey, a flat normal, roughness 1 and height 0.5. |
| `scale` | Metres per texture tile (default 4). |
| `tint` | RGB multiplier on colour. |
| `normalStrength` | Scales the normal map tilt (default 1). |
| `triplanar` | Project from the sides on steep slopes, so cliffs do not stretch. |

`material.splat` holds `rules`, one entry per layer (or `undefined`):

- `slope: [minimum, maximum]` in degrees from horizontal, `height: [minimum, maximum]` in world metres, each with `slopeSoftness` (default 4) and `heightSoftness` (default 1.5) as the half-width of the fade.
- `mask: 'r' | 'g' | 'b' | 'a'` multiplies by a weight channel. `invertMask: true` flips it. The weights come from vertex colours (`r`, `g`, `b` only) or, when `splat.maskMap` is set, from a linear texture stretched over `splat.maskBounds = [minimumX, minimumZ, maximumX, maximumZ]`. The first image row is `minimumZ`.
- A layer with no rule takes what the other layers leave, so put grass first with no rule.

Other `splat` options: `heightBlend` (0.22) and `heightInfluence` (1) control how strongly the height maps decide who wins at layer edges, so grass fills the gaps between rocks instead of fading linearly; `triplanarStart` and `triplanarEnd` (38 and 52 degrees) set where side projection fades in, and a face never takes more side projection than its normal gives (a 30 degree bank stays on the top plane, a 60 degree one takes about nine tenths from the sides), so a low `triplanarStart` does not stretch gentle slopes; `antiTiling` (0 to 1, default 1); `cavity` (0 to 1, default 0.55) darkens low parts of the height map; `textureSize` caps the common layer size.

Two options keep large ground from looking flat. `variation` (0 to 2, default 1) drifts brightness and hue at three scales, about 120 m, 20 m and 3 m, with dry and lush patches. The 3 m octave grows with distance, where texture detail averages out. `edgeNoise` (0 to 2, default 1) jitters the slope and height that the rules see, by up to 9 degrees and 1.6 m, so a mud flat or a rock band gets a ragged border instead of a contour line. Set either to 0 to turn it off.

`parallax` (0 to 0.15 m, default 0.03) gives near ground relief: the top-down texture slides along each layer's height map toward where the view ray meets it, refined in three steps. It runs only on pixels close to the camera and is capped, because deep parallax stretches the height map into spikes at grazing angles. At the default it measured within noise of off (about 10.5 ms a frame either way, 1280 × 720, RTX 3060). It reads best in motion and from above; at a grazing eye height it mostly flattens the texture. Set it to 0 to turn it off.

Shading: world-space XZ UVs, a second rotated sample at 0.58 times the scale mixed by low-frequency noise (with contrast restored) so repetition is not visible from afar, normal tilts added in world space, roughness from the maps, and a slow macro brightness and dryness variation.
Materials batch together only when they share the same `layers` array and `splat` object, so build them once and assign them to every chunk.

Memory: three `TEXTURE_2D_ARRAY`s on units 11, 12 and 17 (sRGB colour, normal, roughness in red with height in green), all layers resized to the largest source (at most `MAX_TEXTURE_SIZE`), with mipmaps and up to 8x anisotropic filtering when the extension exists. The weight texture uses unit 14, so unit 13 stays with the tinted shadow map and a blended caster throws its coloured shadow on splat ground like on any other surface. The renderer counts them in `memoryBudgetMiB` and reports them as `renderer.splatBytes`. Four 1K layers take 64 MiB; set `textureSize: 512` to quarter that.

## createTerrain

`createTerrain({ size = 512, resolution = 32, chunks = 8, levels = 4, height, seed = 1, material, lodDistance, eye })` returns `{ parts, heightAt, normalAt, bounds, update, triangleCount, chunkSize, chunkLevels }`.

- The ground spans x and z from `-size / 2` to `size / 2`. `chunks` per side, each with `resolution` cells at level 0 (so `resolution` must divide by `2 ** (levels - 1)`). Level `n` uses `resolution / 2 ** n` cells. `chunks` is at most 64 and `chunks * resolution` at most 4096 cells per side; larger values throw a RangeError before any memory is allocated.
- `height` is a function `(x, z) => metres`, a square array or typed array (`Float32Array`, `Float64Array`) of metres stretched over the ground (`heightmapFromImageData(imageData, amplitude)` builds one from an image), or noise options: `amplitude` (hills, 14), `mountainAmplitude` (46), `featureSize` (160 m), `octaves`, `gain`, `lacunarity`, `warp` (domain warp in metres), `baseHeight` and `mountainMask(x, z)` (0 to 1, where ridged mountains replace hills). Hills use slope-damped octaves and mountains use ridged multifractal noise, which gives smooth flanks, sharp crests and carved valleys. The same `seed` always gives the same ground.
- `heightAt(x, z)` walks the same triangles as the level 0 mesh, so it matches the rendered surface there (coarser levels differ by their simplification). Coordinates outside the ground clamp to its edge. `normalAt` interpolates smooth grid normals.
- `update(eye)` picks a level per chunk from its distance (`lodDistance`, a positive finite number of metres, default 1.6 chunk sizes, doubling per level) and returns the parts whose geometry changed. Edges shared with a coarser neighbour are snapped onto the neighbour's edge, so there are no cracks and no skirts.
- UVs are world metres `(x, z)`. Vertex normals are smooth and shared across chunk borders.

## Holes

`createTerrain({ holes: [{ center: [x, z], radius }] })` (up to 64 circles, radius in metres) leaves no surface where a cell centre falls inside a circle, so a cave mouth or a shaft opens through the ground. `terrain.isHole(x, z)` tells whether a point is inside one. `heightAt` and `normalAt` ignore holes and still return the surface that would be there, so check `isHole` before standing something on it. A coarser level of detail cuts a coarser hole (its cells are bigger), so give a hole a radius of a few finest cells at least. A hole that covers a whole chunk gives that chunk empty geometry. Without `holes` the meshes are byte-identical to before (a test keeps a digest).

In a recipe, the same ground is the `terrain` geometry: see [Recipe terrain](#recipe-terrain) and [agent-scene](agent-scene.md). There, holes that remove every cell are refused with an error on `geometries[i].holes` (lower a radius or move a center), and a hole that removes no cell, because it does not reach a cell centre, returns a `terrain-hole-removes-no-cell` warning with the cell size (`size / resolution`) and the smallest radius that removes one. `scene_export_glb` names the node whose mesh has no triangles.

## Paths

`paths` carves roads, trails and riverbeds into the ground and gives each one a mask. It works in `createTerrain({ paths })` and in the recipe `terrain` geometry. At most 16 paths of 2 to 256 points `[x, z]` in metres each.

| Field | Meaning | Range (default) |
| --- | --- | --- |
| `points` | the centre line: a curve through them, or straight segments with `smooth: false` | 2 to 256 points |
| `width` | metres across the carved bed | 0.1 to 200 (3) |
| `depth` | metres the bed sits below the ground at the centre line | 0 to 20 (0.2) |
| `falloff` | metres on each side where the bed blends back into the hills | 0 to 200 (`width`) |
| `ruts` | depth in metres of two wheel grooves at 0.225 of the width from the centre, so the strip between them is about as wide as one groove | 0 to 2 (0) |
| `crown` | metres the middle of the bed rises above its sides | 0 to 2 (0) |
| `shoulder` | metres of a lip raised beside the road, in the middle of the falloff | 0 to 2 (0) |
| `smooth` | `true` runs a Catmull-Rom curve through the points, sampled every `width / 4` metres; `false` keeps straight segments | true or false (true) |
| `name` | name of the mask | 1 to 64 characters (`path0`, `path1`, ...), no two alike |

- The bed is level across its width at the height the ground has under the nearest point of the centre line, minus `depth`, so a road across a slope is cut into the hillside. Paths apply in order after the noise. The same seed and points give the same heights.
- The carve changes the height grid, so the mesh, `heightAt`, `normalAt` and vegetation all see the road.
- `terrain.pathMasks` is `null` without paths. Otherwise `names` lists the masks, `at(name, x, z)` gives 0 to 1 (1 across the width, fading to 0 over half the falloff; no name gives the strongest of all paths), and `image(name, resolution = 256)` gives `{ width, height, data, bounds }` RGBA pixels with the mask in red. Use it as a splat `maskMap` with `maskBounds: [-size / 2, -size / 2, size / 2, size / 2]` and the rule `{ mask: 'r', invertMask: true }` on grass and `{ mask: 'r' }` on dirt.
- A recipe does not draw splat materials yet, so the mask feeds the splat rules of an addon scene. Clutter or vegetation `exclude` can read `pathMasks.at(name, x, z)` the same way; the recipe `exclude` field takes only circles and nodes today.
- Cost: segments sit in a grid, so a sample reads only those near it. A smoothed path of 256 points is at most 8192 segments in all.
- Looks: a cut bench reads best with `depth` 0.7 to 1, `falloff` 1 to 1.5 (a steep bank; a wide falloff gives a soft slope), `shoulder` 0.3 and a road layer with `triplanar: true` and `splat.triplanarStart` near 12 so banks do not stretch the texture. A rut is as wide as about a quarter of the half-width, so give the ground cells of 0.1 m or less (a 40 m ground at resolution 400) to see two clear grooves; at 0.5 m cells they blur.

## Terrain near water

A terrain near water needs nothing set. When `applyWaterReflection` finds a water surface in the scene, every terrain part it is given builds up to two extra coarse meshes per chunk (as many halvings as the resolution allows) that only the water reflection draws; `attachWaterReflection` takes `scale` (0.05 to 1 of the canvas, default 0.75) and `updateEvery` (0 to 1000 lit frames) and refuses other values; it hides them from every other draw. This is one build of about 130 ms in `applyWaterReflection`, before the renderer exists, so no frame waits for it. The first call with water builds the coarse levels (about 0.1 s and 22 MB), so call it during setup, before the animation starts. Terrain in a scene without water builds nothing extra: its memory and build time are what they were. Pass `mirrorLevels` to choose the count yourself; `mirrorLevels: 0` keeps the plain terrain even next to water, and a number you set is built when the terrain is created, as before. Measured on a 900 m terrain at resolution 128 with 8 by 8 chunks: the levels add about 22 MB of mesh data (the finest level is 61 MB). In return the mirror frame of the water benchmark (960 by 540, RTX 3060, median of 240 samples) costs +25% over reflection off instead of +40%.

## Heightfield from rasters

`crucible/addons/heightfield` builds a mesh from georeferenced rasters (heights, a mask, a photo) when `createTerrain` does not fit, such as a shoreline cut from a sea mask. A raster is `{ values, width, height, box: { x_min, x_max, y_min, y_max } }`, pixel centres on the box, row 0 at the north edge.

- `sampleRasterGrid(raster, { columns, rows, eastAt, northAt, cellSize, samplesPerSide, scale })` returns a `Float64Array` with the mean of the raster over a square cell around each vertex (`cellSize` 0 with one sample reads the raster at the vertex). The mean of bilinear samples is a weighted sum of pixels, so it runs as two passes over the pixels, not 16 bilinear reads and an allocation per vertex.
- `createHeightfieldGeometry({ columns, rows, eastAt, northAt, heights, uvBox, keepCell })` returns `{ positions, normals, uvs, indices }` in one pass over typed arrays, with `keepCell(column, row)` dropping cells a finer tier covers.

Combine the sampled arrays into `heights` in your own loop (for a sea mask: lower the vertex by the mask share), then build the geometry. A test pins the output against the per-vertex build it replaces: positions, normals, uvs and indices are bit-equal.

Measured on the AIS port film (4.9 M vertices over three tiers, 10 m core mesh, sea mask averaged over each cell), page open to `stageReady`, RTX 3060, headless Chrome on ANGLE D3D11, four runs while other sessions loaded the machine: 5.5 to 13.1 s before (5.5 to 6.7 s in the quiet runs), 3.6 to 9.6 s after (3.6 to 3.7 s in three of four runs), against 1.0 to 1.4 s for the three.js build of the same scene. The terrain code fell from about 3.4 s of CPU to about 0.6 s; the frame at film second 1 is pixel-identical (max difference 0 of 255). With bitmaps for the images and the programs linking during the uploads, the same page loads in 2.8 to 6.6 s (2.8 to 3.4 s in the two quietest runs; three.js 1.1 to 2.1 s in the same runs), and the frame is still pixel-identical. What stays: mask readback (about 0.3 s), texture upload (about 0.35 s), the two raster passes (about 0.5 s) and building meshes in the port's own code. The three.js build does the shoreline per pixel in a shader, so it needs no mask pass.

### Moving a per-vertex mask sampler over

If you sample a mask yourself (a bilinear read or a cell mean for every vertex, through a closure), switch to `sampleRasterGrid` and `createHeightfieldGeometry`. The values and the mesh stay the same, and the work drops from a call per sample to two passes over the pixels:

```js
// before: 16 bilinear reads and a closure call for every vertex
const heightAt = (east, north) => groundHeight(bilinear(heights, east, north), cellAverage(mask, east, north, spacing));
const geometry = gridGeometry({ columns, rows, eastAt, northAt, heightAt, uvBox });
// after: the whole grid at once, then the mesh
const lines = { columns, rows, eastAt, northAt };
const share = sampleRasterGrid(mask, { ...lines, cellSize: spacing, samplesPerSide: 4 }), raw = sampleRasterGrid(heights, lines);
const geometry = createHeightfieldGeometry({ ...lines, heights: Float32Array.from(raw, (value, vertex) => groundHeight(value, share[vertex])), uvBox });
```

Load images as `createImageBitmap(await (await fetch(url)).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })` and pass the bitmap as a texture `image`. The renderer accepts it, it decodes off the main thread, and `texImage2D` from a bitmap takes about 0.2 of the time it takes from an `Image` (measured on 24-megapixel JPEGs: 64 ms against 300 ms), with identical pixels. The renderer also starts every program before it uploads textures and buffers, so the driver links them while the upload runs.

Where the rest of the port's load goes (marks in a scratch copy, ms from navigation, quiet run of 2.7 to 3.4 s against 1.1 to 1.2 s for three.js): images and heights decoded by 0.65 s, four mask readbacks done by 0.94 s (each 24-megapixel image costs about 20 ms to draw, 37 ms to read and 19 ms to copy the channel, all in the browser), meshes by 1.5 s (the two raster passes are at about 50 ms per 24-megapixel mask in plain JavaScript, so a summed-area table would not help: the bilinear weights differ per vertex), buildings by 1.97 s, `applyWaterReflection` by 2.06 s, the renderer constructor by 2.9 s. The port runs these one after the other: reading each mask as its image arrives, starting the building fetches with the images, and building the three tiers while the next tier's mask reads are the steps still open, and they live in the scene's code.

## Navigation

`addons/navmesh` finds walking routes over any triangle ground, so a character can go around holes, steep slopes and obstacles. It is pure JavaScript and gives the same path for the same input.

```js
import { createTerrain } from 'crucible/addons/terrain';
import { createNavmesh } from 'crucible/addons/navmesh';
// One chunk covers the whole ground, so its geometry is the walkable surface. A terrain of many chunks has one geometry per chunk.
const walkable = createTerrain({ size: 40, chunks: 1, resolution: 64, levels: 1, seed: 11 });
const { positions, indices } = walkable.parts[0].geometry; // world space, Y up
const navmesh = createNavmesh({ positions, indices, agentRadius: 0.3, maxSlopeDegrees: 40, obstacles: [{ min: [4, 4], max: [6, 6] }] });
const { points, length, searchNodes } = navmesh.findPath([-15, -15], [15, 15], { spacing: 1.5 });
```

- **Grid:** one cell per `cellSize` metres (default the agent radius, at least 0.05 m). Each cell takes the height of the highest triangle over its centre. A cell with no triangle (a hole) or inside an `obstacles` footprint is blocked, and every blocked cell blocks the cells within `agentRadius`, so the path keeps that distance from holes and obstacles. A step to a neighbour that climbs faster than `maxSlopeDegrees` is not allowed. Features thinner than a cell can be missed, so keep `cellSize` under the thinnest wall that matters.
- **Search:** A* over eight neighbours without corner cutting, then line-of-sight string pulling, so the route is a few straight legs rather than a staircase. `points` are `[x, y, z]`, resampled every `spacing` metres (at most 200 points; a route with more than 200 corners throws a `RangeError`, so split a long winding trip into legs) with y read from the surface.
- **Budgets:** `maxCells` (250,000) and `maxSearchNodes` (200,000) throw a `RangeError` that says what to raise. A start or goal in a hole, outside the ground or too near an obstacle, and a goal cut off by holes, throw with the reason.
- **Measured** (40 m rolling ground at 64 cells, one 3 m hole, agent radius 0.3, corner to corner, Node on the Windows PC): 17,956 cells built in 13 ms, a path of 43.04 m (straight line 42.43 m) in 35 ms with 4,245 search nodes and 30 points.

In an agent scene, `scene_inspect` takes `path: { ground, from: [x, z], to: [x, z], avoid, radius, maxSlope, cellSize, seconds, speed, lift, spacing }` and returns keyframes for a node translation track (`LINEAR`). `ground` is a node ID, `avoid` lists node IDs whose box footprints block. It reads the authored pose and changes nothing. Details are in `scene_capabilities` under `navigation`.

## Recipe terrain

The `terrain` geometry of a recipe calls `createTerrain` with these fields. A field you leave out keeps today's value, so an older recipe draws the same heights.

| Field | Meaning | Range (default) |
| --- | --- | --- |
| `size`, `seed`, `amplitude` | ground width in metres, noise seed, hill height | 1 to 2000 (40), whole 0 to 2147483647 (1), 0 to 200 (1) |
| `featureSize` | width of one hill in metres | 0.01 to 10000 (`size / 4`) |
| `octaves` | noise layers; fewer is smoother | whole 1 to 8 (6) |
| `warp` | metres a slow noise pushes the ground sideways, which bends valleys; a warp near `featureSize` stretches the noise into steep, jagged slopes (a 110 m warp on 150 m features did) | 0 to 1000 (0) |
| `ridged` | `true` grows ridged mountains in the patches the library picks | true or false (false) |
| `mountainMask` | one share of ridged mountains over the whole ground; not together with `ridged` | 0 to 1 (0) |
| `mountainAmplitude` | height of the ridged mountains in metres | 0 to 500 (46) |
| `chunks`, `levels` | chunks per side, levels of detail | whole 1 to 64 (1), whole 1 to 6 (1) |
| `resolution` | cells per chunk (the whole ground when `chunks` is 1) | whole 2 to 499 (64) |

- A scene allows 250000 vertices by default and every chunk is its own mesh, so `chunks * chunks * (resolution + 1) ** 2` must stay under it. 499 cells is the largest single ground (250000 vertices, about 15 MB of geometry, under the 32 MB cap). The error names the vertex count and the cap.
- `resolution` must divide by `2 ** (levels - 1)`, and `chunks * resolution` is at most 4096 cells per side, as in `createTerrain`.
- A record with `chunks` or `levels` above 1 is built at its finest level, and the scene swaps in the level each chunk needs for the camera at every pose: each frame of a render job and each time of a camera track. The mesh is the same object while no chunk changes level. `heightAt`, vegetation and navigation read the finest grid, so heights do not depend on `chunks` or `levels`. A moved or scaled ground sees the camera in its own space.
- `holes` cut cells of the whole ground (`chunks * resolution` across).
- `paths` carve roads: see [Paths](#paths).

## Voxel terrain

`createVoxelTerrain` turns a grid of cells, each with an occupancy and a material, into smooth land and water meshes. It is for terrain that arrives as voxels, such as a Roblox Studio export, and it keeps caves, overhangs and arches that a heightfield cannot hold.

```js
import { createVoxelTerrain } from 'crucible/addons/terrain';

const { parts, bounds } = createVoxelTerrain({
  grid: [256, 64, 256],   // cells along x, y (up) and z
  cellSize: 4,            // metres per cell
  occupancy,              // 256 * 64 * 256 numbers from 0 (empty) to 1 (full), x fastest, then y, then z
  materials,              // one palette index per cell, in the same order
  palette: ['grass', 'rock', 'sand', 'water'], // the default
});
renderer.replaceParts([...parts, ...otherParts]);
```

- **Smooth surfaces.** The occupancy is blurred over the neighbouring cells (`smoothing` passes, 1 by default, 0 to 4) into a signed field and meshed with surface nets, so a slope is a slope and not a staircase. A cell that is partly full moves the surface by less than a cell, as Roblox terrain does. Features thinner than two cells fade at `smoothing: 1`; use `0` to keep single-cell features (blocky) or fill them.
- **A look per material.** The land is one part. Each vertex blends the colour of the materials of the cells around it, so grass meets rock without a seam, and brightness drifts a little so flat ground does not read as flat. The built-in names are `grass`, `rock`, `sand`, `dirt`, `snow` and `water`; `looks: { moss: { color: [0.1, 0.25, 0.08], variation: 0.2 } }` adds more (linear RGB, `variation` 0 to 1). `materialIds` holds the strongest material of each land vertex, for code that wants to put a splat, a sound or a prop by material.
- **Water.** Cells with the `water` material become a second part, `Voxel water`, with the `water` material tag, at the top of each body. A cell holds one material, so a shore cell that is partly ground has no room for water; water touching it from above or from the side counts as filling it, which lets the surface run up to the bank instead of stopping on a column of cells. The surface is pressed flat per body (it would otherwise climb the bank) and sits a tenth of a cell under the land, so the shoreline is where the land crosses the water.
- **Edges.** `edges: 'open'` (default) continues the outer cells outward, so the landscape is cut cleanly at the grid bounds with no wall; `'closed'` adds side walls and a base like a diorama; the walls hang from the boundary of the same smooth surface (never a per-cell staircase). The walls and base are one flat earth colour, cut hard from the top colours (the top surface never blends into them); `stats.wallTriangles` counts the wall triangles, which are listed last in `indices`.
- **Output.** `{ parts, materialIds, palette, bounds, stats }`. `parts` are plain parts (`geometry` with `positions`, `normals`, `uvs`, `colors`, `indices`) in world space, with the grid minimum corner at `origin` (default `[0, 0, 0]`). The same input gives the same bytes. `stats` holds vertex and triangle counts and the meshing time.
- **Bounds.** Each axis is 2 to 512 cells and the grid at most 16,777,216 cells; split a bigger landscape into tiles. A bad `grid`, `cellSize`, `occupancy`, `materials`, `palette`, `smoothing` or `edges` throws an error that names the field, what it got and what to pass. A grid with no surface (empty or full) throws too.

Meshing a 256 x 64 x 256 landscape with a lake takes about 2 to 4 seconds on one CPU thread (`node scripts/measure-voxel-terrain.mjs`), and gives about 110,000 vertices. `node scripts/capture-voxel-terrain.mjs <folder>` writes the portrait stills of a small landscape.

## Measured

Windows, RTX 3060, headless Chrome, 1600x900, 4x MSAA, HDRI, shadows, bloom, 600 m terrain with 10x10 chunks at resolution 32 and about 1,000 to 1,750 trees:

| Camera | Terrain triangles | Scene triangles | Batches | Frame |
| --- | --- | --- | --- | --- |
| Low, close to the path | 50,432 | 1.23 M | 164 | 13.8 ms |
| High, whole scene | 12,896 | 0.53 M | 124 | 9.0 ms |

Splat textures take 68 MiB of 74 MiB texture memory at 1K per layer.

## Limits

- Up to four layers; one splat material per draw (chunks share one). More layers are not built: the splat shader has 16 four-wide arrays and loops, the weight texture has four channels, and eight 1K layers would take about 136 MiB against the 74 MiB of texture memory above.
- Routes come from a grid, not a mesh of walkable polygons: no stairs or bridges over one another (the highest surface wins), and no moving obstacles.
- Overhangs are not represented: `createTerrain` is a heightfield. [Voxel terrain](#voxel-terrain) holds them.
- Changing `layers` or `splat` after the renderer exists needs a new renderer.
- The weight texture follows its descriptor's filtering (mipmapped by default); 1024 square over 600 m gives 0.6 m texels.
- Normal-map tilt is added to the geometric normal in world space, which is cheap and stable but not a full tangent-space blend.
