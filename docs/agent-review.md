# Agent visual review

Release `0.9.0` adds `scene_review` for inspecting several views or motion samples in one MCP image.
The tool renders an isolated snapshot. It preserves the source recipe, revision, preview pose and checkpoint handles.

## Compare views

1. Create a scene or import a configured GLB.
2. Inspect its current revision.
3. Call `scene_review` with that revision and one to four shots.
4. Inspect the returned PNG and each shot's metadata.
5. Apply corrections to the source with its unchanged revision.

```json
{
  "sessionId": "<scene UUID>",
  "expectedRevision": 0,
  "width": 384,
  "height": 384,
  "shots": [
    {
      "label": "Front",
      "camera": { "eye": [0, 2, 7], "target": [0, 1.5, 0] }
    },
    {
      "label": "Side",
      "camera": { "eye": [7, 2, 0], "target": [0, 1.5, 0] }
    },
    {
      "label": "Back",
      "camera": { "eye": [0, 2, -7], "target": [0, 1.5, 0] }
    }
  ]
}
```

The response contains one PNG image block, JSON text and structured metadata.
The grid labels identify shots. Each shot reports its sampled camera, label positions and branch. `response_format: "detailed"` also gives the clocks, output dimensions and render resources (graphics, estimated bytes, buffer counts) and the run's memory peaks.
This tool does not require a configured render job directory or write output files.

## Compare motion

Each shot starts independently from the authored base pose.
Omitted sampling does not inherit the previous shot's motion time or imported clip sample.

`motionTime` samples recipe-owned motion. `null` selects the authored base pose.
`animation` supplies an imported clip index and absolute time. Procedural scenes reject imported clip sampling.
Imported clip and authored motion clocks compose through one atomic pose transaction.

```json
{
  "sessionId": "<scene UUID>",
  "expectedRevision": 0,
  "shots": [
    { "label": "Authored base" },
    { "label": "Start", "motionTime": 0 },
    { "label": "Middle", "motionTime": 1.5 },
    { "label": "End", "motionTime": 3 }
  ]
}
```

These samples require authored motion. Nonlooping motion holds its endpoint after the duration. Looping motion wraps the requested time.
`rendererTime` is the clock a post pass or shader that reads `time` sees. When a shot gives none it is the shot's `motionTime` (or its `animation.time`), so the effect moves with the pose like a render job's; with neither it is zero. A user post pass reads the pose's `motionTime` as its clock whenever the shot has one, as in a look and a render job frame, so a pass anchored to a moving part stays on it; `rendererTime` then sets `time` for everything else that reads it. Give `rendererTime` to set that apart from the pose.
A shot camera takes `eye`, `target`, `up`, `fov`, `near`, `far`, `projection` (`perspective` or `orthographic`) and `orthoScale`, and the shot draws it as a look does. Lens fields (`focalLength`, `sensorWidth`) are not accepted here; pass `fov`.
Camera fields override only the private shot camera. They do not author tracks or edit the source camera.

## Compare branches and read labels

A shot can name a branch made by `scene_apply` with `branch`. The branch renders in its own private scene, so one review compares variants without a restore, a revision or a look per variant:

```json
{ "sessionId": "<scene UUID>", "expectedRevision": 3, "labels": true,
  "shots": [{ "branch": "warm" }, { "branch": "cool" }, { "label": "Now" }] }
```

Shots of the same branch share one private scene. Each shot reports `branch` and `branchStale`, true when the scene changed after the fork. Branch shots cannot sample an imported clip.

`labels: true`, on `scene_review` and on `scene_look`, draws the node name, a material tag other than `surface` and the mesh lint problems (in orange) at each visible part's bounds centre. The same list returns as JSON, `labels: [{ id, name, tag, faceTags, problems, x, y }]`, with `x` and `y` in the pixels of that image or shot. At most 24 parts are labelled; hidden parts are left out. Names are cut to printable ASCII. Imported assets get names and tags but no lint.

## Realism checks

Some reasons a render looks fake can be measured. `checks: "realism"` on `scene_review` adds `realism: { passed, checks }` to the result. Every check is listed with `status` (`pass`, `fail` or `warn`), its `fix`, and `findings` (target and message) when it did not pass. `passed` is false only when a check fails. The two material checks also appear as warnings in the diagnostics of `scene_inspect`.

| Check | Status | Threshold | What it reads |
| --- | --- | --- | --- |
| `albedo-out-of-range` | fail | Luminance of the linear base colour (Rec. 709 weights) below 0.013 or above 0.9 | Surface, grass and foliage materials. Not checked: metals (metallic 0.5 or more, whose colour is a reflectance), emitters, transmitting glass, materials with a pattern or map (the colour only tints them), water, liquid, foam and unlit materials, and a material whose name has the word snow. |
| `metallic-on-dielectric` | fail | `metallic` above 0 | A material with the `grass` tag, or one named ground, rock, grass, wood, soil, dirt, mud or bark: by its own id, or by the id or label of a node that uses it. Whole words only, so `background` and `rocket` do not match. A name that also says metal, steel, iron, brass and the like is left alone. |
| `visible-tiling` | warn | Normalised autocorrelation of 0.5 or more at a lag of 8 pixels or more (at 96 pixels across), with a second peak of 0.3 at twice the lag | The picture of each shot, so it follows what the camera sees. It warns and never fails. |

