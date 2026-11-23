# Gaussian splats

`crucible/addons/gaussian-splats` draws 3D Gaussian splats, the format that captured rooms, streets and products ship in, behind or among the parts of a scene. It is in the current source and not yet published. It is an optional package: the core renderer has no code for it, so the core bundle does not change, and a scene without splats never loads it. Recipes and the MCP server do not reach it yet: the local asset catalog reads GLB files only, and what the addon costs is recorded below first.

```js
import { CrucibleRenderer } from 'crucible';
import { attachGaussianSplats, createGaussianSplats, parseGaussianSplatPly } from 'crucible/addons/gaussian-splats';

const bytes = await (await fetch('/scene.ply')).arrayBuffer();
const data = parseGaussianSplatPly(bytes, { maximumCount: 1_000_000 });
// Many captures are y-down: this matrix turns the scene upside down and puts it 3 m behind the origin.
const splats = createGaussianSplats(data, { matrix: [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, -3, 1] });

const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false });
const detach = attachGaussianSplats(renderer, splats);
renderer.render(camera); // parts first, then the splats, farthest first
detach();               // or renderer.dispose()
```

`detach()` frees the GPU copy and reads the packed data back, so the same `splats` can then attach to another renderer, for example one made at a new size, without packing them again. Splats attach to one renderer at a time. After `renderer.dispose()` or a lost context, call `createGaussianSplats` again.

## Animated splats

A pour stream, sparks or steam change every frame. Do not create and attach a new set each time: attach one and call `detach.update(change)` on it. It rewrites the changed values and re-uploads only the texture rows they sit in; no texture, buffer or splat set is created.

```js
const splats = createGaussianSplats(first, { capacity: 20_000 }); // room for up to 20,000 splats
const detach = attachGaussianSplats(renderer, splats);

function frame() {
  stepParticles(positions, colors, scales); // your typed arrays, `count` splats each
  detach.update({ count, positions, colors, scales });
  renderer.render(camera);
}
```

`update` takes `positions` (3 numbers per splat), `colors` (4 bytes, the last is the opacity), `scales` (3) and `rotations` (4, needs `scales`; `scales` alone means no rotation), each optional, so a colour-only change uploads colours only. The arrays hold `length` splats that replace splats `start` to `start + length` (`start` default 0, `length` default up to the new `count`). `count` sets the number of splats drawn: it may shrink at any time and grow up to `capacity`, the room fixed at create time (default: exactly the number created, at most the 4,000,000 limit). Growing needs `positions`, `colors` and `scales` for the new splats. `bounds` (`{ minimum, maximum }`) says where the centres are; leave it out and it is measured from the centres. A bad count, range, array or non-finite number throws an error that names the field and what to pass, and the set is not changed. `update` is not available for splats with spherical harmonic bands, and throws after `detach()`. The first update copies the data texture back once. The returned function is still the detach function, so existing code is unchanged.

## What it reads

Two formats. The first is the standard 3DGS PLY that the original training code and most tools write: binary little endian with `x y z f_dc_0..2 opacity scale_0..2 rot_0..3` per vertex. The spherical harmonic bands in `f_rest_*` are read too (degree 1, 2 or 3, worked out from how many there are), so a splat changes colour with the view the way it was trained to: a shine on a car door or the sky in a window moves as the camera moves. `sphericalHarmonicDegree` caps how many bands are kept, from `0` (one colour from every direction, the smallest GPU copy) to `3`, the default. The bands travel to the GPU as half floats, 32, 64 or 96 bytes per splat (the bands plus the part of the constant colour brighter than white, so a highlight a band darkens keeps its trained colour) on top of the 48 bytes of position, shape and colour. Other properties (normals) are skipped. A splat with a non-finite band value is dropped like one with a non-finite position, and `upAxis: 'z'` turns the bands with the positions. `.ksplat` and `.splat` files are not read; `bench/gaussian-splats/fetch-sample.mjs` shows a short `.splat` to PLY conversion.

The second is SPZ, Niantic's format and the output of World Labs Atlas and Marble, about 10 times smaller than the same PLY. `parseGaussianSplatSpz(bytes, options)` is async (it inflates the gzip stream with `DecompressionStream`, so there is no dependency) and returns the same `{ count, positions, colors, scales, rotations, bounds }` with the same options and limits as the PLY parser. It reads versions 2 and 3 and any spherical harmonic degree (the bands above degree 0 are skipped). Version 4 (zstd) is rejected with a message that names the fix. `parseGaussianSplatSpzAsync` also converts in slices and takes `chunkSize`, `onProgress` and `signal` like `parseGaussianSplatPlyAsync`. SPZ positions are in the SPZ axes (x right, y up, z back) while a trainer's PLY is x right, y down, z forward: to place a PLY and an SPZ of the same scene together, give one of them a `matrix` that scales by `[1, -1, -1]`.

