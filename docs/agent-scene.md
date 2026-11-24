# Agent scene authoring

This addon is included in npm release `0.5.0` and later.

The optional `agent-scene` addon creates bounded CPU scenes from JSON recipes and applies atomic editing commands.
It returns retained renderer parts with shared geometry and material resources.
It does not execute JavaScript, access the DOM, or provide an MCP transport.
Recipes also retain [lighting, fog, effects and directional shadow coverage](agent-look.md).
Their patches and checkpoints share the same atomic revision contract as model edits.

To see what changed, including changes not yet released, read `https://crucible.codepawl.com/changelog.json`.

Release `0.7.0` adds optional [procedural motion](agent-motion.md) and transient `sampleMotion(time)` seeks.
Recipe edits retain authored keyframes. Sampling preserves revisions and geometry while updating rendered transforms, materials and camera.

```js
import { CrucibleRenderer } from 'crucible';
import { createAgentScene, AGENT_SCENE_CAPABILITIES } from 'crucible/addons/agent-scene';

const scene = createAgentScene({
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'blue', color: [0.1, 0.3, 0.8] }],
  nodes: [
    { id: 'group', label: 'Assembly' },
    { id: 'mesh', parent: 'group', geometry: 'cube', material: 'blue' },
  ],
});

const renderer = new CrucibleRenderer(canvas, scene.parts, { ground: false });
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-node', id: 'group', translation: [1, 0, 0] },
  { type: 'set-material', id: 'blue', roughness: 0.3 },
], { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.restore(checkpoint, { expectedRevision: scene.revision });
renderer.updateParts(scene.parts);
renderer.render(scene.camera);
scene.releaseCheckpoint(checkpoint);
```

`AGENT_SCENE_CAPABILITIES` and `scene.capabilities` describe the same frozen capability object.
The renderer owns GPU allocation and disposal.
The authoring session does not allocate GPU resources.
The normal frame loop can render retained parts without calling inspection or exporting the recipe.

### On-demand code

Mesh editing, `lathe`, `extrude`, `tube` and `curve` geometry, `text` geometry with its font, `terrain` and `floorPlan` geometry, material `pattern`, `motion` and node `relations` load on demand, so a recipe of
primitives pays about half the bytes. `createAgentScene` and `apply` stay synchronous. When a recipe uses one of them,
load its code first; a missing module throws an error that names this call.

```js
import { createAgentScene, loadAgentSceneModules } from 'crucible/addons/agent-scene';

await loadAgentSceneModules(recipe);
const scene = createAgentScene(recipe);
```

`loadAllAgentSceneModules()` loads everything, for a host that runs any recipe an agent writes (the MCP preview does).
Call `loadAgentSceneModules(operations)` before `apply` when the operations add such features.

The default stages that need a lazy module (flush-face ranking, the floor sky trace) run for a scene when the host called `loadAllAgentSceneModules()` or the scene's own recipe or operations name them. A module that another scene loaded earlier in the process does not turn them on, so one recipe builds the same parts in any order.

An edit of a scene that holds 100,000 or more triangles to rank (a large scan) does not wait for the near-coplanar search of those default stages: `apply` returns with the new parts unranked, `scene.flushPending` is `true`, and the search runs after it, then publishes the ranked parts as a topology change (`topologyRevision` goes up, so a renderer regroups). The search runs in slices of about 8 ms across turns of the event loop, so no single task of the page is long; no part has a rank until the last slice. It is the same search a synchronous edit runs, so the ranks are identical. `scene.settleFlush()` runs it at once and returns whether it had to; `inspect` and the MCP preview frame call it first, so a look or a render never shows a scan unranked. A new scene and any scene under the limit rank inside the call. A scene whose parts move (particles, a moving sea) defers the search of its still parts the same way: the moving parts are never ranked, and the rest parts and the posed parts of the edit wait for the one search.

## Recipe contract

The recipe must contain `format`, `schemaVersion`, `geometries`, `materials`, and `nodes`.
The optional `camera` object supplies a perspective camera, or an orthographic one with `projection: 'orthographic'` and `orthoScale` (view height in metres, default 4). The lens is `fov` (vertical degrees) or `focalLength` in millimetres with `sensorWidth` (default 36); giving both is an error. `shift: [x, y]` moves the frame by a fraction of its width and height, positive right and up. `fStop` (0.7 to 64) turns on depth of field focused on `target` (1.4 or lower is full blur); `focusDistance` (metres along the view axis, positive, needs `fStop`) puts the focus plane there instead, so the subject can stay sharp without moving `target`, in the rasterizer and the path tracer alike (it is not the `effects.depthOfField.focusDistance` of the blur effect, nor a motion track: the lens keeps it while camera tracks move the camera) and cannot be combined with `effects.depthOfField.blur`. In a `set-camera` operation `fStop: null` turns depth of field off and clears `focusDistance` with it, and `focusDistance: null` clears only the focus plane (back to the target); `fStop: null` with a numeric `focusDistance` is an error. The other optional lens fields clear the same way in `set-camera` (`projection: null` also drops `orthoScale`, `focalLength: null` also drops `sensorWidth`, `shift: null`); `eye`, `target`, `up`, `fov`, `near` and `far` always have a value, so null on them fails with the default to pass. A recipe `camera` takes none of them as null: leave the field out. The path tracer draws perspective cameras without shift.
All objects reject unknown keys.
Inputs must contain plain, finite, acyclic JSON data without accessors, sparse arrays, or executable values.
JSON nesting has a fixed maximum of 64 levels.

Each resource and node has a unique `id` within its collection.
IDs contain 1 to 128 characters and must contain a non-space character.
Node labels contain at most 256 characters.
Labels can repeat and change without changing identity.
Renderer `part.name` contains the stable node ID.

Geometry records contain `id`, `type`, and the flat fields below.
Omitted parameters use the existing generator defaults.
The generators also enforce their existing numeric and modeling constraints.

