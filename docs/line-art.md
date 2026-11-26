# Outlines, toon light and lines

Diagrams, cutaways and toon films need lines and a banded shade. One recipe edit turns them on:

```json
{ "environment": { "lines": { "width": 2 } } }
```

That draws a dark outline at silhouettes, part boundaries, creases and depth jumps. Add `"toon": 3` to `lines` to band the light of every material into three steps, or `"toon": 4` on one material. Remove the field (or set `"lines": null` in `set-environment`) and the scene renders as before.

## Fields of `environment.lines`

| Field | Default | What it does |
| --- | --- | --- |
| `width` | 1.5 | Line width in output pixels, 0.25 to 16. Fractions draw a fainter line. |
| `color` | `[0.02, 0.02, 0.02]` | Linear RGB of the line, 0 to 4. The colour is drawn before tone mapping, so a bright line reads a little darker than written. |
| `boundaries` | `true` | A line where the object ID changes: silhouettes and the edge between two parts. |
| `creaseAngle` | 35 | Degrees. A line where the surface normal turns by more than this between neighbouring pixels. 0 turns creases off. |
| `depthJump` | 0.08 | A line where one surface sits in front of another of the same part. Relative step of the eye depth (measured against the screen-linear perspective interpolation so flat grazing surfaces do not trigger). 0 turns it off. |
| `colorMode` | `"solid"` | `"darken"` inks each line pixel with the colour of the surface under it times `darkenFactor`, so foliage, roofs and stone get their own dark ink. Replaces `color` and the `color` of `nodes`. |
| `darkenFactor` | 0.54 | 0 to 1. The share of the body colour that stays in the ink when `colorMode` is `"darken"`. |
| `silhouetteSide` | `"both"` | `"front"` draws the boundary and depth-step lines on the nearer surface only: 1 px at `width` 2, where `"both"` draws 1 px on each side. A boundary between two parts at the same depth with parallel normals (a road beside a pavement) draws no line. |
| `convexHighlight` | 0 | 0 to 4. Above 0, a crease that turns away from the viewer is drawn lighter (the body colour times 1 + this) instead of dark. Concave creases keep the dark line. It needs `creaseAngle` above 0 and applies to creases only, not to the edge between two parts. |
| `toon` | 0 | Light steps for every material that sets no `toon` of its own, 0 to 8. 0 leaves the smooth light. |
| `polylines` | none | Lines drawn in the world with a screen width, see below. |
| `nodes` | none | Lines on a subset of nodes, see below. |

The width is in pixels of the output, so a 480 pixel preview and a 1920 pixel render carry lines of the same thickness. A scene that wants the same look at every size should scale `width` with the image height itself.

## Toon light

`toon` on a material (also a layer field, 0 to 8, 0 off) steps the cosine of each light that reaches it. The sun, a point light and a spot light each make their own bands, and the edge between two bands is 0.02 of the light range wide. Shadows keep their own softness, and the sky light that fills the dark side is not banded. A material with `toon` set wins over `lines.toon`.

`toonColors` on a material gives each step its own colour: one linear `[red, green, blue]` (0 to 4) per step, darkest first, and as many as `toon`, such as `"toon": 3, "toonColors": [[0.2, 0.5, 0.55], [0.6, 0.8, 0.75], [1, 0.92, 0.95]]`. Each colour replaces the grey level of its step, so the darkest step can be a tint instead of black. The side facing away from a light gets no direct light and shows the ambient light, so raise the ambient intensity to light it. A colour is a weight on the sun light (diffuse, albedo and the display curve still apply), so with a white albedo, `keyIntensity` near 3.6 and `environment.viewTransform` `neutral`, a step shows within a few levels of its sRGB colour; the default `aces` curve adds contrast and shifts the tones, and a weight above 1 is compressed toward white by the curve. Without `toonColors` the render is unchanged.

`toonEdge` on a material (0 to 2, default 0) picks the edge between two steps: 0 the soft edge, 1 a hard step, 2 a hard step after an ordered Bayer 4 by 4 threshold moves each pixel's light by up to half a step either way, so the edge becomes a pattern of pixels. It needs `toon` above 0.

## Lines on some nodes

`nodes` keys are node IDs (a placed asset is one node, however many parts it has). A node it does not name draws as usual.

```json
{ "environment": { "lines": { "nodes": {
  "basket": { "silhouetteOnly": true },
  "rug": { "lines": false },
  "vase": { "color": [0.8, 0.1, 0.1] }
} } } }
```

| Field | Default | What it does |
| --- | --- | --- |
| `lines` | `true` | `false` draws no line at the node: not its silhouette, and no neighbour draws one for it. |
| `silhouetteOnly` | `false` | Only the contour where the node meets another node or the background. No creases, no depth jumps, no lines between its own parts. Use it for dense textured props. |
| `color` | `lines.color` | Linear RGB of the node's lines. A line between two nodes is drawn half by each side, each in its own colour; the background side takes the colour of the node it borders. |

At most 64 nodes. A key must be the ID of a node in `nodes`: an ID that exists nowhere fails when the scene is created and names it (`scene_inspect` lists the IDs). A node that exists but is not drawn in the frame (hidden, or not opaque) is ignored, so a node can be switched off by a motion track without an error. A placed asset, a crowd and a node that grows vegetation are each named by their own ID (`oak`, not its generated parts). A node made by `instances` is a group with no part of its own, so naming it fails and the error lists its children: name those IDs (`trees.0`) as `scene_inspect` shows them. A plain group with no geometry fails the same way.