```js
const data = await parseGaussianSplatSpz(await (await fetch('/world.spz')).arrayBuffer());
```

A file over `maximumBytes` (default 512 MiB, for SPZ also its inflated size), or one whose header names more than `maximumCount` splats (default 2,000,000, never above 4,000,000), throws a `RangeError` before any splat is read. A file that is not a PLY (or an SPZ: bad gzip, bad magic, unsupported version), is ASCII, lacks a property or is truncated throws an `Error` that names the problem. `createGaussianSplats` applies the count limit again. A PLY may declare fixed-size elements (such as `camera`) before `vertex`, which are skipped; a list element before `vertex` is refused with a message to put the vertex element first. CRLF header lines are accepted. The PLY header may be at most 64 KiB; a longer one is refused with a message that names the limit. A PLY splat with any non-finite field (NaN or infinite position, colour, opacity or rotation, a position past the float32 range of about 3.4e38, or a scale that overflows, a log-scale above about 88) is dropped, and the result carries `skipped: { count, fields }` with the number dropped (0 for a clean file, and for SPZ) and the names of the offending fields; the parse throws only when no splat is usable. `createGaussianSplats` throws a `RangeError` naming the splat when its covariance overflows 32-bit floats. `maximumCount` must be a positive number; the 4,000,000 hard limit always applies.

## Z-up files and hard opaque discs

A Z-up file (Blender, CAD) loads upright with `parseGaussianSplatPly(bytes, { upAxis: 'z' })`: positions and rotations turn by -90 degrees about x, so the file's +z comes out on +y and each disc keeps its orientation. The default is `'y'`, no change. `upAxis` also works on `parseGaussianSplatPlyAsync`; the SPZ readers do not take it, use `matrix`.

