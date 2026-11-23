# User post-process passes

A scene can add its own full-screen passes: a GLSL fragment that reads the finished frame, the depth and a normal, and writes a new frame. Use it for a pixel-art downscale, an ordered dither, a colour quantise, an outline of your own or a PS2-style look.

The same field works from three places: the `crucible/addons/user-pass` addon, the `postPasses` section of a recipe, and MCP (`scene_create`, `scene_apply` with `set-post-passes`). MCP accepts no host JavaScript. It accepts GLSL fragment snippets that pass a strict check before anything compiles; the rules are below.

## Where a pass runs

Passes run in order on the finished frame: after depth of field, motion blur, line art, bloom, grading and the view transform, as the last step before the canvas. The first pass reads the frame as it would have been shown. Each next pass reads the one before. Colours are display-referred (0 to 1), so quantising and dithering work on the values people see. After the last pass, one edge antialias step smooths the lines and edges the passes drew (see "Antialiasing the result" below). The path tracer does not apply passes: a path traced job (`renderer.type` `pathTracer`, any backend) returns the plain traced frame, because the tracer has no first-hit depth, normal or object ID buffer for a pass to read. The job still completes, and its `metrics.diagnostics` carries a `post-passes-skipped` warning (#2226) that names the passes it left out. A scene without `postPasses` gets no such entry. Render passes (`pass: 'depth'` and the others) and the water mirror are unaffected.

## A pass

```json
{ "name": "pixel-dither", "scale": 0.25, "uniforms": { "levels": 4 }, "fragment": "vec4 userPass(vec2 uv) { ... }" }
```

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letter, then letters, digits or hyphens, 32 characters at most. Unique in the scene. |
| `fragment` | GLSL ES 3.00 text that defines `vec4 userPass(vec2 uv)`. Helper functions and `const` values may come before it. 4096 bytes of code at most; comments and extra spaces are not counted (the text as sent may be up to 65536 bytes). |
| `uniforms` | Named values. A number is a `float`; `[x, y]`, `[x, y, z]` and `[x, y, z, w]` are `vec2`, `vec3` and `vec4`; an int is `{ "type": "int", "value": 4 }`. |
| `scale` | 0.05 to 1 (default 1). The pass renders at this fraction of the width and height, and whatever reads it enlarges it with nearest filtering. A `scale` of 0.25 on the last pass is a pixel-art downscale. |
| `objects` | Optional list of 1 to 16 names. A name is a part (as the object ID pass lists it) or the node id of a placed asset, which stands for every part of that asset; the names may resolve to at most 64 parts. `objectSlotAt(uv)` tells which of them is under a pixel. The preview and render jobs draw the object ID pass first when a pass lists parts. |
| `needs` | Optional list of `normal`, `objectId`, `albedo`, `emission`. Each adds one exact input to the pass. |
| `luts` | Optional palette textures, up to 4: `{ "palette": { "colors": ["#101820", "#f2aa4c"] } }`. |

You do not declare uniforms or the version line; the engine writes them. A snippet sees these names:

| Name | Type | Meaning |
| --- | --- | --- |
| `sceneColor` | `sampler2D` | The frame, or the previous pass. |
| `sceneDepth` | `sampler2D` | Depth of the scene, at full size. It needs `depth: true` on the renderer (the MCP preview has it); without it every sample reads 1. |
| `resolution` | `vec2` | Size of this pass in pixels. |
| `cameraEye` | `vec3` | The camera position in world space for this frame, so a pass that draws in world space (light shafts, spray) follows a camera track without a hand-written uniform. |
| `time` | `float` | Frame time in seconds. A frame drawn at a motion time (a render job with `motion`, a `scene_look` or `scene_review` motion time) reads that motion time, so a still at `motion.start: 6.5` gets 6.5, the same value the video frame at 6.5 s gets. Without a motion time it is the renderer time, which is 0 in a still. |
| `depthAt(uv)`, `worldPointAt(uv)` | functions | Raw depth, and the world position of the pixel. |
| `worldNormalAt(uv)` | function | The surface normal, found from neighbouring depth samples. It is exact on flat faces and wrong at silhouettes and in the sky. |
| `pixelFootprintAt(uv)` | function | `vec2`: the world distance one pixel of this pass covers along screen x and y. 0 in the sky. [How to use it](#filter-a-thin-pattern-with-the-pixel-footprint). |
| `worldFootprintAt(uv, direction)` | function | How far `dot(worldPointAt(uv), direction)` changes over one pixel. |
| `bandLimitedLine(coordinate, pitch, width, footprint)` | function | Coverage 0 to 1 of lines that repeat every `pitch`, averaged over `footprint`. |
| `normalAt(uv)`, `objectIdAt(uv)`, `albedoAt(uv)`, `emissionAt(uv)` | functions | Exact G-buffer reads, only when the pass lists them in `needs` ([below](#exact-normals-object-ids-albedo-and-emission)). |
| `objectSlotAt(uv)` | function | The position in the pass's `objects` list of the part under `uv`, or -1 for the background, any other part, and a pass with no `objects`. A name that matches several parts, or a placed asset id that covers all its parts, gives all of them its one position. Edges are hard: an object ID cannot be antialiased. A name that is not a part in the frame fails the render and lists part names to use. |
| `gl_FragCoord` | `vec4` | The pixel position inside this pass. |

## Exact normals, object IDs, albedo and emission

`worldNormalAt` is rebuilt from depth, so it is wrong at silhouettes and on thin parts, and `objects` stops at 16 parts. A pass that needs better lists what it reads in `needs`:

```json
{ "name": "ink", "needs": ["normal", "objectId"], "fragment": "vec4 userPass(vec2 uv) { ... normalAt(uv) ... objectIdAt(uv) ... }" }
```

| `needs` | Adds | Value |
| --- | --- | --- |
| `normal` | `normalAt(uv)` | `vec3`, the world normal of the surface under the pixel from the `normal` render pass, `vec3(0.0)` in the sky. 8 bits per channel, so it steps by about 0.008. |
| `objectId` | `objectIdAt(uv)` | `int`, the raw part ID of the `objectId` pass: 1 and up in draw order, 0 for the background, up to 24 bits. No 16 part cap. `scene_render_submit` with the `objectId` pass lists the names by ID. |
| `albedo` | `albedoAt(uv)` | `vec3`, the base colour without light, from the `albedo` pass. |
| `emission` | `emissionAt(uv)` | `vec3`, the emitted colour, from the `emission` pass, clamped to 0 to 1 (8 bits). |

Each one is the render pass of the same name, drawn from the same camera without multisampling and read texel by texel, so an edge is exact and one pixel wide. A pass costs one extra scene draw per distinct need, taken once per frame however many passes list it; a scene with no `needs` draws none. A snippet that calls one of these without listing it is refused and the message names the `needs` to add. Passes that also list `objects` keep working: the object ID pass is drawn last. The path tracer has no such buffers and skips passes, as above. In JavaScript the renderer needs `installRenderPasses(renderer)` first; `installUserPasses` then draws these passes inside `renderer.render`.

### Palette textures

`luts` hands a pass small read-only textures so a colour ramp does not use up the 16 uniforms or the 4096 bytes of code. A texture is `{ "colors": [...] }` (hex `#rrggbb` or `#rrggbbaa`; a flat list is one row, a list of lists is one row each, all the same length) or `{ "width", "height", "pixels" }` with `pixels` as base64 RGBA bytes (a `Uint8Array` or array of bytes in JavaScript). Bounds: at most 4 textures per pass, 256 by 16 texels each, inline data only (no URL is read). The name follows the uniform rule and may not reuse an input or a uniform of the pass. In the snippet it is a `sampler2D` with nearest sampling and clamping: `texelFetch(palette, ivec2(column, row), 0).rgb`, or `texture(palette, vec2(u, v))`. The colours are used as they are (not converted), the same space as `sceneColor`.

```c
vec4 userPass(vec2 uv) {
  float shade = floor(dot(albedoAt(uv), vec3(0.3, 0.6, 0.1)) * 3.99);
  int row = objectIdAt(uv) % 2;
  return vec4(texelFetch(palette, ivec2(int(shade), row), 0).rgb, 1.0);
}
```

## Antialiasing the result

A pass reads the depth, the world position and the object IDs at one sample per pixel, so a line or a threshold it draws from them is stair-stepped, and the stock MSAA and FXAA ran before the passes. When a scene has passes, Crucible runs one FXAA-style edge pass after the last one. It costs one more full-screen draw and only exists when passes do. It reads the colour only, so it smooths what the passes drew and also softens any 1 px detail they made on purpose.

| `postPassesAntialias` | Meaning |
| --- | --- |
| `"fxaa"` (default) | One edge antialias step after the last pass. It is skipped when the last pass has a `scale` under 1, because that enlargement into hard pixels is the look. |
| `"off"` | The last pass is the final picture. Use it for dither, pixel art and any pass whose single pixels must stay exact. |

In JavaScript, `renderer.userPasses.setAntialias("off")`. In a recipe, `{ "postPassesAntialias": "off" }` next to `postPasses`; `scene_create` takes it. Any other value is refused with the allowed values. The icon sketch look sets `"off"` itself, since its ink and paper pixels are measured.

## Pixel grid: a true low-resolution render

Downscaling a full-size frame (`scale` below 1, or `stylize.pixelate`) shimmers when the camera pans, because every frame samples the scene at a different offset. `pixelGrid` renders on the low-resolution grid itself:

```json
{ "pixelGrid": { "width": 256, "height": 144, "pad": 2 } }
```

- The main pass, `sceneDepth`, render passes, line art and every user pass run on a `(width + 2 pad) x (height + 2 pad)` target with one sample. Passes read the frame with nearest filtering, and `postPassesAntialias` behaves as `"off"` while the grid is on.
- An orthographic camera moves onto whole texels (a texel is `orthoScale / height`). The frame then goes to the canvas with a nearest blit of the visible grid, moved by the part of a texel the snap took, so static geometry keeps its pixels while a pan still moves smoothly at output size. A perspective camera renders on the grid without snapping.
- `stylize.pixelate` and a pass with `scale` below 1 count in grid pixels on the grid. Their blocks (`pixelate` pixels, or `1 / scale` rounded) start on a lattice that moves with the snapped camera, so a block stays on the same geometry while the camera pans instead of flickering. A pass on the grid reports the block count as `resolution` and is enlarged back to the grid size before the next pass reads it; a `scale` that rounds to one pixel per block runs at the grid size.
- The canvas must be at least the padded grid in each side. `pad` (default 2) is the ring that covers the shift.
- Without `pixelGrid` the render is unchanged. `scene_create` takes it, and `scene_apply` takes `{ "type": "set-pixel-grid", "pixelGrid": { "width": 256, "height": 144 } }` (`null` turns it off); in JavaScript, `installPixelGrid(renderer)` from `src/pixel-grid.js` after `installUserPasses`, then `renderer.pixelGrid.set({ width, height, pad })`, or `set(null)`.

## Limits and rules

The check runs on the text before any compile. A snippet that breaks a rule is refused with the line, the column and a fix.

- At most 4 passes, 4096 bytes of code per snippet (comments and runs of spaces are not counted; the error shows both sizes), 16 uniforms per pass. Uniform names match `^[a-z][A-Za-z0-9]{0,31}$`, are not GLSL keywords and do not reuse an input name. Values are finite numbers.
- No `#` lines (no `#define`, `#extension`, `#version`). No backslash, and ASCII text only.
- No `while` or `do`. A `for` loop has the exact form `for (int i = 0; i < 8; i++) { ... }`: a counter that starts at an integer literal, a test against an integer literal, a step of `i++`, `++i`, `i--`, `--i`, `i += N` or `i -= N`, and a body in braces. It runs 64 iterations at most, and the body does not change the counter.
- Loop work stays under 4096 iterations per pixel: nested loops multiply, and a call to your own helper counts the loops inside that helper again, and a helper without loops adds nothing. The error lists which loops add up.
- No `uniform`, `layout`, `attribute`, `varying` or `buffer` declarations.
- No name that starts with `gl_`, except `gl_FragCoord`. No name that starts with `u67_`; the engine keeps that prefix.

## JavaScript

```js
import { installUserPasses } from '@codepawlhq/crucible/addons/user-pass';

installUserPasses(renderer); // needs depth: true for sceneDepth
renderer.userPasses.set([{ name: 'soft', uniforms: { amount: 0.5 }, fragment: `
  vec4 userPass(vec2 uv) {
    vec3 color = texture(sceneColor, uv).rgb;
    return vec4(mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), amount), 1.0);
  }` }]);
renderer.userPasses.set([]); // remove them
```

`set` can run every frame. New uniform values do not recompile; a new `fragment` compiles on the next frame. A compile or link error throws from that frame's `render` as an `Error` that carries the driver's log with line numbers mapped to your snippet. The same checks apply as for a recipe, so a snippet that works here works in a recipe.

## Recipe and MCP

```json
{ "postPasses": [ { "name": "pixel-dither", "scale": 0.25, "uniforms": { "levels": 4, "spread": 1 }, "fragment": "..." } ] }
```

`scene_create` takes `postPasses`. `scene_apply` takes `{ "type": "set-post-passes", "postPasses": [...] }`; `null` or `[]` clears it. `scene_inspect` lists the passes (name, scale, uniform names with types, snippet size). `scene_capabilities` reports the same limits under `postPasses`. `scene_look` and `scene_render_submit` draw the passes.

## Errors

Each message names the pass, the position and a fix:

```text
Post pass "pixel-dither" fragment line 4, column 3: "while" loops are not allowed. Fix: Use a for loop with integer literal bounds of at most 64, for example for (int i = 0; i < 8; i++) { ... }.
Post pass "pixel-dither" fragment line 2, column 1: Preprocessor lines (#) are not allowed. Fix: Remove the # line; write constants as const float name = value; and use plain code instead of #define.
Post pass "pixel-dither" fragment line 3, column 25: This for loop runs more than 64 iterations. Fix: Lower the bound or raise the step so the loop runs at most 64 times.
```

A snippet that passes the check can still fail the compiler. In MCP the edit is kept, the result has `renderSucceeded: false` and `renderError` holds the log, and the session stays usable: send `set-post-passes` again with the fix.

```text
Post pass "pixel-dither" failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.
ERROR: snippet line 7: '=' : dimension mismatch
    | vec3 wrong = 1.0;
ERROR: snippet line 7: '=' : cannot convert from 'const float' to 'highp 3-component vector of float'
    | vec3 wrong = 1.0;
```

## Worked example: ordered dither with a pixel downscale

The pass renders at a quarter of the width and height, mixes a 4x4 Bayer threshold into the colour, rounds each channel to `levels` steps, and is enlarged with nearest filtering. The blocks are 4x4 screen pixels and the frame has at most `levels` values per channel.

```glsl
// Ordered 4x4 dither, then colour steps. The pass renders at a quarter size, so one dither cell is a chunky pixel.
const float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);

vec4 userPass(vec2 uv) {
  vec3 color = texture(sceneColor, uv).rgb;
  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;
  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;
  vec3 stepped = floor(color * (levels - 1.0) + 0.5 + threshold * spread) / (levels - 1.0);
  return vec4(clamp(stepped, 0.0, 1.0), 1.0);
}
```

As a recipe section:

```json
{"postPasses":[{"name":"pixel-dither","scale":0.25,"uniforms":{"levels":4,"spread":1},"fragment":"// Ordered 4x4 dither, then colour steps. The pass renders at a quarter size, so one dither cell is a chunky pixel.\nconst float bayer[16] = float[16] (0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);\n\nvec4 userPass(vec2 uv) {\n  vec3 color = texture(sceneColor, uv).rgb;\n  ivec2 cell = ivec2(gl_FragCoord.xy) & 3;\n  float threshold = (bayer[cell.y * 4 + cell.x] + 0.5) / 16.0 - 0.5;\n  vec3 stepped = floor(color * (levels - 1.0) + 0.5 + threshold * spread) / (levels - 1.0);\n  return vec4(clamp(stepped, 0.0, 1.0), 1.0);\n}"}]}
```

`levels` of 2 gives a one-bit look, 8 a soft one. `spread` of 0 turns the dither off and leaves plain steps.

# Material fragment hook

A material can carry its own fragment code: a GLSL function that changes the surface colour and alpha, or discards the fragment (water has a second entry point after lighting, [below](#a-water-hook-after-lighting)). Use it for a dissolve, a shoreline cut from a mask, a leaf cutout or a stripe pattern. It works from the `snippet` field of a recipe material and from MCP (`scene_create`, `scene_apply` with `set-material`; `snippet: null` clears it). It follows the same rules as a post pass, and MCP accepts no host code.

```json
{ "id": "stone", "color": [0.5, 0.5, 0.5], "snippet": { "fragment": "...", "uniforms": { "threshold": 0.4 }, "mask": "map" } }
```

| Field | Meaning |
| --- | --- |
| `fragment` | GLSL ES 3.00 text that defines `void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition)`, or `waterHook` below. Add a fifth parameter, `float time`, to read the frame time. Helper functions and `const` values may come before it. 4096 bytes of code at most; comments and extra spaces are not counted (the text as sent may be up to 65536 bytes). |
| `uniforms` | Named values, as for a post pass: a number is a `float`, `[x, y]` to `[x, y, z, w]` are vectors, `{ "type": "int", "value": 4 }` is an int. At most 16. |
| `mask` | Optional, `"map"`: the snippet may sample `snippetMask` (a `sampler2D`), which is the material's own map or pattern. Load the image as the material `map`; there are no remote URLs. |

Materials may share the same `fragment` text and still differ in `uniforms`: they share one compiled function, and each draw sets the uniform values of its own material.

Inputs: `color` is the base colour after the map and the vertex tint, `alpha` is the map alpha before the material opacity, `uv` is the texture coordinate and `worldPosition` the position in the world. A fifth `float` parameter (any name, for example `float time`) receives the frame time in seconds, the same time `waterHook` and `userPass` get, in stills and in video frames; it animates flames, beacons, grass sway or a flowing highlight on any material. The shadow pass gets the same time, so a discard that moves with it moves the shadow, but the shadow map is redrawn only when the scene changes. `discard` removes the fragment in every alpha mode. A lowered `alpha` cuts only when the material has `alphaMode: "mask"`.

## Filter a thin pattern with the pixel footprint

A pass reads one depth sample per pixel, so a pattern it draws itself (lines, a grid, stripes) turns into moire where the pattern is finer than a pixel. MSAA and FXAA run before the passes and cannot fix that. Ask how far one pixel reaches on the surface, and average the pattern over that distance:

- `pixelFootprintAt(uv)` gives the world distance one pixel covers along screen x and along screen y. It is exact on a flat surface. At a depth edge or a silhouette it takes the neighbour on the near surface's side, so the step does not stretch across the gap. It is `vec2(0.0)` in the sky, and wherever the depth buffer is off.
- `worldFootprintAt(uv, direction)` gives how far the number `dot(worldPointAt(uv), direction)` changes over one pixel. Use it as the footprint of a pattern that is a straight coordinate: `vec3(0.0, 1.0, 0.0)` for rings of height, a plane normal for slices.
- `bandLimitedLine(coordinate, pitch, width, footprint)` gives the share of a pixel covered by lines of `width` that repeat every `pitch` along `coordinate`, all in the same units. While a pixel is narrower than a third of the pitch it is the exact box-filtered coverage; as the pixel grows to the pitch it fades to the mean coverage `width / pitch`, which is what a super-sampled frame converges to.

Height lines that stay 1.5 pixels wide at any distance:

```glsl
vec4 userPass(vec2 uv) {
  vec3 base = texture(sceneColor, uv).rgb;
  float footprint = worldFootprintAt(uv, vec3(0.0, 1.0, 0.0));
  if (footprint <= 0.0) return vec4(base, 1.0);
  float coverage = bandLimitedLine(worldPointAt(uv).y, 0.12, 1.5 * footprint, footprint);
  return vec4(mix(base, vec3(0.0), coverage), 1.0);
}
```

Measured on a 1280 by 720 slab running to the horizon, against a 3x super-sampled reference (green-channel RMSE over the far third of the ground): the same lines drawn with a plain `step` read 46.0, with the helper 26.5. A 24-frame dolly, mean frame-to-frame RMSE: 43.2 plain, 21.7 with the helper, 27.1 for the reference (which includes the real motion). Each call reads a few extra depth samples, so call it once per pixel and reuse the result. A pattern that is not a straight coordinate in world space (noise, a texture) is not covered; filter it by sampling it a few times across the footprint.

## A water hook, after lighting

A snippet may define `void waterHook(inout vec3 color, WaterInputs water)` instead of `materialHook`, or next to it. It runs only on a material with `"tag": "water"`, after the engine has lit the surface and before fog and tone mapping, so it can replace the lighting with flat tones or add a hard edge. `color` is the lit linear radiance, in and out. The engine declares the `WaterInputs` type; you do not.

| Field | Meaning |
| --- | --- |
| `water.normal` | The shading normal, ripples and waves included. |
| `water.view` | Unit vector from the surface to the eye. |
| `water.foam` | The foam of the water shader, 0 to 1, from the ocean `foam` vertex group. |
| `water.depthBelow` | Metres of water over the floor below. Always 0 for now: the water shader does not resolve it yet. |
| `water.time` | Seconds, as the engine's clock. |
| `water.lit` | The key light facing the surface times the shadow it receives, 0 to 1. |

The same limits and checks as the material hook apply: 4096 bytes, 16 uniforms, no `#` lines, counted loops only. A snippet with only `waterHook` adds nothing to the shadow and ID passes. The path tracer and exports ignore it.

```glsl
void waterHook(inout vec3 color, WaterInputs water) {
  float tilt = 1.0 - water.normal.y;
  vec3 tone = tone0;
  if (tilt > 0.004) tone = tone1;
  if (tilt > 0.012) tone = tone2;
  if (tilt > 0.03) tone = tone3;
  color = tone * (0.6 + 0.4 * step(0.5, water.lit));
  if (water.foam > foamCut) color = vec3(0.9, 0.95, 1.0);
}
```

With `tone0` to `tone3` as vec3 uniforms and `foamCut` of 0.3, that draws four flat tones from the wave slope and hard-edged foam on an ocean sea.

## Where the hook runs

The hook runs in the colour pass, in the shadow pass and in the ID pass. A discarded fragment therefore casts no shadow and is not picked. In the shadow pass `color` starts white and `alpha` is the map alpha, so base a discard on `alpha`, `uv`, `worldPosition` and your uniforms, not on `color`. The path tracer and exports ignore the hook. Changing a snippet makes the MCP preview build a new renderer, so edit it between looks, not in a loop.

The rules are the ones of [a pass](#limits-and-rules): no `#` lines, no `while` or `do`, counted `for` loops only, no `gl_` names but `gl_FragCoord`, no `u67_` names. Errors name the material's parts, the line, the column and a fix. A snippet that passes the check but fails the compiler comes back as `renderError` with the log mapped to snippet lines, and the session stays usable:

```text
Material snippet (used by caster) failed to compile as GLSL ES 3.00. Line numbers refer to your fragment snippet.
ERROR: snippet line 3: '=' : dimension mismatch
    | vec3 wrong = 1.0;
```

## Worked example: dissolve a wall with a noise threshold

The wall breaks into hash cells; a cell is removed when its noise value is below `threshold`, and cells near the edge glow orange. Moving `threshold` from 0 to 1 dissolves the wall, and the shadow of the wall dissolves with it.

```glsl
float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }

void materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {
  float value = cellNoise(floor(worldPosition.xy * 6.0));
  if (value < threshold) discard;
  float edge = 1.0 - smoothstep(0.0, 0.08, value - threshold);
  color = mix(color, glow, edge);
}
```

```json
{ "type": "set-material", "id": "wall", "snippet": { "uniforms": { "threshold": 0.35, "glow": [1.0, 0.45, 0.1] }, "fragment": "float cellNoise(vec2 cell) { return fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453); }\n\nvoid materialHook(inout vec3 color, inout float alpha, vec2 uv, vec3 worldPosition) {\n  float value = cellNoise(floor(worldPosition.xy * 6.0));\n  if (value < threshold) discard;\n  float edge = 1.0 - smoothstep(0.0, 0.08, value - threshold);\n  color = mix(color, glow, edge);\n}" } }
```

For a leaf or shoreline cutout, give the material a `map` whose alpha or red channel holds the mask, set `"mask": "map"` and write `if (texture(snippetMask, uv).r < 0.5) discard;`.
