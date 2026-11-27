# Profile, contour and path modeling

Available from version `0.4.0`.
The optional modeling entry builds its meshes itself and has no dependency on Three.js.
The core renderer does not import the modeling addon.

```js
import { lathe, extrude, tube } from '@codepawlhq/crucible/addons/modeling';

const vessel = lathe([[0, 0], [0.6, 0], [0.8, 1], [0.6, 2], [0, 2]]);
const panel = extrude([[-2, -2], [2, -2], [2, 2], [-2, 2]], {
  holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]],
  depth: 0.2,
  bevel: 0.03,
});
const cable = tube([[0, 0, 0], [1, 1, 0], [2, 0, 1]], { radius: 0.04 });
```

Each result has Float32 positions, normalized normals and UV channel zero, plus Uint32 triangle indices.
UVs put v = 0 at the top of the image and read the right way round from outside, for `lathe` (profile listed bottom to top), `tube` and the built-in sphere and torus shapes.
Pass it as a part's `geometry` to `CrucibleRenderer`. Inputs are copied. Repeated instances can share the returned mesh.
These generators run when constructing a scene, rather than every frame.

## Lathe

`lathe(profile, { segments = 64, startAngle = 0, sweep = 2π, maxVertices = 250000 })`
revolves radius/height pairs around Y. Radii must be nonnegative, with at least one positive radius.
Angles use radians. Large start angles normalize modulo one turn before evaluation.
Segments range from 3 to 2048. UVs preserve the longitudinal seam.

Profiles with radius-zero ends meet the axis. Partial sweeps and open profile ends remain open.
Folded profiles can intersect themselves. This tool is not a solid Boolean solver.

## Extrude

`extrude(contour, { holes = [], depth = 1, steps = 1, bevel = 0, bevelThickness = bevel, bevelSegments = 3, maxVertices = 250000 })`
extrudes a simple XY polygon along positive Z. Holes must remain strictly inside the contour and cannot overlap, touch or nest.
Both polygon winding directions are accepted. A duplicated closing point is optional.
Bevels extend the caps from `-bevelThickness` to `depth + bevelThickness`.

Steps range from 1 to 256. Bevel segments range from 1 to 32.
Large bevels can intersect on narrow or concave shapes. Inspect the result and reduce bevel size to fit the local clearance.
The base contour validation does not establish that an arbitrary bevel produces a manifold solid.

## Tube

`tube(path, { radius = 0.1, segments = 64, radialSegments = 12, closed = false, maxVertices = 250000 })`
sweeps a circular cross-section along a centripetal Catmull-Rom curve through XYZ points.
Open paths need two points. Closed paths need three. Closed paths join the final sample back to the first.
Open tube ends have no caps. Paths can intersect themselves. A bad radius, `closed` flag, profile, contour or torus arc throws an error that names the field, the value received and an example; in a scene recipe the field starts with `geometries[i]`.

Segments range from 3 to 2048. Radial segments range from 3 to 128.

## Curve

`curve(points, { closed = false, radius = 0.05, taper, profile, resolution = 12, radialSegments = 8, maxVertices })`
sweeps a cross-section along a chain of cubic Bezier spans, the way a Blender curve with a bevel does.