`set-environment` replaces `lines` whole, `nodes` included: send the full `lines` object again to change one field and keep the map. `"nodes": null` (or leaving it out) clears the per-node settings.

`lines: false` keeps no colour: the stored entry is `{ "lines": false, "silhouetteOnly": false }`. `remove-node` of a node that `lines.nodes` names fails until the same call also drops that entry with `set-environment`.

To composite lines for some nodes over shading for others, read `metrics.objectNodes` of the `objectId` pass (see [render jobs](agent-render-jobs.md)): it maps each node ID to the object IDs it owns.

## Polylines

```json
{ "environment": { "lines": { "polylines": [
  { "points": [[0.2, 1.0, 0.6], [0.2, 1.8, 0.6], [-1.2, 1.8, 0.6]], "color": [0.8, 0.1, 0.1], "width": 3, "depthTest": false },
  { "points": [[-1.0, 0.2, 0.0], [1.0, 0.2, 0.0]], "style": "dashed", "dashLength": 14, "gapLength": 6, "dashOffset": 4, "width": 2.5 },
  { "points": [[-1.0, 0.5, 0.0], [1.0, 0.5, 0.0]], "style": "dotted", "gapLength": 6, "width": 3 },
  { "points": [[-1.0, 0.8, 0.0], [1.0, 0.8, 0.0]], "style": "double", "gapLength": 4, "width": 2 }
] } } }
```

Each polyline has 2 to 256 `points` (`closed: true` joins the last to the first), and its own `color`, `width`, `depthTest` (default `true`: the scene hides what lies behind a surface) and optional `style`. Use `depthTest: false` for leader lines and annotations that stay in front. At most 64 polylines and 4,096 segments per recipe. Ends and joins are round.

| Field | Default | What it does |
| --- | --- | --- |
| `style` | `"solid"` | `"solid"`, `"dashed"`, `"dotted"` or `"double"` (parallel twin rails). |
| `dashLength` | `max(0.5, width * 4)` | Screen pixels per dash for `"dashed"` lines, 0.5 to 256. |
| `gapLength` | `max(0.5, width * 2)` (`width * 1.5` for `"double"`) | Screen-pixel gap between dashes, dots or twin rails, 0.5 to 256. |
| `dashOffset` | `0` | Screen-pixel phase shift along `"dashed"` and `"dotted"` lines, -100000 to 100000. |

Dashes and dots advance continuously around polyline corners in screen pixels.

## Limits

- Outlines and polylines draw only for a frame that carries `lines`. They read the opaque and cutout geometry only (like render passes), so blended and translucent parts get no outline.
- An outline costs up to two extra draws of the opaque geometry (normal and object ID passes, with `objectId` drawn last so `passSupport.texture` stays valid for user passes) plus one full-screen pass. Setting `creaseAngle: 0` with `silhouetteSide: 'both'` skips the normal pass. Frames without lines cost nothing.
- Outlines need `depth: true` on the renderer and `installRenderPasses` first. A render job writes the pass files without lines.
- Creases are found from the picture, not from the mesh: narrow chamfer bevels up to 10 pixels wide collapse to a single centred outline at `creaseAngle` 35 instead of twin edges, while wider smooth multi-segment bevels turn their normal slowly and draw no line unless you lower `creaseAngle` or use a sharper edge.
- Through the MCP server, `scene_create` and `set-environment` take `environment.lines`, and a material takes `toon`. `scene_capabilities` reports both.

## Code

```js
import { CrucibleRenderer } from '@codepawlhq/crucible';
import { installRenderPasses } from '@codepawlhq/crucible/addons/render-passes';
import { installLineArt, resolveLineArt } from '@codepawlhq/crucible/addons/line-art';

const renderer = installLineArt(installRenderPasses(new CrucibleRenderer(canvas, parts, { depth: true, hdr: true })));
renderer.render({ ...camera, lines: resolveLineArt({ width: 2, toon: 3 }) });
```

A recipe host loads the code with `await loadAgentSceneModules(recipe)`. The preview and render jobs install it themselves.

## Compared with Blender (2026-11-04)

`npm run reference:line-art` draws `bench/reference/line-art-scene.json` (unbevelled boxes, a three-step block, a sphere, two touching parts on a slab) with `lines.width` 2, and draws the same scene in Blender 5.2.2 with Freestyle (silhouette, border and crease edges, crease angle 35, 2 px). Blender's Line Art modifier gave 0 strokes in background mode, with or without a camera, so Freestyle is the reference. Each side is drawn with and without lines, and the difference of the two is the line mask.

![Crucible outlines on the left, Blender Freestyle on the right](https://raw.githubusercontent.com/codepawl/crucible/main/bench/reference/images/line-art-crucible-vs-blender-freestyle.webp)

- Silhouettes, creases and the boundary between the two touching parts appear in both. Every Blender line pixel lies within 2 px of a Crucible line (100%).
- The edge masks overlap with an IoU of 0.50 at 960x540. 64% of the Crucible line pixels lie within 2 px of a Blender line. In the side-by-side the lines only Crucible draws are the contact lines where a block stands on the slab or one step sits on the next (Freestyle draws no edge there, probably because the edge lies in the surface below it).
- Width, measured on near-vertical edges as the strength of the line summed across the edge: 1.65 px in Crucible at 960x540 and 1.60 px at 3840x2160 (requested 2), against 1.73 px in Blender at 960x540. The pixel width holds across sizes (ratio 0.97), and both tools draw a requested 2 px a little thinner at the strongest pixel.
