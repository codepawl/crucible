# Culling, levels of detail and adaptive resolution

`CrucibleRenderer` skips what the camera can not see and can draw far copies of a model with fewer triangles. Both are decided on the CPU from the camera and the instance matrices alone. A scene that has no off-screen parts and no levels draws as before.

## Culling

On by default, with no schema and no option to set. Each frame the renderer tests every instance of a batch (the parts that share a geometry and a material) against the six planes of the view frustum, using the geometry's bounding sphere scaled by the instance matrix. The colour pass then draws only the instances that touch the frustum. A batch with nothing visible costs no draw call, a batch that is entirely visible uses its full instance buffer as before, and a partly visible batch uploads the visible instances once.

What is not culled, because its bounding sphere would not hold or because it draws in another pass:

- Skinned and morphed parts. A crowd part (a character baked to a palette, see [Crowds](retarget.md#crowds)) is the exception: its instances are culled by a bound that covers every pose of the clip, and it takes `lods` whose levels carry the same joints.
- `water`, `fire` and `smoke` materials, whose vertex shader moves vertices.

`foliage` and `grass` sway in the wind but by a known amount, so they are culled and take levels like rigid parts: the bound of each instance grows by 0.56 times the wind strength (the farthest `windOffset` in the vertex shader moves a vertex per unit of strength).
- Parts with an `assembly`.
- Alpha-blended, `liquid` and `foam` batches.
- The shadow passes. A caster outside the view can still shadow the view, so shadow maps draw every caster.

Pass `culling: false` to the `CrucibleRenderer` options to turn it off, for example to compare a picture.

## Many copies from one part

A part can draw many copies of itself from one typed array, instead of one part object per copy:

```js
const matrices = new Float32Array(1000 * 16); // 4x4 column-major, one per copy, in the part's own space
const colors = new Float32Array(1000 * 3);    // optional: red, green, blue per copy
const crowd = { name: 'crowd', geometry, matrix: mat4.create(), material, instances: { matrices, colors, version: 0 } };
const renderer = new CrucibleRenderer(canvas, [crowd]);

// each frame: edit the arrays in place, then tell the renderer
matrices[index * 16 + 12] = x;
crowd.instances.version++;
renderer.updateParts([crowd]);
```

The renderer draws each copy at `crowd.matrix * copy matrix`, batches the copies with the parts that share the geometry and material, and culls and picks levels of detail for each copy as for a separate part. `instances.opacities` (one number per copy, for `blend` and `add` materials) multiplies the material opacity, and `colors` replace the material colour of a copy. Neither splits a batch.

- Marking the list dirty: raise `instances.version` after an in-place edit, or call `renderer.updateInstances(part)`. `updateParts` repacks and uploads the copies only when the version, the part's matrix, its `visible` flag or its fade changed (or its material, which then takes the full material checks); an unchanged list uploads nothing. A colour or opacity edit needs the new version too.
- Limits: `matrices.length` is a multiple of 16 and at most 65,536 copies (the limit of glTF instanced nodes); `colors` has 3 numbers and `opacities` 1 per copy; every value is finite. Anything else throws an error that says what to pass.
- A copy with a zero scale (a matrix that cannot be inverted) is hidden, so zero it to remove a copy without changing the count.
- Changing the number of copies, or giving the part another `instances` object, needs `replaceParts`. A skinned or morphed part cannot take an instance list yet.
- A part without `instances` is packed and drawn exactly as before.

## Levels of detail

Give a part `lods`, the array that `generateGeometryLods(geometry, { ratios })` returns (`generateAssetLods` gives one asset per level, so use the geometries of its parts). Level 0 must be the part's own `geometry`. Parts with the same geometry and the same `lods` array share one batch, and each instance picks its own level.

```js
const levels = generateGeometryLods(rock, { ratios: [0.25, 0.06] });
const parts = positions.map((position, index) => ({ name: `rock-${index}`, geometry: rock, lods: levels, matrix: translate(position), material }));
const renderer = new CrucibleRenderer(canvas, parts, { lodPixelError: 1 });
```

An instance uses the coarsest level whose `error` (the farthest its vertices lie from level 0, in geometry units, times the instance's largest scale) covers at most `lodPixelError` pixels on screen at its distance. The default is 1 pixel. Level 0 is always allowed, so a close instance is never reduced.

`lods` is refused for the parts that culling skips (the list above), because their levels could not be chosen from a bounding sphere.

## Cross-fades and impostor levels

`lods` switch a mesh by its pixel error and do not fade. The vegetation addon chooses its own levels by distance (`selectLevels`) and can fade between them: `selectLevels(instances, eye, { fade: 0.06 })` draws both levels near a threshold with complementary screen-door coverage (a mask material whose `opacityBias` carries the coverage; the code registers when the vegetation addon is imported), `pixelError: { pixels, height, fov }` sets the switch distances from an error in screen pixels (4 pixels on a 1080 pixel high view with a 60 degree field of view gives the default distances), and `impostors` adds a last level that draws one baked card per tree (material tag `impostor`), which shows a stochastic blend of the four baked views around the viewing direction. Culling treats the card as a rigid part: its bounding sphere holds the quad, and the sway is a few centimetres. These choices depend on the distance and the view only, so they keep the determinism below; see [Vegetation](https://crucible.codepawl.com/vegetation.md#impostors-and-cross-fade).

## Determinism

The selection is a pure function of the geometry, the instance matrices, the camera and the canvas height. It keeps no state between frames, so a seek to any time draws the same instances at the same levels as playing up to it. `tests/render-culling.test.js` checks this on the selection, and `npm run benchmark:runtime` draws the first frame again after every measured frame and fails when the picture differs.

## GPU timing and adaptive resolution

`createGpuTimer(context)` from `src/adaptive-quality.js` wraps `EXT_disjoint_timer_query_webgl2` (it returns `null` without the extension). Pass the function itself as the `createGpuTimer` option of `CrucibleRenderer` and the renderer times each frame. A result arrives a few frames late, so `renderer.gpuMilliseconds` holds the latest finished one, or `null` after a disjoint measurement. Without the option nothing is timed and the timer code is not bundled.

`createAdaptiveResolution({ exporting: false, targetMilliseconds, minimumScale, step, window, raiseBelow })` from `src/adaptive-quality.js` returns a controller. Feed it one frame time per frame with `update(milliseconds)` and multiply the pixel ratio by the scale it returns. It lowers the scale by one `step` when the average of `window` frames is over the target, raises it only after a whole window under `raiseBelow` of the target (default 0.6, above 0 and at most 1; anything else throws), and `targetMilliseconds` must be finite and above 0, and never goes below `minimumScale` (default 0.5). `createAdaptiveResolution({ exporting: true })` throws: exports keep full quality, and the live viewer in `src/main.js` builds a controller only when its `export` parameter is not `1`.

## Measured

See `bench/runtime/README.md`, scene `large-outdoor`.

## Fewer MSAA samples on dense meshes

A scan with about one triangle per pixel or more is shaded once per sample at nearly every pixel, so the extra MSAA samples cost fragment work and buy little edge quality. `denseSamples` (renderer option, default `null`, a positive integer) names the sample count to use instead of `samples` when the scene has more than one triangle per pixel of the canvas (triangles over `clientWidth * clientHeight * pixelRatio^2`, `DENSE_TRIANGLES_PER_PIXEL`). It never raises the count, and `null` changes nothing. Every part counts, so one geometry placed many times is as dense as many meshes. `resize()` judges the density again at the new canvas size, so a canvas that grows past the point goes back to `samples` and one that shrinks drops to `denseSamples`, each with new render targets. On a 1.6 million triangle terrain at 1280 by 720, HDR, 4 samples, the frame took 3.7 to 3.8 ms (10th to 90th percentile 3.2 to 4.0) and 3.0 to 3.1 ms (2.7 to 3.4) with `denseSamples: 2`, 2.1 ms with `denseSamples: 1`; 1 percent of the pixels differ by more than 11 of 255 against 4 samples at 2, and 14 at 1 (#1163).

## Levels for textured scans

`generateGeometryLods` keeps the uvs, light uvs, colours and normals of a geometry that has them: each level is the geometry with some edges collapsed onto a vertex that stays, so no attribute is blended. Vertices on a UV seam, a hard edge or an open border never move, and a level can keep more triangles than its ratio when those vertices leave no safe collapse. `error` is the square root of the largest quadric cost of any collapse so far, an estimate of how far the surface moved, so it is a distance in the geometry's units (each plane counts once, so scaling the mesh by k scales it by k) and sits on the cautious side for small meshes with many seams. A geometry may have at most `MAXIMUM_SIMPLIFY_TRIANGLES` triangles and `MAXIMUM_SIMPLIFY_VERTICES` vertices (2 million each); a bigger one throws a RangeError, so split the part or skip levels for it (`addLodsToDenseParts` leaves such parts as they are).

`addLodsToDenseParts(parts, { pixels })` from `src/dense-lods.js` gives levels to the parts of a scene that has more than one triangle per pixel (`pixels` is the canvas width times its height times the pixel ratio squared). A part gets levels when it has at least `minimumTriangles` (default 4000, so a scene of many meshes with a few thousand triangles each gets them too, #2144, #2157) triangles and can take them; parts with the same geometry share one set. It returns `parts` itself for a scene under the density. It is not applied by itself, and it takes seconds on a million triangles, so call it once while loading. On the Monster scene (1.6 million triangles, 1280 by 720, 4 samples) called with the canvas size, the frame went from 5.8 to 1.9 ms, and Lone Monk (5.6 million) from 15.4 to 9.5 ms (measured before the error metric was changed to a distance); the picture changes slightly (root mean square 2.0 of 255), because far parts draw from coarser levels (#1163).

A scene file (`scene.json`, rendered by `scripts/render-media.mjs --scene file`) gets the same levels by default; `"renderer": { "denseLods": false }` keeps every triangle of a dense scan. A scene file also picks levels at `lodPixelError` 0.5, not the renderer's 1, so far detail shimmers less; `"renderer": { "lodPixelError": 1 }` restores the old choice (#2157). With the option on, `partsForRendererOptions` in `src/dense-lods.js` calls `addLodsToDenseParts` at the canvas size and pixel ratio before the renderer is built (#1163). A `pixelRatio` outside 0.1 to 16, and a `minimumTriangles` or `minimumTrianglesPerPixel` that is not a number from 0 to 1e9, throws a RangeError that names it (#2552).

On Lone Monk seen from the courtyard (a camera that shows the scene, 1280 by 720, 4 samples), drawing from the levels of parts of 4000 triangles and up, not 20000 and up, sent 1.06 million triangles instead of 1.80 million and cut the GPU frame from 4.36 to 3.38 ms (1500 and up: 3.51 to 3.62 ms, 8000 and up: 3.30 ms) (no levels at all: 3.26 million triangles, 7.12 ms). The picture differs from the 20000 floor by a root mean square of 1.74 of 255 (2.51 from no levels). `node bench/glaze-passes/run.mjs <out.json> <scene directories> whole '{"denseLods":true,"denseLodsMinimumTriangles":4000}'` measures it; `'{"engine":"three"}'` draws the same file with three.js, and `bench/glaze-passes/still-pair.mjs` writes the picture pair and the RMSE (#2144).

A camera move shows what the levels add between frames (#2157). Add `"sequence":{"directory":"<frames>","frames":60}` to the options to write 60 frames of a dolly from 6 m behind the camera to 5 m in front of it, and run `node bench/glaze-passes/sequence-metrics.mjs <frames drawn with denseLods false> <frames>[,<frames>]`: it prints shimmer (the high-passed frame-to-frame difference over the detailed tenth of the picture), addedShimmer (the same on the error against the move without levels) and popSpike (the biggest jump of that error beyond its neighbours). On Lone Monk the floors 4000, 8000 and 1500 gave the same addedShimmer, 1.16 against 0.76 at 20000 (the move's own shimmer is 12.6 of 255, with or without levels), and a popSpike of 0.42 against 0.63 at 20000. The extra shimmer comes from the meshes of 8000 to 12000 triangles, which is also where the saved triangles are, so no floor between 1500 and 8000 separates speed from shimmer; `lodPixelError: 0.5` brought it to 0.87 for 1.28 million triangles and 4.04 ms.

`npm run bench:scene-frames -- <scene directory> [<scene directory>...]` renders each scene file's own camera at 320 by 180 and exits 1 when the frame is nearly one colour (mean luminance step between neighbouring pixels under 1 of 255). A camera behind a wall gave Lone Monk a white frame that no timing or RMSE could use (0.32 flat; the other benchmark scenes measure 2.4 to 7.8), and the same check flags the Barbershop scene (#2158). The detector is `bench/scene-frames/uniform-frame.mjs`. The scene directories are generated locally and are not in git, so the cameras that fix both scenes are committed in `bench/scene-frames/camera-overrides.json` (scene name to `eye` and `target`); the sweep writes them into each directory's `scene.json` before it renders.