- A point is `[x, y, z]`, which gets smooth automatic handles, or `{ position, handleIn, handleOut }` with handles as
  absolute positions (Blender's convention). A lone handle is mirrored. Open curves need two points, closed ones three, at most 1024.
- `resolution` is samples per span (1 to 64). The rings use the minimum-twist frames of `tube`.
- `taper` is 2 to 64 radius factors, at least 0, spread evenly along the arc length: `[1, 0.2]` thins to a fifth.
- `profile` is 3 to 256 `[x, y]` points of a closed cross-section in units of `radius`, either winding. Without it the
  section is a circle of `radialSegments` sides (3 to 128). Corners sharper than 40 degrees stay flat shaded.
- Open curves get flat caps with their own vertices, so the surface is closed and works with booleans.
- A `radius` of 0 or less, or a `closed` flag that is not true or false, throws an error that names that one field (`radius`, `closed` or `splines[1].closed`), the value received and an example; in a scene recipe the field starts with `geometries[i]`.

Volume, area and bounds match Blender 5.2 for an open and a closed Bezier curve with a round bevel to 2e-5
(`tests/blender-curve-text.test.js`). A Blender bevel resolution of `n` is `radialSegments: 4 + 2n`.

### Splines, shapes and trim

`curveSet(splines, options)` sweeps up to 64 splines (4096 points in all) into one mesh that shares `radius`, `taper`,
`profile`, `resolution` and `radialSegments`. The scene geometry `curve` takes one spline in its own fields or several
in `splines`, never both. A spline is `{ points | shape, closed, kind, weights, order, knots, knotMode, trim }`, and `curve(points, { kind, weights, order, knots, knotMode, trim })` is the one-spline form.

- `kind` is `bezier` (default), `poly` or `nurbs`. A poly spline is straight segments with sharp corners; each ring takes the
  direction of the segment that leaves it, so corners are not mitred. Where points repeat, a ring takes the direction of the
  nearest distinct point (trailing repeats keep the direction they arrived with); a curve whose points all coincide is an error. A NURBS spline is a cubic B-spline by default: open ones are
  clamped (they start and end on the first and last point), closed ones are periodic. `weights` holds one number above 0 per
  point (default 1); a higher weight pulls the curve toward its point.
- NURBS `order` is an integer from 2 to 8 and at most the point count (default 4, cubic; 2 follows the control polygon, 3 with
  weights draws exact conic arcs). An open NURBS takes `knotMode` `clamped` (default) or `uniform` (evenly spaced knots, the
  curve does not reach its end points), or explicit `knots`: point count plus order numbers that never decrease and rise
  between `knots[order - 1]` and `knots[count]`, where the curve is defined; repeated knots lower the smoothness there, but none repeats more than `order` times and
  `knots[count]` stays above `knots[count - 1]`. `knots`
  and `knotMode` exclude each other and do not apply to a closed spline, which is periodic. Samples spread evenly over that
  parameter range, so unevenly spaced knots do not change the sample count. Tests compare the points with the Cox-de Boor
  recursion written out from its definition.
- `shape` replaces `points` with a primitive in the XY plane, and sets `closed` and `kind` itself:
  - `{ type: 'arc', radius = 1, startAngle = 0, sweep = 3.14159, segments = 8 }`: a Bezier arc, exact to about 1e-7 of the radius;
    a sweep of 2 pi closes it. Each segment spans at most half a turn (pi), so a full circle needs `segments` of 2 or more. Angles are radians; circle segments are arcs.
  - `{ type: 'spiral', rotations = 2, startRadius = 1, endRadius = 1, height = 2, pointsPerRotation = 12, reverse }`: a helix
    along +Z, smooth through its points (a spiral staircase rail is `height` over `rotations`).
  - `{ type: 'star', points = 5, innerRadius = 0.5, outerRadius = 1, innerTwist = 0 }`: a closed poly spline of `2 * points` vertices.
- `trim: { start = 0, end = 1, length = false }` keeps the arc-length range from `start` to `end` as factors of the length, or
  as lengths when `length` is true (lengths past the end are clamped to it). `end` must be greater than `start`. A trimmed
  curve is open and gets caps, also when it was closed. Trimming a range that covers an open curve changes nothing. Trim is
  computed from the same samples every time, so raising `end` frame by frame grows the curve along the same path: that is how a
  vine grows in code.
- `grow: { name, steps = 8, value = 1 }` on a recipe curve makes that growth a motion track. The geometry is the bare root and
  each of `steps` (2 to 16) morph targets holds the curve grown that far, resampled to the same rings, so a morph track
  `{ kind: "morph", id: <name>, property: "weight", keyframes }` with values 0 to 1 grows the vine, and seeking equals playing.
  The growth runs over the spline's own trim range (a trim in factors). `value` is the growth with no track. More steps follow
  a curved path more closely; between steps the tube blends the two neighbours.

### Mesh edges to curve

`meshEdgesToSplines(mesh, selection)` from `src/mesh.js` turns selected edges of a `MeshData` into poly splines that
`curveSet` sweeps: `[{ kind: 'poly', closed, points }]`. The selection is one of
- an edge rule of `selectEdges`, such as `{ open: true }` (boundary edges of a hole or rim), `{ angle: 45 }` or `{ along: [0, 1, 0] }`;
- `{ group, minWeight = 0.5 }`: edges whose two vertices both weigh at least `minWeight` in the vertex group;
- `{ edges: [edge indices] }`.

A loop where every vertex has two selected edges becomes a closed spline, starting at its lowest vertex and leaving toward its
lower neighbour. A chain becomes an open spline from its end or from a junction vertex (three or more edges), so a branching
selection is several splines that meet there. The order is by first vertex and does not depend on the selection order. At most
64 splines, 1024 points in one and 4096 in all; a selection past that fails and says to pick fewer edges. It is a library
call; a recipe curve takes the resulting splines in `splines`.

Not covered: trim ranges that wrap around the start of a closed curve, a spline fill, and reading the edges of a scene part
through MCP.

## Text

`text(content, { size = 1, depth = 0.2, font = 'default', align = 'left', curveSegments = 4, maxVertices })`
extrudes glyph outlines. The text lies in the XY plane with its first baseline on `y = 0`, reads along +X, faces +Z and is centred
through its depth. `"\n"` starts a new line 1.2 em lower. `size` is the em height. At most 256 characters and 16 lines.

- The bundled font is DejaVu Sans, printable ASCII only: 94 glyphs, 20 KB of data, about 7 KB gzipped. It loads on demand
  with the text code and is never in the core, model or mesh entries. A character outside it (an accent, a tab, an emoji) throws a `RangeError` that names the character and the font.
- `registerFont(name, table)` (or `await registerAgentSceneFont(name, table)` from the agent scene entry) adds a font table:
  `{ unitsPerEm, ascender, descender, glyphs: { "A": [advance, contour...] } }` where a contour is `x, y, onCurve` repeated, in TrueType
  quadratic points. `scripts/build-font.py` makes a table from a TrueType file with fontTools. A glyph is limited to 128 points, a font
  to 2048 glyphs and 400000 points. The MCP never takes a font file or URL.
- `curveSegments` straight pieces per outline curve (1 to 16). Rings inside an odd number of others become holes.
- One glyph and a word match Blender 5.2 with the same font in volume, area and bounds to 2e-5. Blender's text size unit is not the em,
  so the golden script calibrates it on the capital I. There is no kerning, bevel or text on a curve.

## Cloud

`cloudGeometry({ seed, puffs, width, height, flatBase, resolution })` builds a cumulus as one closed mesh: a wide base of big lobes with smaller puffs on a dome above it, joined by a smooth union and meshed by surface nets. The same record gives the same bytes. Shade it with `toon` (for example `"toon": 3`) and the lobes read as clean bands.

| Field | Default | Range | Meaning |
| --- | --- | --- | --- |
| `seed` | 1 | whole, 0 to 2147483647 | Another seed makes another cloud. |
| `puffs` | 14 | whole, 2 to 48 | Lobes in the cluster. |
| `width` | 10 | 0.5 to 2000 | Widest side in metres, centred on x and z. |
| `height` | 5 | 0.25 to 2000 | Top to base in metres, measured before the base is cut. |
| `flatBase` | 0.6 | 0 to 1 | 0 keeps a round underside; 1 cuts it flat the furthest. The base always sits on y = 0. |
| `resolution` | 48 (128 with `levels`) | whole, 16 to 96 (16 to 160 with `levels`) | Cells along the longest side; it sets the triangle count. |
| `levels` | none | 1 to 4 of `{count, sizeRatio, softness}`, 1000 lobes in all | Grows a tower: the first level is the dome layout (`count` 1 to 48 lobes), and each later level puts its lobes on the surface of the level before. `sizeRatio` (0.02 to 2) is the lobe size as a share of the first level's. `puffs` is not used with levels. |
| `upBias` | 0.5 | 0 to 1, with `levels` | 0 grows lobes in every direction; 1 never grows them downward. |
| `unionSoftness` | 0.14 (0.3 with `levels`) | 0.02 to 1 | The blend between lobes as a share of lobe radius; with levels each level blends by its own radius. Lower is tighter. |

A scene geometry takes the same fields with `"type": "cloud"` (see `scene_capabilities` `cloud`). A bad value throws an error that names the field and the accepted range. Lobes are stretched with the box, so a tall or flat cloud has taller or flatter puffs.

With `levels` such as `[{"count": 7, "sizeRatio": 1}, {"count": 60, "sizeRatio": 0.35}, {"count": 680, "sizeRatio": 0.12}]` the cloud becomes a tower covered in rounded lobes. Normals come from the gradient of the blended field at each vertex, not from the mesh faces, so toon steps follow the lobes without fine rings. Later levels find their neighbours in a grid, so 680 bumps cost little per sample; three such towers at `resolution` 128 take about 2.3 s together. A mesh over 150000 faces is refused with the resolution to pass instead.

A level may set its own `softness` (0.02 to 1, a share of its lobe radius). Without it the level takes the cloud's `unionSoftness`, so a recipe that leaves it out builds the same bytes as before. A small `softness` such as 0.1 on the last level keeps its bumps crisp while the big lobes under it stay soft at 0.5.

Three wide cumulus over a sea, each with a flat base and three levels of lobes, soft on the big ones and a little crisper on the small ones (a `softness` per level), shaded with six toon steps (`toonColors`, darkest to lightest) from blue-grey in the shade to warm white in the sun plus a sun-side silver lining (`toonRim`) and lifted sea-bounce underside (`toonBase`), are in [`recipes/cumulus-towers.json`](https://crucible.codepawl.com/recipes/cumulus-towers.json). A still of it, rendered by Crucible:

![Three cumulus towers over the sea](https://crucible.codepawl.com/recipes/cumulus-towers.webp)

The scene needs a lowered ambient light (`ambientIntensity` 0.3) so the shaded side keeps the dark tone instead of the sky's blue, and a sun in front of the camera so the lit tones face it.

For a sky with many clouds, keep `resolution` at 48 or lower and repeat a few cloud shapes with a node's `instances` (see [agent-scene.md](agent-scene.md)) instead of building one mesh per cloud. Triangles grow with the square of `resolution`.

## Resource and precision limits

Each generator accepts at most 4096 input points. Extrusion applies that limit across its contour and holes.
Vertex estimates are checked before geometry allocation. `maxVertices` can range from 3 to 1000000.
This bounds geometry size, not total browser memory.

Account for maps, instance counts and render targets separately.
Polygon intersection validation uses quadratic edge comparisons, bounded by the input limit.
Nonfinite output, invalid normals and entirely collapsed Float32 meshes throw.
The mesh library calls check the same limits as the recipe layer and throw an error that names the parameter, the value and the range: `bevelEdges` segments 1 to 16, `loopCut` cuts 1 to 16, `subdivideMesh` levels 1 to 4, a finite `width` and `distance`, `profile` and `factor` from 0 to 1, `sharpness` from 0 to 10, a `bisectPlane` `point` and nonzero `normal`, `resampleCurve` and `resampleSamples` counts of at least 2 (closed curves: 1), and a `filletCurve` radius above 0 (a corner whose neighbour sits on it is kept sharp).
Center small geometry near the origin and place it with part transforms when working at large world coordinates.

## API choice

Plain point arrays keep profiles serializable and keep any other library's classes out of the API.
Accepting custom curve objects would let callers supply their own curve classes, but weakens input bounds.
Lathe, bevel construction and curve frames follow the formulas Three.js used before, so those outputs are unchanged. Extrusion caps use an ear-clipping triangulation of the addon's own, so a cap can be split along different diagonals than before, with the same area, volume and bounds.

Mesh edits select and shape points and faces with JSON field expressions, never code; see [field expressions](mesh.md#field-expressions).

