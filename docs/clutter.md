# Ground clutter

`@codepawlhq/crucible/addons/clutter` scatters pebbles, rocks, twigs and fallen leaves over terrain. It is published with the package (0.22.0 and later). Scenes built from a recipe reach it through a node's `clutter` field, see [Recipes and MCP](#recipes-and-mcp).

```js
import { createClutter } from '@codepawlhq/crucible/addons/clutter';

const clutter = createClutter({
  preset: 'forest',
  area: { minX: -40, maxX: 40, minZ: -70, maxZ: 30 },
  terrainHeight: terrain.heightAt,
  eye,
  seed: 5,
});

const renderer = new CrucibleRenderer(canvas, [...terrain.parts, ...grass.parts, ...clutter.parts], { world: true, ground: false });

// When the camera moves:
if (clutter.update(eye)) renderer.replaceParts([...terrain.parts, ...grass.parts, ...clutter.parts]);
```

## How it is made

- A stone is a sphere displaced by smooth noise. Rocks are also cut by four random planes, which gives them flat, chipped faces. Pebbles stay round.
- A stone sinks a third to a half of its height into the ground and tilts with the terrain.
- Vertex colours give each stone its own tone and hue, from blue-grey to rust. Blotches follow the stone's own space. The underside is darker and soil clings near the ground line.
- Rocks carry the renderer's [moss layer](/material-maps.md): rough, sheened cushions on their tops, shaded as moss rather than painted on. Pebbles stay bare.
- Twigs are tapered tubes that lie on the ground and follow it. Leaves are small cupped strips in a palette of dry browns.
- Items gather into patches of about 7 m (`clumping`), so the ground does not read as an even sprinkle.
- Everything is vertex-coloured and untextured. Each tile has at most three parts, rocks, pebbles and litter, and all stream through `renderer.replaceParts`.

Clutter shows best on paths, clearings, riverbanks and forest floor. Under a dense meadow most of it hides in the grass. To fill a path, pass the inverse of the grass mask as the clutter `mask`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `area` | required | `{ minX, maxX, minZ, maxZ }` in metres. |
| `preset` | `'meadow'` | `meadow`, `forest`, `riverbed` or `scree`. Every other option overrides the preset. |
| `terrainHeight` | `() => 0` | Ground height at `(x, z)`. Pass `terrain.heightAt`. |
| `mask` | none | Coverage at `(x, z)` from 0 to 1. |
| `pebbles`, `rocks`, `twigs`, `leaves` | from preset | Items per square metre. |
| `pebbleSize`, `rockSize` | `[0.012, 0.05]`, `[0.08, 0.38]` | Radius range in metres. Most stones fall near the small end. |
| `moss` | from preset | Moss cover on rocks, 0 to 1. It sets the rock material's `moss`. |
| `clumping` | `0.6` | How strongly items gather into patches, 0 to 1. |
| `stoneColor`, `mossColor`, `soilColor`, `twigColor` | earth tones | Linear RGB. |
| `leafColors` | four dry browns | A list of linear RGB colours. Each leaf picks one. |
| `castShadow` | `true` | Stones cast shadows. Twigs and leaves never do. |
| `tileSize`, `levels`, `cullDistance` | `4`, `CLUTTER_LEVELS`, last level | Tiling and level of detail; `tileSize` must be finite. An area needing over 262144 tiles throws. |
| `eye`, `seed` | area centre, `1` | Initial camera position and random seed. |

`createClutter` returns `{ parts, update(eye), stats(), materials, settings }`; `stats()` gives `tiles`, `visibleTiles`, `levelCounts`, `triangles`, `vertices`, `geometryBytes` and the `items` drawn.

## Recipes and MCP

A group node with a `clutter` field scatters the same stones in a recipe, over a terrain node or a flat area. The field is a list of one to four layers; give the group node the same transform as the ground.