`createGaussianSplats(data, { alphaCut: 0.5 })` (and the async version) draws the scene as hard discs instead of soft blobs. A pixel whose gaussian alpha (the falloff times the splat's opacity) is below `alphaCut`, a number from 0 to 1, is dropped; every other pixel is written opaque with depth, with no blending, so neighbouring splats stay their own colour and the result does not depend on the sort. Leave it out for the soft look, which is unchanged. Opaque scenes draw before soft ones on the same renderer, and a splat whose opacity is under the cut never shows.

For a pixel-art look add a palette: `createGaussianSplats(data, { alphaCut: 0.5, palette: ['#1b1b2f', '#c8553d', '#ffd166', [0.9, 0.9, 0.85]], dither: 'bayer4' })`. `palette` is 2 to 256 colours, each a hex string (`'#rgb'` or `'#rrggbb'`) or an `[r, g, b]` array of numbers from 0 to 1, and it needs `alphaCut`, because a blended pixel has no single colour to snap. Every opaque splat pixel takes the nearest palette colour by squared RGB distance (the first one on a tie), judged on the splat's display colour before any HDR exposure. `dither` is `'none'` (default), `'bayer4'` or `'bayer8'`: before the nearest colour is picked, each pixel moves by an ordered-dither threshold from its screen position (the canvas pixel, so a frame at the same size always gives the same pixels), up to 0.125 either way in each channel. The sky, parts and other splat scenes in the frame are not snapped. With no `palette` nothing changes. The upscale and baking a surface into splats are not part of this.

For a one-pixel dark outline round the silhouette add `outline`: `createGaussianSplats(data, { alphaCut: 0.5, palette, dither: 'bayer4', outline: { color: '#101018', width: 1 } })`. `width` is a whole number of pixels from 1 to 4 (default 1), `color` is a hex string or an `[r, g, b]` array from 0 to 1 (default a near black, `[0.04, 0.04, 0.06]`), and it needs `alphaCut`, because a soft edge has no silhouette. The scene draws a second time first, before the fills, from the same splats grown by `width` plus one pixel; a pixel takes the outline colour when its distance to the edge of the cut disc is within `width`. That distance is the disc's edge function divided by its screen-space gradient, so it is exact on a straight edge and slightly off on a tight curve, and it is measured to the pixel centre. The outline writes no depth, so any fill covers it: you get a line round the outer silhouette and round holes in it, not round every disc inside. The outline colour is not snapped to the palette and not dithered. A splat whose opacity is under the cut has no outline, as it has no disc. Parts and other splat scenes drawn before it stay in front where they are nearer. With no `outline` nothing changes, and the shaders are the same text as before. Costs one more draw of the scene.

## Loading without freezing the page

`parseGaussianSplatPly` and `createGaussianSplats` run to the end in one go: about 280 ms of blocked main thread for 1,000,000 splats, seconds for 2,000,000 on a slow machine. For a page that must keep drawing, use the async twins. They return exactly the same bytes, working in slices and waiting one macrotask (no worker needed) between slices.

```js
import { createGaussianSplatsAsync, parseGaussianSplatPlyAsync } from 'crucible/addons/gaussian-splats';

const controller = new AbortController(); // controller.abort() from a cancel button
const options = { chunkSize: 32768, signal: controller.signal, onProgress: fraction => { bar.value = fraction; } };
const data = await parseGaussianSplatPlyAsync(bytes, { ...options, maximumCount: 1_000_000 });
const splats = await createGaussianSplatsAsync(data, options);
```

- `onProgress(fraction)` is called after each slice with a rising fraction that ends at exactly 1. Each step reports its own 0 to 1, so map them to the parts of one bar yourself.
- `chunkSize` is the number of splats per slice (default 32768, a few milliseconds). It must be a positive whole number.
- An aborted `signal` stops at the next slice and rejects with an `Error` named `AbortError`. A signal that is already aborted rejects before any work.
- The header checks, size limits and count limit run first and reject exactly as in the sync functions. `createGaussianSplatsAsync` takes `matrix` and `maximumCount` too.
- Measured with `node bench/gaussian-splats/async-block.mjs` on 1,000,000 generated splats: the longest block drops from about 275 ms to about 22 ms, and the total time is the same (about 255 ms). The sort order buffers `createGaussianSplatsAsync` allocates at the end are not sliced.

## Hand-built data

Data written by code, not parsed, is checked at the call. `count` must be a whole number, `positions` and `scales` need `count * 3` values (Float32Array or Float64Array), `rotations` `count * 4` (w, x, y, z) and `colors` `count * 4` bytes (Uint8Array, starting on a 4-byte boundary of its buffer). A longer array is fine, a shorter or missing one throws an error that names the field, the length it needs and the length it got. `bounds` must be `{ minimum, maximum }`, each three finite numbers (the parse result carries it), or a `TypeError` says so. A rotation of any length counts as its unit version, and all zero as no rotation. `matrix` and the options object must be left out or be a 16-number array and an object; `null` throws. The same checks run in `createGaussianSplatsAsync` before any splat is packed.

## What it draws

- Each splat is a screen-space quad shaped by its 3D covariance, projected through the camera as in the original paper. Colour is the stored colour, as 3DGS viewers show it, not converted from sRGB. The opacity falls off as a Gaussian toward the quad edge.
- The splats draw after the opaque and translucent parts of the renderer, with the depth test against them and no depth write, so a part in front hides the splats behind it and splats never hide a part. The colour draw writes no depth; a soft scene then draws once more, colourless, writing depth for every pixel whose gaussian alpha is 0.5 or more (the nearest wins), so `depthAt`, `worldPointAt` and depth effects such as fog and depth of field see the splats instead of what is behind them. A splat is tested at its centre depth, so one that pokes through a surface is not clipped along the surface.
- Splats blend back to front. The sort is on the CPU, on the main thread: a counting sort of the view depth into 65536 steps, then one upload of the order (4 bytes per visible splat). The sort is skipped when the view depth axis is the same as in the last frame: a still camera, or one that only moves sideways or up and down. Splats behind the camera are left out.
- `matrix` may rotate, translate and scale uniformly. Perspective cameras only. Splats are not drawn in render passes, benchmark mode or the water reflection image, and are not lit, shadowed or fogged.
- `attachGaussianSplats` wraps `renderer.drawBlendBatches`, the step that runs once per frame after the parts and before the frame is resolved. The renderer has no other link to the addon. Attach several scenes and they draw farthest first by their bounds centre.

## Memory

GPU: 48 bytes per splat in one RGBA32UI texture and 4 bytes for the order buffer (52 bytes, 52 MB per million), plus a second RGBA32UI texture of 32, 64 or 96 bytes per splat when the file carries spherical harmonic bands of degree 1, 2 or 3 (half floats, padded to whole texels). A GPU whose texture limit cannot hold that texture draws the splats with one colour from every direction and says why in `statistics.harmonicsSkipped`. CPU after creation: 12 bytes of positions and 8 bytes of sort scratch per splat; the parsed arrays and the packed texture data can be dropped once `createGaussianSplats` has returned and the splats are attached. The parse itself needs the file plus 44 bytes per splat, and 48, 108 or 192 more with bands of degree 1, 2 or 3.

## What it costs

See [bench/gaussian-splats/README.md](https://github.com/codepawl/crucible/blob/main/bench/gaussian-splats/README.md) for frame times and memory at 100,000 and 1,000,000 splats on an RTX 3060 and on SwiftShader, and the comparison with the three.js `GaussianSplat`.