The material checks read the source scene (a branch shot is checked against the source recipe, not its branch) and do not need the picture.

The tiling check cuts each shot to at most 96 by 96 pixels, subtracts a blurred copy so smooth shading does not correlate with itself, and searches the autocorrelation for a repeat. The cost is fixed (about 40 million multiply-adds a shot) whatever the render size. It finds a texture that repeats at a fixed pixel spacing, such as a ground seen from above or a wall seen head on. A repeat foreshortened by perspective has no single spacing, so it is not detected.

Sources of the thresholds (the limits were taken from the issue and checked against these references, not measured by Crucible):

- Epic's "Physically Based Materials" guide for Unreal Engine lists measured base colours: charcoal 0.04, bare soil 0.13, green grass 0.21, fresh snow 0.81. It advises keeping non-metal base colours between sRGB 30 and 240, which is 0.013 to 0.87 linear. The upper limit of 0.9 leaves room above its fresh snow; the lower limit of 0.013 is its sRGB 30.
- The [Physically Based database](https://physicallybased.info/) holds the same kind of measured albedo values, in linear RGB, for real materials; none of its non-metals is black or white.
- Metals are exempt because a metal's base colour is its reflectance at normal incidence, which is bright by design (Epic's guide and the Physically Based database both list metals well above the non-metal range).
- Metallic above 0 on ground, rock, grass or wood: these do not conduct. The same guides treat metallic as 0 or 1 for real materials and keep in-between values for the edge of a blend, such as rust or dirt on metal.
- The tiling test is the autocorrelation of the picture, the standard measure of periodic structure. Its limits were set on synthetic grids of noise, and the tests check that noise, a gradient, a flat picture and a single object do not trip it.

Each limit is a default for plain surfaces, not a ruling: a deliberate black cut-out or a stylised flat look can pass the fix with a note.

## Budgets and ownership

| Limit | Value |
| --- | --- |
| Shots | One to four |
| Requested size per shot | 64 to 480 pixels per axis |
| Default size per shot | 384 by 384 pixels |
| Label | At most 48 characters |
| Response image | At most 1 MiB |
| Review output | One labeled PNG grid |

The renderer can reduce actual dimensions to respect its memory budget. Metadata reports the actual size of each shot.
The runtime captures one frame at a time. It releases the private renderer before restoring the source preview renderer.

Review calls serialize with source edits. Active render jobs retain their exclusive renderer lease.
Invalid shots fail without editing the source. Closing the MCP connection releases the private review resources.

The 30-second deadline covers private page acquisition and rendering after snapshot and asset verification.
Cleanup and source preview recovery follow that deadline. `elapsedSeconds` reports the measured review duration.

The tool provides visual evidence. It does not diagnose every intersection, guarantee a good composition or supply automatic framing of deformed assets.
Mesh inspection bounds describe authored geometry. Skinning and morphs can move the visible surface beyond those bounds.

## Compare values of one parameter

`scene_review` with `wedge` {since 0.23.0} draws one field of the scene at two to eight values in one labeled grid, such as roughness 0.1, 0.3, 0.6 and 0.9, or four sun directions. Pass `wedge` instead of `shots`. Each picture is a scratch copy of the scene with that one value set. The source recipe, revision, branches, checkpoints and preview pose stay as they were, so nothing needs undoing afterwards.

```json
{
  "sessionId": "<scene UUID>",
  "expectedRevision": 0,
  "wedge": { "target": "brass", "parameter": "roughness", "values": [0.1, 0.3, 0.6, 0.9] }
}
```

- `target` is `environment`, `effects`, `shadow` or the ID of a material. Sun and lamps are environment fields: `lightDirection`, `keyIntensity` and `keyColor` for the sun, `pointLights.0.intensity` for the first point light.
- `parameter` is the name `scene_apply` takes for that target, or a path into a list or an object that is already set, such as `pointLights.0.intensity`. The scene must already hold that list or object.
- `values` holds one JSON value per picture, in the shape `scene_apply` takes, each at most 2048 bytes. A value the scene refuses fails the whole call and the message names which one (`wedge.values[2]`).
- `shots` may hold one shot (no `branch` or `animation`) whose `camera` and `motionTime` every picture shares. Without it each picture uses the scene's camera and pose.
- Up to four values draw in two columns, five or six in three and seven or eight in four. `width` and `height` set one picture (at most 960 by 1008 for the grid; the default is 320, or 240 for seven or eight values).
- It supports procedural recipe scenes, not an imported asset scene. The grid is a PNG of at most 1 MiB under the same total deadline as a review.

The metadata lists each shot with its value. To keep the best value, call `scene_apply` with it. `scene_capabilities` topic `wedge` lists the limits.