| Type | Fields | Defaults |
| --- | --- | --- |
| `box` | `bevel`, `subdivisions` | `0.08`, `6` (a closed room of touching boxes is drawn with sharp edges: see the paragraph after this table) |
| `cylinder` | `segments`, `bevel`, `bevelSegments` | `80`, `0.025`, `6` |
| `sphere` | `segments`, `rings` | `64`, `40` |
| `torus` | `tubeRadius`, `segments`, `sides`, `arc`, `start` | `0.08`, `96`, `24`, `2π`, `0` |
| `lathe` | `profile`, `segments`, `startAngle`, `sweep` | Required XY profile, `64`, `0`, `2π` |
| `extrude` | `contour`, `holes`, `depth`, `steps`, `bevel`, `bevelThickness`, `bevelSegments` | Required XY contour, `[]`, `1`, `1`, `0`, bevel, `3` |
| `tube` | `path`, `radius`, `segments`, `radialSegments`, `closed` | Required XYZ path, `0.1`, `64`, `12`, `false` |
| `curve` | `points` or `shape` or `splines`, `closed`, `kind`, `weights`, `trim`, `grow`, `radius`, `taper`, `profile`, `resolution`, `radialSegments` | One of points, shape or splines, `false`, `bezier`, 1, none, none, `0.05`, none, round, `12`, `8` |
| `text` | `text`, `size`, `depth`, `font`, `align`, `curveSegments` | Required string, `1`, `0.2`, `default`, `left`, `4` |
| `terrain` | `size`, `resolution`, `seed`, `amplitude`, `holes`, `featureSize`, `octaves`, `warp`, `ridged`, `mountainAmplitude`, `mountainMask`, `chunks`, `levels` | `40` m, `64` cells, `1`, `1` m, none, `size / 4` m, `6`, `0` m, off, `46` m, none, `1`, `1` |
| `floorPlan` | `walls`, `openings`, `height`, `thickness`, `part` | Required walls, none, `2.7` m, `0.2` m, `all` (see [floor-plan.md](https://crucible.codepawl.com/floor-plan.md)) |

`seed` is a whole number from 0 to 2147483647 (anything else is refused, not rounded or wrapped). `terrain` is one seeded ground mesh from `-size / 2` to `size / 2` on X and Z with hills about y = 0 and up to 16 round `holes` (`{ center: [x, z], radius }`) that leave no surface; it loads on demand. Shape, chunks and levels: [terrain](https://crucible.codepawl.com/terrain.md#recipe-terrain). Details are in `scene_capabilities` under `terrain`.

Boxes that meet in a room: the rounded edge of a default box leaves a groove where two boxes touch, and sun, sky and lamps shine through it. When at least four pairs of plain boxes (translation and scale only, no parent) touch and the joined boxes have a thin slab on each of the six sides, the engine draws those boxes with sharp edges, whatever their `bevel`. Props that only stand on a floor, rooms without a ceiling, rotated or parented boxes, and scenes with more than 1500 rounded boxes keep their rounded edges. The recipe is not changed, so `bevel` still reads as written.

`curve` and `text` are described in full by `scene_capabilities` under `curveText.details`; see [modeling.md](modeling.md).

Modeling point inputs have a maximum of 4096 points.
An extrusion has at most 128 holes and 4096 total contour points.
Shared resource IDs generate geometry once, regardless of the number of mesh nodes.

Materials contain `id`, `tag`, `color`, `metallic`, `roughness`, `emission`, optional `preset`, `emissiveColor`, `opacity`, `alphaMode`, `alphaCutoff`, `doubleSided`, `pattern` and `map`.
The defaults are `surface`, `[0.5, 0.5, 0.5]`, `0`, `0.5`, `0`, opacity `1`, `opaque` and `false`.
The tag can be `surface`, `unlit`, `liquid`, `foam`, `water`, `foliage` or `grass` (the last two sway in `environment.wind`) and remains fixed during editing.
`liquid` refracts and tints what lies behind it: its color is the light one metre lets through, so `[0.56, 0.84, 0.88]` is clear water. `foam` draws soft blended droplets.
`water` is a flat mirror sheet (a plane or thin box). The largest one sets the water level: everything below it fades by `exp(-absorption * depth)` per colour channel (`absorption` is RGB per metre), and its shadows are lifted and softened with depth times `turbidity` (0 clear to 1 murky). `waterPreset` fills both: `lake` (default), `sea` or `river`. A water sheet casts no sun shadow of its own (set `castShadow: true` to change that), and a shadow on the surface is faint and never darkens the reflection; give the sheet an `opacity` below one when the bed should show. The sun's leg to a bed is bent at n = 1.33 and absorbed over `depth / cos(theta_t)`, so a clear lake keeps little shadow contrast on a bed 4 m down, and a murky river keeps about a quarter. On a sea mesh the `foam` group draws white lace on the crests; `foamEdge` `hard` draws it as a flat painted shape with a one pixel edge instead, and `foamWidth` (0.25 to 4, 1 default) widens or narrows it. `foamColor` (`[r, g, b]`, linear 0 to 1, white by default) tints the foam, for example `[0.8, 0.95, 1]` for pale cyan; contact foam keeps its own `color`. The tint scales the foam after lighting but before the tone curve, so it only shows where the foam is not clipped to white: under strong light (key 1.6 on the test sea) a pale tint washes out, and a dimmer key or exposure brings it back. All three need the water tag. How much of the sea foams is the `coverage` of the `ocean` edit ([mesh.md](mesh.md)). `contactFoam` (`{ width, hardness, noise, drift, rim, color }`) draws a white line where the water meets another surface, a hull, a rock or a shore, on any mesh and whether it moves or not: `width` is the line's width in screen pixels (1 to 64, 6 default, so it keeps one width at any distance), `hardness` runs from 0 (soft edge) to 1 (a one pixel edge, the default), `noise` (0 to 1, 0.3) breaks the edge up, `drift` (0 to 1, 0) turns the static rim into one that tears into segments and slides along the contact line with the water time (the same time gives the same frame), `rim` (true by default) set to false draws no contact line at all, so the water meets hulls and shores with no foam edge while the sea's own crest foam stays, and `color` is RGB (white by default). It reads the depth of what lies behind the water, which only water with `alphaMode` `blend` at any `opacity` including 1, does, and a sea whose waves rise more than 2% of its width sets no water level, so it draws no line. It is off unless given. Foam only reaches where the scene behind the water is within half a metre of its surface, so open water, the horizon and far shores stay clear. Depth is kept in 8 bits outside HDR, about 6 cm a step over 8 m, so a close camera sees the line's inner edge in steps.
`caustics` on a water material (`{ scale, speed, intensity, depthFade }`, off unless given; `null` or `intensity: 0` switches it off) draws a moving net of bright lines on every opaque surface below the water level. Two rotated Voronoi nets, warped by a slow pan, are projected from the sun along the refracted ray onto the surface and added to the sun's light, so a shadow still blocks them and a surface turned from the sun gets none. `scale` is metres across one cell (0.05 to 50, default 1.2), `speed` how fast the net drifts (0 to 10, default 0.5), `intensity` the extra sun on a line at the surface (0 to 10, default 2) and `depthFade` the loss per metre of depth, `exp(-depthFade * depth)` (0 to 10, default 0.35). It follows the renderer time the water waves use (`rendererTime` of a render job), so a still at one time is a frozen net. Raster only: the path tracer draws no caustics. The level comes from the largest flat water part, as for absorption.
`waterRamp` (off by default) paints the sea in flat anime tones: `{ colors: [3 to 5 RGB, deep to bright], drivers: { height, facing, sun } (weights 0 to 1, default height 1), heightRange: [low, high] (world y, default -1 to 1), steps: hard (default) or soft, crestTint: { color, strength } }`. A weighted mix of the drivers picks the tone: `height` is world y across `heightRange`, `facing` rises toward the horizon, `sun` is how squarely a wave face meets the key light. The ramp owns the colour, so the sky reflection and the lit shading are not drawn; foam and the sun glint still add on top. `crestTint` colours the folded crests the `foam` group marks, wider than the foam itself. It needs the water tag; depth and a shallow and deep pair are not drivers yet.

Ramp colours are display colours. A stop given as `#rrggbb` shows on screen as that hex; three numbers show as the sRGB encoding of those linear values (`[0.04, 0.4, 0.5]` shows as `#38aabc`). The shader maps each stop back through the exposure and the view transform (ACES, AgX or Neutral), so the tone curve does not shift it, and the distance haze (`fogDensity`) stays off the ramp. Measured on 640x360 stills under the default view: `#19617c` and `#38aabc` measured exactly as requested; a bright stop `#95edf3` measured `#99eef4` on lit faces. Things that run after the shader still change the picture: bloom, grade, vignette, grain, a look and the volume fog step, and foam, the sun glint and the crest tint add on top by design.
Any `opacity` below one draws the material blended after opaque geometry, which suits glass, windows and visors. Blended instances of every material draw back to front together, by the view depth of the centre of their bounds, equal depth in scene order; past 48 interleaved runs a batch draws whole in its own order, and the batches go farthest first. `alphaMode` accepts `opaque`, `mask`, `blend` or `add` (additive light for sparks, trails and glow); the MCP tools accept the same four, and `scene_capabilities` topic `alphaModes` lists them. `mask` cuts a hard edge where the alpha of the material's `map` or `colorMap` times `opacity` is under `alphaCutoff` (0 to 1, default 0.5; only with `mask`, any other mode refuses it): use it for leaf cards, fences and chain link, where `blend` sorts badly and casts soft shadows. Shadows, depth and object-ID passes follow the cut, and the path tracer reads the same cutoff. A procedural `pattern` has no alpha, so a mask with no alpha-carrying map cuts nothing. A node with an `opacity` track cannot use `mask`. Changing `alphaMode` or `alphaCutoff` replaces the affected parts.
`ripples` on a water material (`{ strength, speed, windDirection }`, water tag only, off by default) controls the small wind ripples that tilt the surface and break the sun glint into facets. `strength` is their height from 0 (none) to 1 (1, the default look), `speed` scales how fast they travel from 0 (frozen) to 2 (1 default), and `windDirection` (degrees, the same angle as the `ocean` edit's `direction`) runs them downwind, within about 40 degrees of that direction, instead of in every direction. With the field absent the water renders exactly as before. Use it on a sea that is filmed: ripples 0.6 to 3 m long travel 4.5 to 12 rad/s and cross several pixels between two frames at 24 fps, so they read as strobing; `{ "strength": 0.3, "windDirection": 0 }` calms them. Scene file and library only, not an MCP tool field.
`foamVeins` on a water material (`{ amount, scale }`, water tag only, off by default) adds a net of thin foam veins that trails out behind each crest, thinning and breaking into patches as the foam weight falls, as in anime and ocean references. `amount` is 0 (off) to 1 (0.6 once the object is given), `scale` 0.25 to 4 (1; larger is finer). The veins grow from the `foam` group, so they need a sea with foam ([mesh.md](mesh.md)); the native path tracer does not draw them yet.
`doubleSided` draws and lights both faces of thin sheets.
Changing the tag, opacity, blending, sidedness or pattern replaces the affected parts in the renderer; color, metallic, roughness and emission edits keep them.
Set liquid optics with `environment.liquid`: `thickness`, `ior`, `refraction`, `scattering`, `foamOpacity` and `foamSoftness`.
Colors use linear RGB.

Base color, metallic, and roughness range from zero to one.
Emission and independent emissive color must be nonnegative finite Float32 numbers.
Their component products must also remain finite at Float32 precision.
Unlit emissive radiance is capped at 65500 per component to fit the half-float HDR target.
Image textures come from catalog images (a colour map sequence, and scanned texture sets under "Scanned texture sets" below); the other procedural material tags are outside this version.


### Material presets

`preset` names a ready look for blocky scenes, such as parts exported from Roblox Studio that carry a material name and a colour: `smoothPlastic`, `wood`, `grass`, `neon`, `glass` or `brick`. The preset fills only the fields the material leaves out, so any field you set (`roughness`, `pattern`, `opacity`) wins.

```json
{ "id": "roof", "preset": "brick", "color": [0.75, 0.2, 0.15] }
```

| Preset | What it fills |
| --- | --- |
| `smoothPlastic` | roughness 0.28, no pattern |
| `wood` | dark-ringed `wood` pattern, 0.8 m per repeat, roughness 0.8 |
| `grass` | a `graph` pattern of sparse upright blades, bright at the core and dark at the rim, over a slow mottle, 0.6 m per repeat, roughness 1; reads as turf on any part colour, and the `grass` tag is for swaying blades |
| `neon` | a glowing panel: emission 1.5 times a map with a bright tube frame along the edge of each face and a calmer face inside, in a saturated version of the part colour (`emissiveColor`) over a near-black base, so the face keeps its hue instead of going pastel; one frame per metre, so set `pattern.size` to the part width for one per face. The halo comes from `effects.bloom`: use `{ "strength": 1, "threshold": 0.8, "radius": 3 }` (the default 0.12 is faint; measured, the frame lifts the pixels around it by 50 to 70 levels at 8 px with these values) and a point light of the same colour next to the part for the spill on its surroundings |
| `glass` | faint cyan tint, opacity 0.4, roughness 0.03, clear coat, `transmission` 0.7 with `ior` 1.15 and `thickness` 0.06 so the rasterizer bends what is behind it gently (a higher `ior` or `thickness` shows banded steps along the bevel), and a strong Fresnel edge light (emission graph); blended. A coloured pane over a dark backdrop looks dark, since it tints what is behind it. A `box` with `bevel` 0.2 shows the bend along its rim and avoids small hook marks at its inner corners that the refraction march draws on the default bevel (#3256). Its tinted shadow is drawn only by the default shadow map: `environment.sunAngularRadius` (soft sun) drops it (#3259) |
| `brick` | `bricks` pattern, 1 m per repeat, roughness 0.9 |

`color` is the part colour and tints the base: the patterns are grey ramps, so a red `wood` part is red wood. Without `color`, each preset uses its own tint. Pattern `size` is in metres after node scale, so a 4 m part and a 40 m part show the same grain size. Shadow edges on a pane and on its neighbours come from the shadow map, not the preset: under a large backdrop with the default shadow coverage they show stair steps, and a tighter `shadow.extent` around the parts removes them. An unknown name fails with the list of valid ones. `scene_capabilities` topic `materialPresets` lists the values.
### Material patterns

`pattern` gives a `surface` material a procedural texture, baked once and shared by every material with the same definition:

```json
{ "id": "oak", "pattern": { "type": "wood", "size": 0.6, "axis": "z" }, "roughness": 1 }
```

| Field | Meaning |
| --- | --- |
| `type` | `noise`, `wood`, `planks`, `bricks`, `tiles`, `marble`, `stone`, `concrete`, `metal`, `rust` or `fabric`, or `graph` (with `graph`) |
| `colors` | Two linear RGB colours to mix, darker first. Only `bricks` accepts a third, for the mortar; any other type rejects three. Each type has defaults |
| `size` | Metres per repeat of the texture, from 0.01 to 100 |
| `count` | Features per repeat, from 1 to 64: planks, bricks or tiles across, wood rings, or noise cells |
| `bump` | Relief strength, from 0 (flat) to 4 |
| `seed` | Nonnegative whole number. The same definition always bakes the same pixels |
| `axis` | Object axis the grain runs along: `x`, `y` (default) or `z` |
| `resolution` | Texture size: 256, 512 (default) or 1024 |
| `mapping` | `box` (default) or `uv`: how the texture is placed. See Material graphs |

A pattern needs no UVs. The texture is projected along the object's three axes and blended by the surface normal, so it
works on every geometry type and after mesh edits. Coordinates are in metres on the object, after its node scale, so a
stretched box keeps the texture's real size and the pattern moves with the node. Corners between faces show where one
projection meets another; set `mapping: "uv"` to follow `uv_unwrap` results instead (see Material graphs).

`color` defaults to white and tints the pattern. `roughness` and `metallic` scale what the pattern stores, so use
`roughness: 1` for its own surface and `metallic: 1` for `metal` and `rust` (rust stores where it is no longer metal).

A scene holds at most 16 different patterns, and materials that differ only in `color`, `roughness` or `metallic`
share one. Each takes about 4 MiB of texture memory at 512. Measured in Node on a Ryzen 5 5600X, baking at 512 took
about 0.2 to 0.55 s per pattern, which happens when the scene first renders it. Changing a pattern rebuilds the
renderer.

### Material graphs

`pattern` with `type: "graph"` bakes your own node graph on the CPU into textures. A graph is plain JSON and never code:
it is read against a fixed table of operators, checked against its limits before any pixel is computed, and turned into
texture images, so no text from a recipe ever reaches the shader. The language shares the shape of the field expressions
(one operator per object, numbers are constants, `[r, g, b]` is a constant vector).

```json
{ "id": "brick", "pattern": { "type": "graph", "mapping": "uv", "bump": 1.5, "graph": {
  "color": { "ramp": { "value": { "noise": { "scale": 8, "seed": 3 } }, "stops": [[0, [0.15, 0.05, 0.03]], [1, [0.6, 0.25, 0.15]]] } },
  "roughness": 0.9,
  "height": { "noise": { "scale": 8, "seed": 3 } } } } }
```

| Graph output | Becomes |
| --- | --- |
| `color` | Base colour map, linear RGB (a number is grey). Without it the material `color` stands alone |
| `roughness`, `metallic` | The metallic-roughness map. A material that has either output defaults the matching factor to 1 |
| `emission` | The emissive map. The material `emission` defaults to 1 when the graph has it |
| `height` | A normal map, so it gives bump. `bump` (0 to 4, default 1) scales the relief |
| `opacity` | The alpha of the base colour map. The material blends unless `alphaMode` says otherwise. The path tracer cuts it out at 0.5 |
| `clearcoat` | A per-pixel mask of the clear coat (the red channel of `layerMaps.clearcoatTexture`). The material `clearcoat` defaults to 1. The rasterizer and the CPU path tracer read it |
| `transmission` | A per-pixel mask of transmission (`transmissionMap`). The material `transmission` defaults to 1. Only the CPU path tracer reads the mask; the rasterizer and GPU tracers use the factor |

Nodes: `uv` (`"u"`, `"v"` or `"both"`), `noise`, `voronoi` (`output`: `distance`, `edge`, `cell`, `f2`, `f2MinusF1` or `smoothF1`, see below),
`wave` (`sine`, `saw` or `triangle` along `u`, `v` or `diagonal`), `checker`, `gradient` (`u`, `v` or `radial`), `ramp`
(2 to 8 stops of numbers or colours), `vec`, and the maths nodes `add`, `sub`, `mul`, `div`, `min`, `max`, `pow`, `abs`, `floor`,
`fract`, `sqrt`, `invert`, `clamp`, `smoothstep` and `mix`. Mixing nodes: `layer` (`base`, `top`, `mask`, `edge` 0.5, `softness` 0.1) puts `top` over `base` where the mask passes the edge, so `{ "layer": { "base": [0.45, 0.18, 0.06], "top": [0.1, 0.35, 0.7], "mask": chipMask } }` is paint over rust; `hue` (`color`, `shift` in turns, `saturation`, `value`) and `curve` (`value`, 2 to 8 `points` `[x, y]` with rising x, straight segments). Maths nodes work on each component of a vector. Every texture
node takes `at`, a vector expression such as `{ "add": [{ "uv": "both" }, { "mul": [{ "vec": [0.1, 0, 0] }, 1] }] }`, to warp
it. Scales and counts are whole numbers (1 to 64, even for `checker`), so every texture node tiles; `noise` and `voronoi` scales go up to 1024 when the bake resolution is at least 4 times the scale (256 at 1024, for snow sparkle or fine aggregate). `noise` is Blender's Noise Texture
(2D, detail `octaves - 1`, roughness 0.5, lacunarity 2, normalized; `seed` moves the lattice by whole cells) with the lattice
wrapped so it repeats. `"tile": false` matches Blender's Noise Texture exactly, does not repeat.

`voronoi` has one feature point in each of `scale` by `scale` cells, and its `output` picks what to read from them (#2857), each from 0 to 1:

- `distance` (default) is F1, the distance to the nearest point: a dome in every cell.
- `edge` and `f2MinusF1` (the same value) are F2 minus F1, the gap between the nearest and second nearest point. It is 0 on the line between two cells, so it draws cracks, cobble joints, dry mud and leather.
- `f2` is the distance to the second nearest point: layered cells that overlap their neighbours.
- `smoothF1` is F1 with the hard minimum replaced by a smooth one over the 5 by 5 cells around the pixel, as Blender's Smooth F1: no crease between cells, so organic blobs and scales. `smoothness` (0 to 1, default 1) sets the blend and only applies to this output; 0 gives F1. It costs 23.75 work units, the other outputs 7.5.
- `cell` is one random value per cell.

`jitter` (0 to 1, default 1) is how far each point strays from the middle of its cell: 1 is the look the node always had, 0 puts every point at the centre so the cells form a regular grid. Every output tiles.

`noise` also takes `kind`, `lacunarity` and `gain` (#2856). `kind` is `fbm` (the default, Blender's sum of octaves), `ridged` (each octave is one minus the absolute noise, squared, so sharp crests run where the noise crosses zero: rock, mountains, veins) or `billow` (the absolute noise: rounded hills, puffy clouds); the sums are divided by the amplitude sum, so every kind stays in 0 to 1. `lacunarity` (1 to 4, default 2) is how much the frequency grows each octave and `gain` (0 to 1, default 0.5, Blender's Roughness) how much the amplitude is kept. Leave them out and the output is the same as before. A tiling noise snaps each octave to a whole number of cells, so a lacunarity such as 2.5 still tiles.

Every texture node that takes `at` (all but `vertexGroup`) also takes `warp`: `{ "node": n, "strength": 1 }`, strength 0 to 4 tiles. It moves the lookup by `(n - 0.5) * strength`: a number moves `u` and `v` together (a diagonal push), a vector such as `{ "vec": [noiseA, noiseB, 0] }` moves `u` by its first part and `v` by its second, which flows the pattern in every direction. `warp` is applied after `at`, the warp node is read at the unwarped pixel so a periodic node keeps the texture tiling, and it costs the warp node plus 2. A marble is a `wave` warped by a `noise`: `{ "wave": { "frequency": 6, "direction": "diagonal", "warp": { "node": { "noise": { "scale": 3, "octaves": 5 } }, "strength": 1.5 } } }`.

Placement and pattern nodes:

- `brick` (`columns` 8, `rows` 8 and even, `mortar` 0.05 of a brick, `offset` 0.5 for every other row, `seed`, `output`: `mortar` is 1 in the joint, `edge` is 0 at a joint and 1 at the brick centre, `cell` is one random value per brick) lays a running bond and costs 4. Whole columns and even rows keep it tiling.
- `whiteNoise` (`scale` 16, `seed`, `output`: `value` or `color` for three independent values) is one random value per cell of a `scale` by `scale` grid. It tiles and is the same for the same seed.
- `image` (`asset`, the 64 hexadecimal characters of a catalog image ID from `scene_asset_catalog`; `output`: `color` is linear RGB decoded from sRGB, or `alpha`; `at` as for the other textures) reads a catalog image with bilinear filtering and repeats it across the tile, and costs 4. The host decodes the image into the same pool as texture sequence frames, so it follows their limits (2048 pixels a side, 64 MiB decoded in all); remote URLs are not accepted. Row 0 of the image is the top of the tile, as with a baked graph. A graph that names an image the host did not load fails when the material is baked, naming the asset.
- `fresnel` (`ior` 1.5, from 1.01 to 3) is Schlick's Fresnel reflectance at the angle between the view and the surface: about 0.04 face on for glass, rising to 1 at grazing angles. It depends on the camera, so no baked texture can hold it, and it works only as a factor of `emission`, alone or in a `mul` with the rest: `"emission": { "mul": [[1, 0.5, 0.2], { "fresnel": { "ior": 1.5 } }] }`. The graph bakes the colour; the rasterizer and the CPU path tracer multiply it by the curve per pixel with the same formula. The factor reaches the renderers as the material field `emissionFresnel` (the IOR, 0 when the graph has no `fresnel`). The GPU path tracers do not read it yet and draw the unscaled emission. Anywhere else, `fresnel` is an error.
- `coord` (`"generated"`, `"object"` or `"world"`) is a vector for `at`. `generated` is the unit tile, `object` and `world` are metres across the tile (texture u and v times the pattern `size`). A baked texture is projected onto the mesh, so it knows only the two axes of that projection and the third is 0; `object` and `world` are the same because box mapping reads the placed, scaled position.
- `mapping` (`vector`, default `{ "coord": "generated" }`; `scale` a number or `[x, y, z]`; `rotate` radians around Z; `offset` `[x, y, z]`) scales, turns and moves a vector, as Blender's Mapping node does. Feed it to `at`.

These make a material work on a mesh without UVs: box mapping (the default) projects the baked graph along the object axes, so a brick wall or a noise pattern needs no unwrap. `vertex_color` on a mesh already multiplies the baked colour. Not in graphs yet: ambient occlusion, bevel and curvature masks, and fresnel anywhere but as an emission factor (they need per-pixel data that a bake from `u` and `v` alone does not have).

`vertexGroup` (`{ "vertexGroup": { "name": "edge" } }`) is a number from 0 to 1: the weight of that vertex group of the mesh. The host draws each group the graph names into a map in UV space (every triangle filled at its UVs with the blend of its three vertex weights, spread a few texels past island edges) and bakes the graph with it, so the weight mixes with noise, ramps and `layer` like any other node: `"color": { "layer": { "base": [0.5, 0.5, 0.5], "top": [0.9, 0.6, 0.2], "mask": { "vertexGroup": { "name": "edge" } } } }`. The pattern needs `"mapping": "uv"` (box mapping has no `u` and `v` to match), and the mesh needs UVs and the group, or building the part fails and lists the groups it has. The result is an ordinary baked texture, so the rasterizer and the CPU and GPU path tracers read it the same way. A material used on two meshes bakes one set of textures for each mesh; one used on a single mesh bakes once. `material.wear` is separate: it needs no UVs and blends per pixel in the rasterizer only.

`meshMap` (`{ "meshMap": { "name": "curvature" } }`) is a number from 0 to 1 baked per texel from the mesh itself, so it is as fine as the texture and not as coarse as the vertices. `curvature` is 0.5 on a flat surface, up to 1 on a convex edge and down to 0 in a concave one: it measures in 3D how the face normal turns toward the other texels within `radius` metres (4 percent of the bounding box diagonal), so a bevel with a handful of vertices makes one band, also when a UV seam cuts it. `ao` is the share of 16 cosine-weighted rays above the surface that hit the mesh within a quarter of the bounding box diagonal (1 in a cavity, 0 in the open). `thickness` is the mean distance of 16 rays below the surface to the mesh behind it, as a share of the bounding box diagonal (0 thin, 1 thick). Like `vertexGroup` it needs `"mapping": "uv"` and a mesh with UVs, and it bakes once per mesh into an ordinary texture. Measured on a 20,000-triangle mesh at 512 by 512: curvature about 0.6 s (about 6 s at 2048 by 2048), `ao` about 3 s, `thickness` about 4 s on the CPU. The bake is bounded: the map is at most 2048 by 2048 and covered texels times rays may not pass 16,000,000, or building the part fails and says what to pass. The same module, `src/mesh-map-bake.js`, has `bakeMeshMap(geometry, name, options)` for rays, radius, gain, distance and seed, and `bakeHighToLowNormalMap(lowGeometry, highGeometry, { cage })`, which writes the tangent space normals of a second, high mesh onto the low mesh. A recipe cannot name a high mesh yet, so the normal bake is a library call.

`surface` (`{ "surface": { "output": "slope", "space": "world" } }`) is a number from 0 to 1 read from the mesh surface at each texel, for snow on top faces, moss on one side and dirt in low places. It is baked into UV space like `vertexGroup`: the normal and position of each texel are the blend of the three corner values (the face normal when the mesh has none), so a cube keeps hard edges and a sphere stays smooth. Where a mesh splits vertices at a gentle crease (terrain, rocks), the normals at one position are first welded: each takes the angle-weighted average of the normals there that bend less than 90 degrees from its own, so the mask edge does not follow the crease lines as stair steps. Bends of 90 degrees or more (a right angle, as on the edges of a cube) stay hard, and shading keeps the split normals. `slope` is the angle between the normal and straight up (+Y) as a share of a right angle: 0 on a flat surface facing up, 1 on a vertical wall and on everything facing down. `normalY` is the up part of the normal from -1 to 1 written as 0 to 1 (0.5 on a wall), for a threshold of your own. `height` is the up position, 0 at the bottom of the mesh and 1 at its top, or between `range` `[low, high]` metres when you pass one (`range` is only for `height`, and positions outside it clamp). `space` is `"world"` by default, so a rock turned on its side still has snow on top; `"object"` uses the mesh as modelled. World space places the mesh with the world matrix of the part when the scene is built, so the map is baked, not live: move or turn the part and build the scene again to update it. Like `vertexGroup`, it needs a pattern with `"mapping": "uv"` and a mesh with UVs, and every backend reads the baked texture. Use it as a `layer` mask or a `mix` factor, for example `{ "layer": { "base": [0.4, 0.34, 0.28], "top": [0.95, 0.96, 1], "mask": { "smoothstep": [0.1, 0.3, { "invert": { "surface": { "output": "slope" } } }] } } }` puts snow where the surface is flat.

Limits, checked while the recipe is read: at most 64 nodes in all outputs, depth 12 (the field expression limits), at most 8 ramp
stops, `resolution` of 256, 512 or 1024, and a work budget of 60 million units (60,000,000). A unit is about 33 ns of baking one pixel in Node (measured per node kind, so the budget is about two seconds of baking): a plain node costs 0.1, a `noise` octave 1.9
and a `voronoi` 7.5, plus 2.5 per pixel and 2 for each colour node; a `height` output is charged four times, because the bump reads it four times a pixel. Cost is per pixel, times the pixels of the texture. A graph of more than about 57.2 units a pixel is over it at 1024; use 512. A node that appears more than once with the same content, such as one snow mask that gates colour, roughness and bump, is read once: it counts once toward the 64 nodes and the work budget, and its value is worked out once for each pixel and shared by every output (bump reads the height four times a pixel, so a mask under `height` is still worked out for each of those). A graph that is over a
limit, holds an unknown operator or key, or holds any text other than the fixed names above is rejected with a message that
names the problem. Baking a graph of about 60 units a pixel at 1024 took 2 to 3 seconds in Node.

#### Mapping

`mapping` is `box` (default) or `uv`, and it applies to presets as well as graphs. `uv` samples the texture with the
geometry's UVs, so a mesh with a `uv_unwrap` stack node (or `geometry.uvs`) carries it without box projection seams; the
texture repeats outside 0 to 1 and tiles. `size` and `axis` only apply to `box`. A `uv` pattern on geometry without UVs
fails at render and at `scene_export_glb` with a message that names `uv_unwrap`. GLB export writes the baked graph textures
and the geometry UVs.

### Face images

`faceImages` on a node whose geometry is a `box` puts an image, a tiled texture or a per-frame image sequence on chosen faces of the part: a Roblox Decal (one image on one face) or Texture (an image tiled by a size in metres). Each entry is a `face` (`+x`, `-x`, `+y`, `-y`, `+z`, `-z`, seen upright from outside) and either `colorMap` (one catalog image asset ID) or `map: { "sequence": { "frames": [...], "fps": 30 } }`, plus any of:

- `tile: [u, v]`: metres one tile covers along the face (0.001 to 100000). The tiling stays the same size when the part is resized, so a 4 m wall at `[0.5, 0.25]` shows 8 by 8 tiles and a wall twice as wide shows 16 across. Leave it out and one image covers the whole face (1 Roblox stud is 0.28 m). `offset: [u, v]` (tiles) and `rotation` (degrees) move the tiles.
- `color` tints the image, `opacity` fades it, `alphaMode` is `blend` by default and takes the image's own alpha; `mask` with `alphaCutoff` gives a hard cutout.

```json
{ "id": "wall", "geometry": "block", "material": "brick", "scale": [4, 2, 0.5],
  "faceImages": [
    { "face": "+z", "colorMap": "<image id>", "tile": [0.5, 0.25] },
    { "face": "+x", "map": { "sequence": { "frames": ["<id>", "<id>", "<id>"], "fps": 30 } } }
  ] }
```

A sequence shows image `floor(time * fps)` of the list with no blending: set `fps` to the scene's frame rate to change the image on every frame (a character's face), or lower to hold each image longer; `loop: false` holds the last image. The same time drives `scene_look`, scene files and render jobs, so a frame range or a clip shows the same image for the same time. At most 6 entries a node and 5 stacked on one face; frames follow the [texture sequence](#image-sequence-maps) limits, local catalog images only.

Each entry becomes a child quad `<node>.face-<n>` with its own material of the same name, 0.5 mm outside the face with `decal: true`, so it follows the part and `set-node` and `set-material` edit it by those IDs. Set `faceImages` again to replace them all, or `null` to remove them. `worldScale: [u, v]` also works on a plain quad or mesh material with `colorMap` or a map sequence.

### Which geometries have UVs

An image map (`map.sequence`, `colorMap` and the other texture set maps) reads UV channel 0, and a geometry type either carries it or does not:

- UVs always: `sphere`, `grid`, `plane`, `circle`, `torus`, `line`, `lathe`, `extrude`, `tube`, `curve`, `sdf`, `text`, `terrain`, `cloud`, `floorPlan`.
- UVs when an image map is on them: `box`, `cylinder`, `cone`. Each box face shows the whole image, upright from outside. The cylinder and cone wall wraps it once around, and each cap shows it as a disc. One wrap is what Blender and three.js give their cylinder and cone, so the picture is stretched around the whole wall. To tile the picture instead, set `uvScale` or `worldScale` on the material. An untextured box, cylinder or cone has no UV buffer.
- No UVs: `icoSphere`, `mesh` (until a `uv_unwrap` node adds them), `fragment`, `dented`.

`meshMap`, `vertexGroup`, `uv_pack` and a pattern with `mapping: "uv"` still need a mesh with UVs, so on a box they refuse as before. `box()`, `cylinder()` and `cone()` called as library functions return no `uvs`.

### Image sequence maps

`map: { sequence: { frames, fps, loop } }` gives a `surface` material a colour map that plays a list of images, such as the output of a video or a simulation. It covers the colour map only (`map`; normal, roughness and emissive maps stay with `pattern`), needs geometry with UVs (see [Which geometries have UVs](#which-geometries-have-uvs)), and does not combine with `pattern`. `color` defaults to white and tints the frames.

```json
{ "id": "screen", "map": { "sequence": { "frames": ["<catalog image id>", "<catalog image id>"], "fps": 12 } } }
```

- `frames` lists 2 to 4096 IDs from `scene_asset_catalog`. The `--assets` folder takes PNG, JPEG and WebP files next to GLBs, with the same 64 MiB file budget, content-bound SHA-256 IDs and no links. An extension that does not match the file signature rejects the catalog. Entries report `kind: "image"` and `mimeType`; GLBs report `kind: "glb"`. No remote URLs are read.
- All frames share one size, at most 2048 pixels a side (16 MiB decoded), and a scene keeps at most 64 MiB of decoded frames at once. Frames are read without colour conversion and should be opaque. The catalog reads each image's header and skips one over these limits, or one whose header gives no readable size (a JPEG whose frame header cannot be found), so the page never decodes it.
- `fps` is above 0 and at most 60. The frame at scene time `t` is `floor(t * fps)`: wrapped around the list when `loop` is true (the default), held on the last frame when `loop` is false. Frame 0 shows before any motion time is set.
- The clock is `motionTime`, the one `scene_look`, `scene_review` and `motion` use. A seek is deterministic: the same time gives the same frame and the same PNG bytes. `scene_render_submit` reads it from `settings.motion.start` plus the elapsed time (or a timeline shot), so a still or video frame shows the frame that `scene_look` shows at that time. The same time is also the clock a post pass reads in both, so a pass anchored to a moving part stays on it in a look. A recipe with a sequence and no authored `motion` accepts `settings.motion`.
- The renderer uploads a frame with `updateTexture` only when the frame index changes. `scene_inspect` reports `textureSequences`: material, frame count, `fps`, `loop`, current `index` and its asset ID.
- A sequence of up to 64 frames loads whole with the scene. A longer one streams: the scene starts with its first frame, and the host reads and decodes the frame of each requested time from the catalog, keeping that frame and the one before it (two decoded frames per sequence, 32 MiB at 2048 pixels). A video job walks the frames in order and decodes each once, so the limit is per frame and for the frames kept at once, not for the list; the same frame gives the same pixels whole or streamed. The catalog takes up to 4096 image files besides its 64 other files. Streaming serves `scene_look` with `motionTime` and raster still and video jobs. `scene_review` (every shot in one call) and path traced or native jobs (`settings.renderer`, which a streamed sequence refuses with an error that says so) need a sequence of at most 64 frames; a frame that was not decoded is an error, never a silent stale frame.
- A folder of more than 256 consecutively numbered images (`frame_0001.png` to `frame_2700.png`, one prefix, one digit width, no gap) is not listed per frame. `scene_asset_catalog` lists it once under `sequences`: `{ kind: "sequence", name: "frame_####.png", first, last, frames, width, height }`. Write `map: { sequence: { catalog: "frame_####.png", fps } }` instead of `frames`; pass exactly one of the two. The server swaps in the frame IDs when the call arrives, so the scene, its checkpoints and its render jobs stay pinned to the hashes. The catalog reads only the first frame at startup and hashes the rest on the first recipe that names the sequence (or the first frame ID it does not know yet, such as one from an earlier run). An unknown pattern is refused with the nearest ones; a frame over the limits above is refused with its name. Shorter folders keep one entry per frame.
- `set-material` and `add-material` take `map`; the frames must be catalog images, which the host decodes before the edit.

### Scanned texture sets

A `surface` material takes the maps of a scanned set (Poly Haven, ambientCG) from catalog images. Put the files of one material in a sub-folder of `--assets`, with at least two standard map names, and `scene_asset_catalog` lists the folder once under `textureSets` (`kind: "textureSet"`, its `name` and the maps it found with asset ID, size and file name) instead of one image per file:

```json
{ "id": "rock", "textureSet": "rock_boulder_dry" }
```

- Names it knows (case does not matter, `_`, `-` and camel case separate words): colour is `color`, `albedo`, `diffuse` or `diff`; normal is `normal`, `nor`, `nrm` with `gl` or `dx` (`NormalGL`, `nor_dx`), and OpenGL wins when a folder holds both; `roughness` or `rough`; `metallic`, `metalness` or `metal`; `ao` or `occlusion`; `height`, `displacement` or `disp`. A folder with two files for one map is skipped and listed under `skipped`. PNG, JPEG and WebP only, at most 2048 pixels a side (a 1k set fits; a larger image is skipped with its reason), so a `.exr` displacement map is not found.
- `textureSet` fills `colorMap`, `normalMap`, `roughnessMap`, `metallicMap`, `occlusionMap` and `heightMap`. Each of those fields also takes one catalog image asset ID on its own and wins over the set. The server swaps `textureSet` for the IDs before the scene is built, so a saved recipe holds only the pinned IDs; a library caller passes the IDs. An ID that is not a catalog image, or a set name that does not exist, fails with the field, the IDs that would fit and the sets the catalog has.
- `normalConvention` is `opengl` (default) or `directx`. A DirectX normal map has its green channel flipped when it is loaded; a set whose only normal map is a DirectX file sets it for you.
- The roughness and metallic images are repacked into one glTF metallicRoughness texture: roughness in green, metallic in blue, the other channel 255, so `roughness` and `metallic` (default 1 when their map is set) still scale it. Their sizes must match.
- `uvScale` (one number or `[u, v]`, 0.001 to 10000 tiles), `uvOffset` (`[u, v]`, -10000 to 10000) and `uvRotation` (degrees, -360 to 360) move every map of the material together, the way glTF `KHR_texture_transform` does: scale, then rotate, then offset. `worldScale` (metres per tile, 0.001 to 100000, one number or `[u, v]` for a tile that is longer than it is wide, not together with `uvScale`) sets the tile size instead, so a 2 m scan repeats every 2 m on a 10 m plane and on a 400 m terrain alike (a chunked terrain too). The transform is baked into the mesh UVs, so the rasterizer, both path tracers and the exports read the same texture coordinates; `worldScale` measures the mesh at its rest size, scaled by its node. A material without these fields draws exactly as before, and the fields need a catalog map and a mesh with UVs.
- `colorMap` is the base colour, `color` tints it (white by default). It cannot be combined with `map` or `pattern`, nor can any other map field with `pattern`. The material needs UVs, which [some geometries have](#which-geometries-have-uvs).
- `occlusionMap` is drawn by the rasterizer; the path tracers ignore it and say so. `heightMap` is kept and exported in the recipe, but no renderer displaces or parallax-maps from it yet: `scene_inspect` reports it as ignored, and a path traced render lists it under `ignored`.

Nodes contain `id`, optional `label`, `parent`, `translation`, `rotation`, and `scale`.
Mesh nodes also require both `geometry` and `material` resource IDs.
Group nodes have neither resource reference.
The default parent is `null`.
The default transform is `[0, 0, 0]`, `[0, 0, 0, 1]`, and `[1, 1, 1]`.
Rotation uses an XYZW quaternion that the session normalizes.

Quaternions must be finite and nonzero.
Scales must remain positive at Float32 precision.
The scene graph rejects missing parents, cycles, excessive depth, singular transforms, and world transforms that overflow Float32.
Normal transforms must also remain finite.
Cached local geometry bounds provide a conservative world Float32 check from eight corners per mesh.
The check bounds the sum of absolute matrix products, so intermediate shader arithmetic cannot overflow before cancellation.

The camera contains `eye`, `target`, `up`, `fov`, `near`, and `far`, plus the optional `projection`, `orthoScale`, `focalLength`, `sensorWidth`, `shift`, `fStop` and `focusDistance` when the recipe sets them.
Its defaults are `[4, 3, 5]`, `[0, 0, 0]`, `[0, 1, 0]`, `45`, `0.1`, and `1000`.
FOV uses degrees and ranges between zero and 180.
The clipping range must satisfy `0 < near < far` at Float32 precision.
Eye and target must differ at Float32 precision.
The session normalizes the nonzero up vector and rejects collinear view directions.

View and projection matrices must remain finite and nonsingular at Float32 precision.
Projection validation uses aspect one because the renderer owns the actual target aspect.
An explicit top view can use `eye: [0, 3, 0]`, `target: [0, 0, 0]`, and `up: [0, 0, -1]`.

### Instances on points

A node with `instances` repeats its geometry and material at points. At `scene_create` it becomes a group node (the
node's id, with its transform and parent) and one child node per point (`<id>.0`, `<id>.1`, and so on), all sharing
the geometry and material, so the renderer draws them as one instanced batch. After that they are ordinary nodes.
`instances` is accepted in the recipe, not in an `add-node` operation.

```text
{ "id": "grass", "geometry": "blade", "material": "green", "parent": "ground",
  "instances": { "surface": { "geometry": "ground-shape", "count": 300 }, "seed": 3,
                 "where": { "gt": [{ "attr": "position", "component": "x" }, 0] },
                 "yaw": true, "scale": [0.7, 1.3] } }
```

Give exactly one point source. `grid` is `{ counts: [nx, ny, nz], spacing: [dx, dy, dz] }`, centred on the group; a spacing of 0 on an axis with more than one point is an error, because the points would coincide.
`scatter` is `{ count, min, max }`, seeded random points in a box. `surface` is `{ geometry, count }`, seeded points
on the triangles of a recipe geometry in proportion to their area; they are in that geometry's own space, so parent
the group to the node that carries it. `seed` (default 0) fixes the placement. `where` is a number
[field expression](mesh.md#field-expressions) over the points (position, normal, index): points where it is 0 are
dropped; a `where` that drops every point is an error that names the node, the candidate count and the fix, not an empty group. `curve` is `{ points, count, length, closed, fillet }`: `count` points at equal arc length along the polyline through `points` (2 to 256, the first and last on its ends unless `closed`), or `length` spacing in metres between samples (not both `count` and `length`), with `fillet` rounding every corner by that radius (reduced where it does not fit). `yaw` turns each instance randomly about up, `alignToNormal` (surface or curve) turns up to the surface normal or the direction of the curve, and `scale`
is a random uniform `[min, max]`. At most 2048 candidate points per node, and the scene's node limit still applies.
The group's own scale applies to the spacing and the points, because they are in its space.

`place` shapes the points once the source made them, and every choice is seeded and repeatable:

```text
"place": { "spacing": 1.4,
           "density": { "saturate": { "sub": [1.4, { "mul": [0.1, { "length": [{ "attr": "position" }] }] }] } },
           "variants": ["rockRound", "rockTall", { "geometry": "rockBlock", "material": "moss" }],
           "size": { "vec": [1, { "add": [0.6, { "mul": [0.5, { "fract": { "mul": [{ "attr": "index" }, 0.37] } }] }] }, 1] } }
```

- `spacing`: Poisson-disk minimum distance. Points are kept in order, so a point is dropped when a kept one is closer; give enough candidates (`count`) to fill the area. Runs after `where` and `density`.
- `density`: number field, the chance (0 to 1) that a point stays. Same seed, same points.
- `variants`: 1 to 16 geometry ids or `{ geometry, material }`. Each point takes one at random, or the one `variant` (a number field, rounded down and wrapped) names. The node needs only a material when it lists variants.
- `rotation`: vector field of extra Euler angles in radians, turned after `yaw` and `alignToNormal`. `size`: number or vector field, a scale per point, multiplied by the `scale` range and kept from 0.001 to 1000.
- `at`: with a `surface` source, `"vertices"` (welded by position) or `"faces"` (centres, normal of the face) place on the mesh itself; `count` is then the most points allowed, and more is an error.
- `realize` (on `instances` or `place`): when `true`, merges the placed instances into one realized mesh per material under the group node, bounded by `maxVertices`.

### Placed catalog assets

A node with an `asset` field places a GLB from the `--assets` catalog inside the recipe, so one scene holds terrain, lights, procedural meshes and imported models (`scene_create_asset` opens one asset alone). The node is a group: its transform places the asset, and its parts become generated child nodes named `<node>/<part index>` that `scene_inspect` and `scene_export_recipe` leave out.

```json
{ "id": "tree-1", "translation": [4, 0, -2], "asset": { "id": "<64 hex asset id>",
  "materials": [{ "name": "Leaves", "color": [0.2, 0.5, 0.1] }],
  "clip": { "index": 0, "start": 0.5, "speed": 1, "loop": true } } }
```

- `id` is an id from `scene_asset_catalog`. `materials` override source materials by glTF material name (`color`, `metallic`, `roughness`, `opacity`, `emission`, `emissiveColor`, and `tag`: `foliage` or `grass` makes the leaves of an imported tree sway in `environment.wind` and cast moving shadows, like grown ones); `scene_inspect` lists the names. Placements with the same overrides share one material. An override with an `id` (1 to 128 characters, one per placement, not an existing material id) gets a material of its own that a `motion` material track names: `{ "kind": "material", "id": "stool-heat", "property": "emission" }` (also `emissiveColor`, `color`, `metallic`, `roughness`) fades a heat glow without another `scene_create`; textures and shading stay.
- `flatten` flattens every material of the placement in one call, so an imported asset with many materials needs no override per name: `{ "unlit": true }` draws them without lighting, `{ "color": [0.8, 0.8, 0.8] }` paints them one linear colour, and both together give a flat unlit silhouette for a sketch-to-3D composite. It drops normal, metallic-roughness, occlusion and emissive maps and any glow; `color` also drops the base map, and `unlit` alone keeps it. Other placements in the scene are unchanged, and a named override in `materials` still wins over `flatten`. To flatten the whole scene, give each placement the same `flatten`.
- `pattern` puts a material graph on a placed scan, over its own textures: `asset.pattern` for every part, or `asset.materials[].pattern` for the parts of one named material (the named one wins). It takes `graph` (the outputs of a [material graph](#material-graphs)), `resolution` (256, 512 or 1024; 512 by default), `size` and `bump` like a recipe `pattern`, and always bakes in the scan's UV space, so the `surface` slope and height masks work on it. A `base` node reads the scan's own maps at the texel's UV: `{ "base": { "output": "color" } }` (the base colour map, linear), `roughness` and `metallic` (the green and blue of its metallic-roughness map) and `normal` (the tangent-space normal, each component from -1 to 1). An output the graph does not write keeps the scan's own texture, so a graph with only `color` leaves its roughness and normal maps as they were, and a `layer` whose mask is 0 shows the scan's colour unchanged. The material's colour and roughness factors still multiply the baked maps. Snow on the flat faces of a scan rock: `"pattern": { "resolution": 1024, "graph": { "color": { "layer": { "base": { "base": { "output": "color" } }, "top": [0.86, 0.9, 0.97], "mask": { "smoothstep": [0.3, 0.6, { "invert": { "surface": { "output": "slope", "space": "world" } } }] } } } } }`. Limits: the graph is checked at its resolution against the same work budget as any graph, a base map larger than the resolution is averaged down to it, and the part's UVs must lie inside 0 to 1. A placed asset refuses a `height` output (the scan keeps its normal map), `image` nodes, `mapping` other than `uv`, a `base` node for a map the material lacks, a map with a UV transform or TEXCOORD_1, a GPU-compressed map, and combining `pattern` with `flatten`, `crowd` or an override `id`; `base` outside a placed asset is refused. Each placement with a graph gets its own material, so its copies do not draw as one batch (#3202).
- `emissionMask` on an override (and on a recipe material) makes the glow follow a ramp along one axis: `{ "axis": "y", "from": 0.2, "to": 0.5 }` multiplies `emission` by a smooth step that is 0 at `from` and 1 at `to` (a `from` above `to` flips it), so a part glows only at the end that would cool last while its texture and shading stay. The axis and the numbers are metres in the part's own space (the coordinates its mesh stores, at the placement's scale), so read them from the bounds in `scene_inspect`. Without `emissionMask` nothing changes and the shader pays nothing. The rasterizer applies it; the path tracers and GLB export ignore it (the path tracer says so in its notes). Errors name the field and what to pass, such as `emissionMask.axis` needing `x`, `y` or `z`.
- Placements of the same asset share geometry and materials, so they draw as one instanced batch per material (`drawBatches` in the render status stays flat as copies are added). Skins and morphs keep working.
- `clip.index` is a clip number or `"all"`. A GLB that holds one animation per object plays only the object of the clip you name, so `"all"` plays every clip of the asset together on one timeline as long as the longest clip; a shorter clip holds its last frame. `scene_inspect` warns (`clip-leaves-other-animations`) when a number leaves out clips that move other nodes; a Blender export keeps one animation per object only with `export_animation_mode='ACTIVE_ACTIONS'`.
- `clip` plays that clip, held at its first frame until scene time `start`, then at `speed`, looping unless `loop` is false. Each placement that plays a clip gets a decoded copy of its own (its geometry is not shared), because a pose is state of one decoded asset. A seek gives the same frame as playing to that time. `set-motion` tracks still move the node itself, so a walking figure is a clip plus a motion track on the same node.
- Bounds: 512 placements, 32 different assets (and 64 MiB of asset files in all), 16 placements playing a clip, and `maxNodes` for the generated parts. Placed geometry does not count against `maxVertices`; each asset keeps the decoder limits of the catalog.
- `scene_inspect` adds `assets`: per placement the asset id, part count, world bounds, clips (index, name, duration), material names and the playing clip.
- `scene_apply` places a catalog asset with `add-node` even when the scene had none: the first `add-node` with an `asset` loads it, a second node with the same asset id shares its geometry. An id the catalog does not list fails with an error that names it and points at `scene_asset_catalog`, and the placement and asset bounds below still hold. A session made by `scene_create_asset` holds one imported asset and cannot place others. Render jobs draw placed assets and play their clips on scene time (`settings.motion.start`).

### Grass

A node with a `grass` field is a group that covers a terrain node with blade grass from the addon in [Grass](https://crucible.codepawl.com/grass.md): `{ "ground", "preset", "density", "height", "dryness", "seed", "area", "polygon", "exclude", "cullDistance" }`. Tiles and levels come from the recipe camera eye at each edit, the blades sway with `environment.wind`, and `scene_inspect` adds `grass`. Fields and limits are in [Recipes and MCP](https://crucible.codepawl.com/grass.md#recipes-and-mcp).

### Clutter

A node with a `clutter` field is a group that scatters pebbles, rocks, twigs and fallen leaves from the addon in [Ground clutter](https://crucible.codepawl.com/clutter.md): a list of one to four layers `{ "preset", "terrain" or "area", "density", "seed", "slopeLimit", "mask", "exclude", "cullDistance" }`. Its parts become generated child nodes like placed assets, and `scene_inspect` adds `clutter`. Fields, limits and an example are in [Recipes and MCP](https://crucible.codepawl.com/clutter.md#recipes-and-mcp).

### Vegetation

A node with a `vegetation` field is a group that grows trees from the addon in [Vegetation](https://crucible.codepawl.com/vegetation.md). Its parts become generated child nodes like placed assets (`<node>/<instance>/<bark|foliage>`), left out of `scene_inspect` nodes and `scene_export_recipe`.

```json
{ "id": "forest", "vegetation": { "mix": { "broadleaf": 3, "conifer": 2, "bush": 2 }, "seed": 11, "season": 0.4,
  "scatter": { "ground": "hills", "density": 0.014, "slopeLimit": 30, "exclude": [{ "center": [0, 0], "radius": 8 }, { "node": "cabin", "radius": 3 }] } } }
```

- One tree: `{ "species": "conifer", "seed": 2, "height": 9, "leaves": "cards" }` grows at the node transform. `{ "preset": "oak", "tree": { "branchAngle": 50 } }` grows a named tree (oak, ash, aspen, birch, pine, palm, bush) with growth overrides; `scene_capabilities` topic `treeGrowth` lists every parameter and range, and [Vegetation](https://crucible.codepawl.com/vegetation.md) describes them. `preset`, or `species` with `tree`, also works with a scatter; `tree` is refused with `mix`. A scatter takes `mix` (species weights, also `grass` and `flowers`) and `scatter`: `ground` (a node drawing a terrain geometry; give the group the same transform), `density` per square metre, `slopeLimit` degrees, `area` `{min,max}` in `[x,z]`, `exclude` (circles, boxes or a node and radius; terrain holes always stay clear), `variants` and `scale`.
- The same options give the same instances as `scatterVegetation` from `crucible/addons/vegetation`: the recipe path calls it with the terrain's `heightAt` and `isHole`.
- Levels of detail come from the recipe camera `eye` when the scene is built or edited (`distanceScale`, `cullDistance`), never from the frame being drawn, so a seek, a camera track or a shot cannot change them. Edit the camera with `set-camera` to regrow the levels for another viewpoint.
- `season` runs 0 summer, 0.35 gold, 0.6 orange, 0.85 brown; 0.9 and above drops the leaves of broadleaf, birch and bush, while conifer and palm stay green. A bare broadleaf grows two generations of fine twigs past its smallest branches, about a centimeter thick at the tips, so its winter crown forks like a real one; up close it draws every twig, at level 1 the first generation, and the far levels draw one branch level more than the tree in leaf. Cards recolour their leaf sprite and mesh leaves and grass blades recolour the material.
- Materials with tag `foliage` or `grass` sway. `environment.wind` is `{ "strength": 0.3, "direction": 0 }` (strength 0 to 4; direction in degrees, 0 toward +x and 90 toward +z, turning the sway and the grass gusts). The wind clock is the render time, so a render job or `scene_review` `rendererTime` gives the same frame at the same time.
- At most 1000 instances (a scatter whose area times density is above 4000 is refused first), and `maxNodes` for the generated parts. `scene_inspect` adds `vegetation`: per node the instances, culled count, triangles, and per species the instances and the count at each level.

### Crowds

An asset placement with a `crowd` field fills its group node with `count` (1 to 1000) copies of one catalog character playing one clip, each at its own time offset and rate, drawn as one batch per material. Options and measurements are in [Crowds](https://crucible.codepawl.com/retarget.md).

```json
{ "id": "people", "asset": { "id": "<catalog asset id>", "crowd": { "clip": 3, "count": 200, "seed": 7, "spacing": 2, "farDistance": 25, "farRate": 6 } } }
```

- `clip` is a clip index, `seed` is a whole number from -2147483648 to 2147483647, `layout` is `grid` or `scatter`, and the pose is a pure function of scene time, `seed` and the recipe camera, so a render at a time equals the frame reached by playing. People farther than `farDistance` from the recipe camera hold each pose for `1 / farRate` seconds. The distance is measured from each person's world position at that time, so it follows a parent group that moves or has a motion track.
- The crowd takes one decoded copy of the asset, the generated part nodes (count times materials) count against `maxNodes`, and `scene_inspect` lists it under `assets` with `kind: "crowd"`, `instances`, `batches`, `frames`, `paletteBytes` and `boundsRadius`.

### Seams between meshes

Three node fields fix what looks wrong where meshes meet; `add-node` and `set-node` take all of them. `blend: { "radius": 0.15 }` (metres, 0.005 to 2) softens the seam where a rock or trunk cuts into the ground and needs a preview with depth; see [mesh-blend.md](mesh-blend.md). `decal: true` and `depthLayer` (0 to 4) stop z-fighting on flush faces; see `depthBias` in `scene_capabilities`. For an image on a face, see [Face images](#face-images).

### Visibility and render flags

Five node fields change how a node renders; `add-node` and `set-node` take them, and `scene_capabilities` lists them as `renderFlags`.

- `visible: false` hides the node and every child: nothing is drawn and nothing casts a shadow, but the parts stay in their batches, so a film can cut between shots without parking parts out of view. Key it in a motion track with `{ "kind": "node", "id": "robot", "property": "visible", "keyframes": [{ "time": 0, "value": 1 }, { "time": 2, "value": 0 }] }`; values are 1 or 0 and the track steps by default.
- `castShadow: false` and `receiveShadow: false` (mesh nodes, and asset placements, where the flag applies to every part of the placed asset) stop a mesh casting or receiving shadows. Both default to true; glass casts none unless `castShadow` is set.
- `holdout: true` writes zero colour and zero alpha where the mesh covers, and still hides what is behind it and still casts its shadow. `shadowCatcher: true` draws only the shadow it receives, black with the shadow as premultiplied alpha, and casts none. Both are for compositing over footage and need a transparent canvas: `new CrucibleRenderer(canvas, parts, { transparent: true })`. A node is never both. The shadow catcher shows the sun shadow only.

- `shadowOnly: true` (mesh nodes) keeps the node in the shadow passes and leaves it out of the picture, the same as Blender's Ray Visibility > Camera off. Use it for a gobo, such as a window frame outside the shot that throws bars of sun onto a wall. It is also left out of depth, object ID and wireframe passes. It defaults to false, so no scene changes. A node cannot set `shadowOnly` together with `castShadow: false`, `holdout` or `shadowCatcher`. Every backend honours it: the raster renderer, and Cook on the cpu, gpu (WebGL2), webgpu and native backends (both native kernels). Cook leaves the node out of camera rays (the first hit of each path) and keeps it for shadow and bounce rays, so a mirror or glass can still show it. No backend lists it as an ignored feature.

- `rayVisibility` (mesh nodes, native path tracer only) hides a node from one ray kind: `'glass'` is the shorthand for `{ "shadow": false }`, so sun and sky are sampled through a window pane while it still shows and refracts; the object form takes booleans for `camera`, `diffuse`, `glossy`, `transmission`, `shadow` and `volumeScatter`. An emissive node cannot hide from diffuse, glossy or transmission rays, and `shadowOnly` needs shadow rays on. The raster renderer ignores it. See [path-tracer.md](https://github.com/codepawl/crucible/blob/main/docs/path-tracer.md).

Parts with different `castShadow`, `receiveShadow`, `holdout`, `shadowCatcher` or `shadowOnly` values batch apart; `visible` never splits a batch. `receiveShadow`, `holdout`, `shadowCatcher` and `shadowOnly` changes need `replaceParts`, not `updateParts`.

### Relations between parts

A mesh node can list `relations` that place it against other mesh nodes, so a resized body keeps its handle where it
belongs. They work on world bounds, are solved after the geometry exists, and are solved again on every `scene_apply`
(a `set-node` that moves or resizes the target, an `edit-mesh` that changes its faces), so one edit to the body moves
every part that sits against it.

```text
{ "id": "handle", "geometry": "grip", "material": "steel",
  "relations": [ { "kind": "attach", "to": "body", "side": "+x" } ] }
```

| `kind` | Fields | Decides |
| --- | --- | --- |
| `attach` | `side`, `offset` | Touches the target's face on `side` (`+x`, `-x`, `+y`, `-y`, `+z`, `-z`) and centres on the other two axes. |
| `gap` | `side`, `offset` | Only the touching axis: `offset` metres from the face, negative sinks into the target. |
| `flush` | `side`, `offset` | Puts its own face on `side` level with the same face of the target. |
| `align` | `axis`, `at`, `offset` | Puts its `min`, `center` or `max` on that axis at the target's. |
| `centered` | `axes` (default all three) | Centres on those axes. |
| `level` | `at` (`bottom`, `center`, `top`), `y` | Names no target and takes no `to`. Puts that face of the part at world height `y`, so a seat "with its upper surface at 0.5 m" is `{ "kind": "level", "at": "top", "y": 0.5 }` and the half-thickness is not summed by hand. Only Y is decided. |

`level` reads the world bounds of the part, so a part turned by `rotation` rests on its rotated extent, and it is a relation like the others: it is stored, solved again after every edit (a thicker slab grows downward and keeps its top at `y`), and the exported recipe holds the solved translation. Recipes without it export unchanged. Every other relation takes `to` (a mesh node ID) and an optional `region`, a mesh tag: only the faces of the target that carry
that tag count as its bounds, so a part can sit on the tagged top of a tank and not on its tallest point. A relation
decides only its own axes and replaces the node's `translation` on them; the other axes keep the authored value.

Limits: at most 8 relations per node and 256 nodes with relations. Targets and nodes must be mesh nodes. Two relations
on one node cannot decide the same axis. Relations form a graph over parts and parents; a loop (a part waiting on its own
child included) is rejected with the loop spelled out. Solving is deterministic: the same recipe gives the same
translations, whatever the order of the nodes. A relation that cannot be satisfied, such as an unknown tag, rejects the
whole edit and names the relation. `relations: []` in `set-node` removes them and keeps the part where it is. The
exported recipe holds both the relations and the solved translations. Motion and physics move nodes after the solve and
know nothing of relations. The code loads on demand (`relations`, see On-demand code). The MCP schema only says `relations` is a list; the kinds and fields are in `scene_capabilities` under `relations`.

## Transactions and ownership

`apply(operations, { expectedRevision })` requires the current revision and returns the new revision.
It rejects an empty command list.
Each successful application increments the revision once, including a command that retains existing values.
Stale revisions and invalid commands leave canonical state, published matrices, materials, and the revision unchanged.
Every command in a batch stages before any command publishes.
An edit that names no field to change (`set-camera` alone, `set-node` or `set-material` with only an `id`, `set-shadow` with `{}`) is refused with the fields the operation takes, so a dropped or misspelled field name does not pass as a success that spends a revision.

A batch of plain `set-node`, `set-material` and `set-camera` edits does not copy and check the whole recipe a second time, and part bounds are measured again only for parts whose matrix changed, so a pose edit at 961 parts takes about 9 ms instead of about 60 ms. Such a batch clones only the nodes it names, skips the validation compile of the scene graph when every geometry is already built (the compile that builds the graph runs once), and keeps the undo snapshot as a shared read-only recipe. A batch that only moves or shows nodes (`translation`, `rotation`, `scale`, `visible`) of a scene without relations, placed assets, armatures or motion also keeps the committed scene graph and moves the touched nodes in place instead of building the graph again, and nodes an earlier edit already checked are not checked again, so such an edit at 961 parts takes about 2 ms. A refused edit puts the graph back as it was. A scene with placed assets, armatures, relations or instances copies the whole recipe as before. The final recipe is still checked against `maxRecipeBytes`.

Commands run sequentially against a private candidate recipe.
Final resource references and hierarchy must be valid before publication.

| Operation | Fields |
| --- | --- |
| `set-node` | `id`, optional `translation`, `rotation`, `scale`, `parent`, `label`, `geometry`, `material` |
| `set-material` | `id`, optional `color`, `metallic`, `roughness`, `emission`, `emissiveColor`, `pattern`, `map` |
| `set-camera` | Optional `eye`, `target`, `up`, `fov`, `near`, `far`, `projection`, `orthoScale`, `focalLength`, `sensorWidth`, `shift`, `fStop`, `focusDistance` directly on the command; `focalLength` replaces `fov` and `fov` replaces `focalLength` |
| `add-geometry` | `geometry`, containing a complete geometry record |
| `remove-geometry` | `id` |
| `add-material` | `material`, containing a complete material record |
| `remove-material` | `id` |
| `add-node` | `node`, containing a complete node record |
| `remove-node` | `id`, optional boolean `recursive`, default `false` |
| `add-explosion` | `id`, `center`, `size`, optional `start`, `seed`, `fuel`, `debris`, `shake`, `ground`, `sparks`, `motionBlur` (see Explosions below) |

### Explosions

`add-explosion` writes a layered blast into ordinary recipe sections in one call, so an agent does not hand-build six systems (#1050).
`{ "type": "add-explosion", "id": "blast", "center": [0, 0, 0], "size": 6, "start": 0.5, "seed": 7, "fuel": "oily", "debris": { "node": "crate" }, "shake": 0.4 }`

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Letters, digits, `-` and `_`, up to 64. Every part of the blast gets an ID that starts with `id-` |
| `center`, `size` | required | Charge position and fireball diameter in metres, 0.5 to 100 |
| `start` | `0` | Scene time of the blast in seconds, 0 to 3600 |
| `seed` | `1` | The same seed writes the same recipe byte for byte |
| `fuel` | `dry` | `oily` bakes more dark smoke, thickens the volume and adds more sparks |
| `ground` | `center` y | Height of the ground for the dust, rubble landing and the scorch |
| `shake` | `0.4` | Camera shake 0 to 1 over about 1 s; skipped when the camera already has an eye track, refused when you ask for it |
| `sparks` | `"streaks"` | `"streaks"`: 700 spark streaks (900 for `oily`), the `sparks` particle system of the approved preview. `"specks"`: the plain glowing specks of the first release. `"none"`: no sparks and no `id-sparks` node or `id-spark-glow` material. An object `{ count, speed, lifetime }` means streaks with overrides (`count` 1 to 2000, `speed` and `lifetime` a number or `[min, max]`; 0 to 100 m/s and 0.05 to 5 s). `true` and `false` are aliases of `"streaks"` and `"specks"` |
| `motionBlur` | `true` | The fireball blurs along its simulated velocity under the scene's motion blur shutter: `effects.motionBlur.shutter` if the scene has one, else 0.0417 s (one frame at 24 frames a second), which is written into the recipe. `false` bakes no velocity and leaves `effects` alone |
| `debris` | none | `{ node }`: a convex mesh node broken into 12 loose pieces thrown outward by impulse events at `start`. Needs a `physics` section with a fixed floor body first; its `duration` grows to cover `start + 3` |

What it writes (read it back with `scene_export_recipe`, then tweak any part):

- `effects.flash` and an `effects.distortion` ring at the centre, which fade by their own decay and falloff on the scene clock.
- One gas-sim grid volume in `environment.localVolumes` for the fireball and the smoke: a baked simulation of a ground blast (`src/gas-sim.js`), lit by the physical blackbody of each voxel's flame, remapped to 1300 to 1900 K (cooler than Blender's 1500 to 3000 K, which reads closer to the Cycles orange) (`flameTemperature`, `blackbodyIntensity`), so the smoke edge glows orange, with `castShadow` on so the smoke shades the floor and `lightsScene` on so the fire lights the set. It is the look of the gas-sim preview (#1735). `size` scales it: the box is 3.2 times `size` on a side, the density and emission shrink with the box so the blast keeps its optical depth, and it plays at 24 frames a second divided by the square root of `size / 2.5`, so a bigger fire rises slower. The grid is 32 cubed and 72 frames (3 s of simulation at the reference size), held on its last frame, baked once per fuel and seed in about 4 s. `oily` bakes more and darker smoke and thickens the volume.
- The grid files are named `explosion-<fuel>-<seed>-velocity_0000.67vg` to `_0071`, plus `explosion-empty-velocity.67vg` for the wait. With `motionBlur: false` the files carry no velocity and the names drop `-velocity` (`explosion-<fuel>-<seed>_0000.67vg`, `explosion-empty.67vg`); a velocity bake is twice the bytes (about 28 MB for the 72 frames) and bakes in about the same time. The empty file is for the wait before `start` (one empty frame per frame of playback, so `start` is at most about 18 s at size 2.5 and the error says the limit for the size you pass). No such files exist on disk: the MCP server bakes them from the name (about 4 s the first time for a fuel and seed, cached after) and sends them to the preview page with `scene_apply`, so the page spends no time on the bake, and so `scene_export_recipe`, `scene_create` and the render jobs work with the recipe as it is.
- `effects.bloom` is left as the scene has it (the default is strength 0.12), so the fireball is not glowier than the volume itself; raise it for a hazier look. The volume's own light replaces the old point light and its track.
- `effects.flash` and an `effects.distortion` ring at the centre, which fade by their own decay and falloff on the scene clock.
- Particle systems `id-sparks`, `id-dust` and `id-rubble`, delayed to `start` (the `delay` field of a particle system). The sparks are a `type: "sparks"` system (see `docs/physics.md`) with an unlit white `id-spark-glow` material, thrown from a small ball 0.2 `size` above the ground; their speed and size scale with the square root of `size / 2.5`, and their shutter stays the spark default (half a frame), as in the approved preview. Both options are on by default because Glaze at the early, peak and late frames of that preview matches its mean luminance within 3 percent, while a blast with both off is much dimmer.
- A dark `id-scorch` disc decal that appears at `start`, and a camera eye shake track.
- The motion duration becomes at least `start` plus the playing time of the blast plus 1 s.

It needs a scene with no grid volume yet (a scene draws one), a free local volume, 3 of the 4 particle systems, and a free flash and distortion slot, and fails naming the field otherwise.
Close up, the 32 cubed grid alone is a soft blob (a cell is 0.4 m at size 4), so the volume adds three octaves of noise, 80 noise cells across the box, in the rasterizer only (#2289; `noiseAmount`, `noiseScale` and `noiseOctaves` of the exported volume, which a trace ignores).

Gaps: the grid is 32 cubed, so the detail is coarser than the 64 cubed preview and the smoke holds its last frame after the simulation ends; the dust is an unlit warm-brown haze of about 600 large overlapping round puffs lifted slightly off the floor, each faded toward its silhouette by the material's `softEdge`, so it reads as a low cloud with no outlines; it is not a flat ring; there is no crater.

Timing: `node scripts/measure-explosion-render-time.mjs --runs 3` builds a blast over a floor disc through the MCP runtime, submits an 8 s 1080p video job and prints, per run, the seconds from `scene_create` to the encoded MP4 split into `scene_apply` (the grid bake and the first draw), drawing, frame capture and encoding. Each run starts a fresh server; with the default bake cache (#1876) only the first run on a machine bakes, and `--bake-cache off` forces a cold bake every run (or pass an absolute folder for a clean cache). Run it through `gpu-lock.sh`; it stops a run that passes `--max-seconds` (180).

Reparenting changes hierarchy while preserving each node's local transform.
Commands can add or remove nodes and resources.
Adding a duplicate ID or removing a missing ID fails.
Resource removal can precede rebinding or dependent node removal in the same batch.
The final recipe must contain every resource and parent referenced by surviving nodes.
Mesh nodes require both geometry and material IDs in the final recipe. A node in `scene_create` that names a geometry and leaves out the material gets the material `default` (grey, every field at its default), which is added to `materials` when missing, so the exported recipe names it. `geometries` and `materials` may be left out of a recipe and read as empty; `nodes` is required. A node that names a material without a geometry is rejected: name a geometry or drop the material.

Nonrecursive removal rejects a node that has children at that command's position in the batch.
Child removal or reparenting must precede nonrecursive parent removal.
Recursive removal explicitly removes that node and its entire current subtree.
Node removal leaves geometry and materials intact until explicit resource removal.
Changing a geometry definition or material tag requires removing and adding its resource record.
Direct `set-material` commands still reject tag changes.

The session copies input recipes and commands.
`exportRecipe()` and `camera` return detached JSON snapshots.
Published material objects are frozen and expose immutable arrays through retained getters.
Material reads do not allocate arrays or scan resource collections.

Surviving nodes retain their part and matrix identities when geometry and material bindings retain their resource identities.
Rebinding replaces the part and its matrix.
Removing and adding the same node ID also replaces its part.

Geometry identity survives when its ID and complete definition match an active or checkpoint resource.
Object key order does not affect that comparison.
Omitted parameters and explicit defaults remain distinct definitions.
A changed definition creates new immutable geometry and replaces parts bound to that resource.
Multiple nodes referencing the same resource ID share its geometry.

`parts` returns a frozen current list.
The list retains its identity while its ordered part identities remain unchanged.
Transform, material value, camera, and group-only edits can retain the list.
Removed parts leave the current list and are no longer renderer update targets.
Removed material handles remain readable with their last committed snapshot.

`parts` is a privileged renderer adapter surface.
Its geometry typed arrays follow the engine's immutable geometry contract and must never change or detach.
The session does not duplicate geometry buffers or regenerate unchanged geometry during transactions.
Writes to retained matrices cannot poison the private recipe or inspection transforms.

A successful transaction overwrites those matrices from canonical state.
Detached matrices reject publication before canonical state changes.
An agent adapter must expose JSON commands and snapshots rather than renderer typed arrays.

`topologyRevision` starts at zero and increments only when ordered part identities or membership change.
Restore follows the same rule.
Failed transactions leave both revisions unchanged.
Unused resource or group-only edits do not increment `topologyRevision`.
Renderer adapters can compare it to choose topology replacement or retained instance updates.
The session does not replace renderer GPU resources itself.

`checkpoint()` returns an opaque, frozen handle that belongs to its session.
Checkpoint snapshots are private and cannot change through the handle.
Checkpoints retain recipe snapshots and references to their geometry, material handles, and parts.
Restore reuses those resources without regenerating geometry.
Unchanged active parts take priority when their bindings still match.
Otherwise, restore can recover the checkpoint's original part and matrix identities.

`restore(handle, { expectedRevision })` applies the same atomic validation and increments the revision.
Released and foreign handles fail.
`restoreRecipe(recipe, { expectedRevision })` replaces the whole recipe in one transaction with the same validation, and needs no checkpoint.
Geometry, material handles and parts that both recipes hold stay the same objects, so a recipe one object away costs about as much as that edit.
Studio undo and redo use it for a step no list of operations expresses.
`releaseCheckpoint(handle)` frees its slot and does not change the scene revision.
Released geometry references leave session ownership unless the active scene or another checkpoint still needs them.
There is no separate unbounded geometry history cache.

## Budgets and inspection

The optional second constructor argument overrides the following positive integer limits.
`scene.limits` reports the resolved, frozen values.

| Limit | Default |
| --- | --- |
| `maxNodes` | `4096`, also the hard maximum |
| `maxDepth` | `256`, counting a root as depth one |
| `maxGeometries` | `256` |
| `maxMaterials` | `256` |
| `maxVertices` | `250000`, across unique active, checkpoint, and staged geometry allocations |
| `maxGeometryBytes` | `33554432` |
| `maxOperations` | `256`, per application |
| `maxCheckpoints` | `16` |
| `maxRecipeBytes` | `1048576`, also used for each command batch |

Preflight accounts for peak geometry ownership before generating any new resource.
It counts each unique active or checkpoint allocation once, using actual vertices and typed array bytes.
New resources contribute their conservative vertex and byte bounds.
Its byte bound uses 56 bytes per vertex for eight floats and at most six Uint32 indices.
Actual generated geometry bytes must also fit the budget.

Atomic replacement retains the old active geometry until the candidate commits, so both allocations count during preflight.
A single replacement can fail even when the final geometry fits alone.
Checkpoint sharing does not duplicate geometry bytes.
Unused active resources still count until explicitly removed.
Releasing checkpoints can free ownership for later additions.

Byte counts include position, normal, UV, and index typed arrays across unique owned geometry allocations.
They exclude JavaScript objects, temporary generator allocations, transaction matrices, checkpoint recipes, and renderer GPU memory.
External renderer adapters can retain removed arrays beyond the session's ownership accounting.
The JSON budget uses conservative UTF-8 traversal accounting and also checks serialized JSON size.
Normalization can increase serialized size, so normalized recipes also pass the JSON budget.
Each checkpoint stores at most one normalized recipe within that limit.

`inspect({ ids, limit, includeBounds })` returns JSON with both revisions, global counts, and selected node records.
Its default limit is 64, capped by `maxNodes`.
Requested IDs must exist.

`truncated` reports whether the result omitted selected nodes.
Global counts include nodes, render parts, unique geometries, materials, and unique geometry vertices.
`geometryBytes` reports actual unique typed array bytes.
`estimatedGeometryBytes` reports the conservative preflight bound.

Those fields describe active resources, including unused resources.
`residentGeometryBytes` and `residentGeometryVertices` include unique active and checkpoint allocations.
The scene's own `inspect` does not report GPU timing or renderer allocation; the MCP tool adds them on request, below.

### Cost profile

`scene_inspect` with `profile: true` adds `profile`, what the scene costs to draw as it stands:

```json
{ "profile": { "frames": 30, "millisecondsPerFrame": 4.1, "millisecondsMinimum": 3.8, "millisecondsMaximum": 6.2,
  "drawCalls": 41, "triangles": 182340, "textureBytes": 12582912, "splatBytes": 0, "width": 768, "height": 512,
  "heaviestNodes": [{ "id": "hull", "triangles": 90112, "parts": 1 }] } }
```

- It draws `profileFrames` frames (1 to 120, default 30, the same size as the preview) after one unmeasured frame. `millisecondsPerFrame` is the median; each frame includes the wait for the GPU. Other work on the machine moves it, so read it as a range.
- `drawCalls` and `triangles` are per frame and count every pass the frame draws, shadows and post effects included, the way `bench/runtime` counts them.
- `textureBytes` is the texture memory the renderer holds (material maps, skin and morph data, the sky map and splat layers); `splatBytes` is the splat share of it.
- `heaviestNodes` are the five nodes with the most triangles; parts that share a node add up.
- It needs the GPU preview, takes a GPU slot like `scene_look`, and without `profile` the answer is exactly what it was.

With `includeBounds: true`, each mesh record includes `{ min, max }` from every transformed geometry vertex.
Group bounds are `null`.
Bounds use published canonical world matrices, not externally modified renderer matrices.
They describe the authored mesh surface without shader effects or displacement.

## Design choice

| Design | Benefit | Cost |
| --- | --- | --- |
| Evaluate arbitrary JavaScript scene functions | Full access to existing engine functions | Execution authority, mutable ownership, and replay depend on external isolation |
| Validate JSON recipes and typed commands | Bounded inputs, private ownership, atomic batches, and reproducible snapshots | A deliberately limited geometry and editing vocabulary |

The addon uses validated JSON because ownership and atomic editing form its public contract.
The separate [source MCP adapter](mcp.md) translates tool calls into this API without placing transport logic inside the scene session.
This version does not claim Blender feature parity.

| Geometry ownership design | Benefit | Cost |
| --- | --- | --- |
| Regenerate the full scene after every command | Simple replacement ownership | Repeated geometry allocation and lost renderer identities |
| Retain immutable resource records in active state and bounded checkpoints | Shared geometry, replay, stable parts, and peak allocation preflight | Explicit staging and checkpoint ownership accounting |

The addon retains immutable resource records because topology editing must preserve unaffected geometry and renderer handles.
