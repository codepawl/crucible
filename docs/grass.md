# Grass

`crucible/addons/grass` builds a field of real grass blades that follows the terrain and sways in the wind.
It is in the current source and not yet published.

```js
import { CrucibleRenderer } from 'crucible';
import { createGrass } from 'crucible/addons/grass';
import { createTerrain } from 'crucible/addons/terrain';

const terrain = createTerrain({ size: 300, seed: 4 });
const path = (x, z) => (Math.abs(x - 6 * Math.sin(z * 0.08)) < 1.1 ? 0 : 1);
const grass = createGrass({
  preset: 'meadow',
  area: { minX: -40, maxX: 40, minZ: -70, maxZ: 30 },
  terrainHeight: terrain.heightAt,
  mask: path,
  eye,
  seed: 3,
});

const renderer = new CrucibleRenderer(canvas, [...terrain.parts, ...grass.parts], { world: true, hdr: true, ground: false, memoryBudgetMiB: 1536 });
renderer.render({ eye, target, time: seconds, wind: 0.45 });

// When the camera moves:
if (grass.update(eye)) renderer.replaceParts([...terrain.parts, ...grass.parts]);
```

## How the blades are made

The technique follows the grass of Ghost of Tsushima (GDC 2021) and the open ports of it, [GodotGrass](https://github.com/2Retr0/GodotGrass) and [Quick_Grass](https://github.com/simondevyoutube/Quick_Grass).

- Each blade is a tapered strip on a quadratic curve. It rises straight from the root and bends over toward its lean at the tip.
- Blades group into clumps from cellular noise. A clump shares a height, a facing, a bend and a shade, and its blades lean away from the clump centre.
- Normals are rounded: the two edges of a blade tilt outward and lean toward the sky, so a flat strip shades like a curved leaf.
- Vertex colours run from a dark, occluded root to a light tip. Each blade drifts slightly toward yellow or blue-green, and low-frequency noise adds dry patches.
- Field patches (`patchiness`) break up the even carpet: two octaves of noise at about 8 m and 25 m make some patches short and thin and others tall, dense and darker.
- A small share of blades are seed stalks (`stalks`): a thin stem with a straw head that rises above the sward. About 6 % of blades fold over at the middle, as trampled grass does.
- The `grass` tag sways each vertex by how far up the blade it is (`uv.y` is 1 at the root) and moves the tip a share of the blade length (`uv.x` carries the length in millimetres, 2 per millimetre, on top of the side coordinate), so one wind leans a 0.12 m lawn and a 0.6 m meadow to the same angle. Gusts travel across the field as a wave along the wind direction, with a faster flutter on top. The shadow pass uses the same function.
- Sunlight shines through the blades: when the camera looks toward the light, blades glow yellow-green, most at their thin tips.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `area` | required | `{ minX, maxX, minZ, maxZ }` in metres. |
| `preset` | `'meadow'` | `meadow`, `lawn`, `savanna` or `wild`. Every other option overrides the preset. |
| `terrainHeight` | `() => 0` | Ground height at `(x, z)`. Pass `terrain.heightAt`. |
| `mask` | none | Coverage at `(x, z)` from 0 to 1. Zero clears paths and clearings, and partial values thin the grass and shorten it. |
| `density` | from preset | Blades per square metre at full detail. |
| `height`, `bend` | from preset | `[minimum, maximum]` blade height in metres and tip bend from 0 to 1. |
| `width` | from preset | Blade width at the root in metres. |
| `clumpSize`, `clumpStrength` | from preset | Clump cell size in metres, and how strongly blades follow their clump (0 to 1). |
| `dryness` | from preset | Share of dry patches and dry blades (0 to 1). |
| `patchiness` | from preset | Field-scale variation of height, density and shade (0 to 1). Zero gives an even field. |
| `stalks` | from preset | Share of seed stalks (0 to 1). `lawn` has none. |
| `base`, `tip`, `dry` | from preset | Linear RGB colours for the root, the green tip and the dry tip. |
| `tileSize` | `4` | Tile edge in metres, finite. Each tile is one part and one draw. An area needing over 262144 tiles throws. |
| `levels` | `GRASS_LEVELS` | Distance, kept share, segments and width scale per level of detail. |
| `cullDistance` | last level's distance | Tiles farther than this are dropped. |
| `castShadow` | `false` | Blade shadows cost a full extra pass of every blade. Blades still receive shadows. |
| `eye`, `seed` | area centre, `1` | Initial camera position and random seed. |

`createGrass` returns `{ parts, update(eye), material, stats(), groundColor, settings }`.

- `parts` lists the visible tiles. Each part is rigid and untextured, so `renderer.replaceParts` streams tiles in and out.
- `update(eye)` returns `true` when a tile changed level or was culled. Rebuild the part list only then.
- `stats()` returns tile counts per level, triangles, vertices and an estimate of geometry bytes.
- `groundColor` is a linear colour between the root and tip colours. Tint the ground under the grass with it, so gaps read as shaded grass and not bare soil. On a splat terrain, darken every layer the grass covers, not only the grass layer: soil under a sward sits in the blades' shade, and a bright floor between blades is what makes a field look fake.

## Level of detail

| Level | Distance | Blades kept | Segments | Width |
| --- | --- | --- | --- | --- |
| 0 | up to 10 m | all | 4 | 1× |
| 1 | 10 to 26 m | 35 % | 2 | 2× |
| 2 | 26 to 60 m | 12 % | 1 (a triangle) | 4.5× |

A coarser level keeps a fixed subset of the same blades, so a tile that changes level does not reshuffle.
The coarse blades are wider, so the field keeps about the same coverage.
A tile moves to a coarser level only when it is 10 % past the boundary, so tiles on an edge do not flicker.

## Measured

On the demo meadow (80 × 100 m, eye 1.3 m above the ground, RTX 3060, headless Chrome):

| View | Visible tiles | Triangles | Geometry | Build |
| --- | --- | --- | --- | --- |
| Eye height 1.3 m | 344 | 1.21 M | about 94 MB | 3.0 s |
| Eye height 7 m | 316 | 0.74 M | about 61 MB | 2.1 s |

Thin patches drop blades, so the default meadow builds about 12 % faster than the same field with `patchiness: 0` (measured in Node).

Set `memoryBudgetMiB` high enough for the grass geometry. Lower `density` or `cullDistance` for phones.

## Recipes and MCP

A group node with a `grass` field grows the same blades in a recipe, over a terrain node, with no baked GLB and none of the asset caps. Give the group node the same transform as the ground.

```json
{ "id": "meadow", "grass": { "ground": "hills", "preset": "meadow", "density": 180, "seed": 4, "polygon": [[-12, -10], [14, -8], [3, 15]], "exclude": [{ "node": "pond", "radius": 3 }] } }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `ground` | required | The ID of a node that draws a terrain geometry. Blades stand on its height; its holes stay clear. |
| `preset` | `meadow` | `meadow`, `lawn`, `savanna` or `wild`. |
| `density` | the preset's | Blades per square metre near the camera, 1 to 1500. |
| `height` | the preset's | `[minimum, maximum]` blade height in metres, 0.02 to 3. |
| `dryness` | the preset's | 0 to 1. |
| `seed` | `1` | The same seed gives the same blades. |
| `area`, `polygon` | the whole ground | A `{ "min": [x, z], "max": [x, z] }` box and/or 3 to 64 `[x, z]` points; the field stays inside both and inside the ground. |
| `exclude` | none | Up to 32 circles, boxes or `{ "node", "radius" }` that stay clear. |
| `cullDistance` | `60` | Metres from the recipe camera `eye` inside which tiles are built, 5 to 200. |

- The recipe calls `createGrass` with the terrain's own `heightAt`, so the addon gives the same blades for the same options.
- Tiles and their level of detail come from the recipe camera `eye` when the scene is built or edited, never from the frame being drawn, so a seek or a camera track cannot change them. Move the camera with `set-camera` to grow the field for another viewpoint; each new eye builds the visible tiles again.
- The blades keep the `grass` material tag and sway with `environment.wind`.
- The parts become generated child nodes (`<node>/tile-<column>-<row>`), left out of `scene_inspect` nodes and `scene_export_recipe`. `scene_inspect` adds `grass`: per field the blades, tiles and triangles, in total and for each level of detail.
- Limits: an area of at most 40000 square metres, at most 500000 blades and 1500000 triangles planned inside `cullDistance`, and `maxNodes` for the generated tiles. Each one throws an error that names the field to lower.
- A node holds `grass` or `geometry`, `vegetation`, `clutter` and `asset`, never two of them. The vegetation scatter mix `grass` stays what it was: card clumps, at most 1000 instances.

## Limits

- Blades are flat strips. Seen exactly edge-on they thin out. The Ghost of Tsushima view-space thickening is not implemented.
- Tiles change level with a pop, not a cross-fade.
- Wind has one fixed direction. There is no interaction with characters or vehicles.
- The build runs on the main thread. A field of this size takes 2 to 3 seconds.