```json
{ "id": "floor", "clutter": [
  { "preset": "forest", "terrain": "hills", "seed": 4, "exclude": [{ "node": "cabin", "radius": 3 }] },
  { "preset": "riverbed", "terrain": "hills", "mask": [{ "center": [0, 10], "radius": 4, "feather": 3 }], "slopeLimit": 25 }
] }
```

| Field | Default | Meaning |
| --- | --- | --- |
| `preset` | `meadow` | `meadow`, `forest`, `riverbed` or `scree`. |
| `terrain`, `area` | one is required | The ID of a node that draws a terrain geometry, or a `{ "min": [x, z], "max": [x, z] }` area in the group frame. With `terrain` alone the area is the whole ground; with `area` alone the ground is flat at height 0. |
| `density` | `1` | A multiplier of the preset's items per square metre, 0.01 to 4. |
| `seed` | `1` | The same seed gives the same stones. |
| `slopeLimit` | `40` | Degrees; steeper ground stays clear. Terrain holes always stay clear. |
| `mask` | everywhere | Up to 8 circles or boxes where clutter may stand, each with an optional `feather` in metres that fades the coverage outside its edge. |
| `exclude` | none | Up to 32 circles, boxes or `{ "node", "radius" }` that stay clear. |
| `cullDistance` | `40` | Metres from the recipe camera `eye` inside which tiles are built, 5 to 100. |

- The recipe calls `createClutter` with the terrain's own `heightAt`, so the addon gives the same stones for the same options. Item counts per metre are the preset's multiplied by `density`.
- Tiles come from the recipe camera `eye` when the scene is built or edited, never from the frame being drawn, so a seek or a camera track cannot change them. Move the camera with `set-camera` to scatter for another viewpoint.
- The parts become generated child nodes (`<node>/<layer>/<rocks|pebbles|litter>-<column>-<row>`), left out of `scene_inspect` nodes and `scene_export_recipe`. `scene_inspect` adds `clutter`: per layer the items drawn, the tiles, the tiles at each level, and the triangles.
- Limits: four layers in the whole recipe, an area of at most 40000 square metres, at most 120000 planned items inside `cullDistance`, and `maxNodes` for the generated parts. Each one throws an error that names the field to lower.
- Clutter parts are left out of the draw-time ranking of flush faces (#751): irregular stones have none, and ranking them took seconds per edit.

## Level of detail

| Level | Distance | Kept | Stone mesh |
| --- | --- | --- | --- |
| 0 | up to 12 m | everything | rocks 12 × 7, pebbles 6 × 4 |
| 1 | 12 to 30 m | 20 % | rocks 6 × 4, pebbles an octahedron |
| 2 | 30 to 70 m | rocks only | rocks 6 × 4 |

Grass and clutter share the tile system in `src/tile-field.js`, with the same 10 % hysteresis.

## Measured

On an 80 × 100 m area, eye 1.3 m above the ground, built in Node:

| Preset | Triangles | Geometry | Build |
| --- | --- | --- | --- |
| `meadow` | 28 k | about 1 MB | about 0.1 s |
| `forest` | 84 k | about 4.5 MB | about 0.3 s |
| `riverbed` | 445 k | about 16.5 MB | about 1 s |
| `scree` | 604 k | about 22 MB | about 1 s |

`riverbed` and `scree` are dense by design. Lower `pebbles` or `cullDistance` for phones.

## Settling stones into a pile

Clutter tiles are meshes, so they stay where they were scattered. To drop stones and let them lie against a wall or each other, use the settle step ([Settling props](physics.md#settling-props)): list the stone poses as `instances`, or let it scatter boxes and balls over an area. It returns resting transforms to draw as static parts.

## Limits

- Stones are untextured. Up close they read as smooth, mottled stones, not as scanned rock.
- Clutter does not collide with grass blades or with each other, so two stones can overlap.
- Leaves lie flat and do not move in the wind.
