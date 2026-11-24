# Agent lighting and look

This feature is included in npm release `0.5.0` and later.

Agent scene recipes can contain `environment`, `effects`, and `shadow` objects.
These fields belong to canonical recipes and checkpoint snapshots.
Look commands use the same atomic revision checks as node and material commands.
Failed look validation preserves the previous recipe and revision.

The optional helper `normalizeAgentLook({ environment, effects, shadow })` returns detached, fully normalized JSON.
It fills omitted fields without mutating the input.
`resolveAgentShadow(shadow, lightDirection)` returns detached renderer bounds with `eye`, `target`, `up`, `extent`, `near`, and `far`.
`shadow.hard: true` (default off) gives the sun shadow one-texel edges: one depth compare per pixel instead of the 3 by 3 filter, and the shadow view snaps to whole texels in light space so edges do not crawl on a pan. Its bias is smaller (2 texels instead of 3.5). It replaces the automatic cascades for that scene; an explicit `environment.shadowCascades` above 0 or `sunAngularRadius` with it is an error, since cascades have their own filter. The recipe loads the code with `await loadAgentSceneModules(recipe)`.
The helpers do not create geometry, render targets, or GPU resources.

```js
import { normalizeAgentLook, resolveAgentShadow } from 'crucible/addons/agent-scene';

const look = normalizeAgentLook({
  environment: {
    world: true,
    lightDirection: [-0.6, 1, 0.2],
    keyIntensity: 0.8,
    pointLights: [{ position: [0, 2, 1], color: [1, 0.6, 0.3], intensity: 12 }],
    volumeFog: { density: 0.02, minimum: [-4, 0, -4], maximum: [4, 4, 4] },
  },
  effects: { exposure: 1.2, bloom: { strength: 0.25 } },
  shadow: { target: [0, 1, 0], extent: 5, distance: 10, far: 24 },
});

const shadowBounds = resolveAgentShadow(look.shadow, look.environment.lightDirection);
```

The renderer uses `effects.exposure` as `frame.exposure`.
The remaining effect controls belong to `frame.effects`.
The environment's `world` flag selects the renderer's world presentation.
Look normalization always supplies the authored key color, including in world mode.

The MCP adapter applies the canonical look on every draw. A custom browser adapter must pass it explicitly:

```js
const renderer = new CrucibleRenderer(canvas, scene.parts, {
  ground: false, hdr: true, depth: true,
  world: scene.environment.world,
  environment: scene.environment,
  shadowBounds: resolveAgentShadow(scene.shadow, scene.environment.lightDirection),
});

function draw() {
  renderer.world = scene.environment.world;
  renderer.shadowBounds = resolveAgentShadow(scene.shadow, scene.environment.lightDirection);
  renderer.shadowsDirty = true;
  renderer.resize();
  renderer.updateParts(scene.parts);
  renderer.render({
    ...scene.camera, environment: scene.environment, effects: scene.effects,
    exposure: scene.effects.exposure, time: 0,
  });
}
```

For a frame loop, update shadow bounds and mark shadows dirty only when projector controls or geometry change.
Use `replaceParts` when `topologyRevision` changes, as described in the scene guide.

## Catalog HDRIs and looks

A recipe names a file; it never carries a path or a URL, and nothing is downloaded. Two kinds of entries exist:

| Entry | Field | Source |
| --- | --- | --- |
| `sky-clouds` | `environment.hdri` | Poly Haven `kloofendal_48d_partly_cloudy_puresky`, CC0, shrunk to 128 x 64 |
| `studio-softbox` | `environment.hdri` | Poly Haven `studio_small_03`, CC0, shrunk to 128 x 64 |
| `teal-orange`, `noir` | `environment.look` | made for Crucible, CC0, 9 points per side |
| 64-character ID | either | a `.hdr` or `.cube` file (an `.hdr` up to 8 MiB, which fits the 2k files from Poly Haven, and a `.cube` up to 4 MiB; a larger file is skipped and listed with a reason, it does not fail the catalog) in the MCP `--assets` directory, listed by `scene_asset_catalog` as kind `environment` or `look` |

The four shipped files total about 100 KB. For a bigger HDRI, put a 2k or smaller `.hdr` (for example from Poly Haven; the 2k files are about 5 to 7 MiB) in the assets directory and use its ID. Outside MCP, decode with `parseRadianceHdr` (an ArrayBuffer or Uint8Array of the whole file; a header that claims more pixels than the file holds is refused) or `parseCube` and register with `registerCatalogEnvironment(name, data)` or `registerCatalogLook(name, look)` from `src/look-catalog.js` before building the scene. The look needs the `view-transform-shader` module (`loadAgentSceneModules` loads it). Render jobs light the scene with the same entries.

## Atomic look commands

| Operation | Payload |
| --- | --- |
| `set-environment` | `{ environment: partialEnvironment }` |
| `set-effects` | `{ effects: partialEffects }` |
| `set-shadow` | `{ shadow: partialShadow }` |

Each operation also contains its `type` discriminator.
Omitted fields retain their current canonical values.
Nested `volumeFog`, `bloom`, `depthOfField` and `motionBlur` objects merge their supplied fields: `{ depthOfField: { blur: 0.8 } }` keeps `focusDistance`.
`null` clears an optional field back to not set (`ground`, `hdri`, `sunBounce`, `wetness`, `puddles`, `shadowCascades`, `sky` and the other fields a fresh environment leaves out, `motionBlur.objects`, optional post steps), and clearing a field that is not set changes nothing.
`null` on `depthOfField`, `motionBlur` or `bloom` returns the whole group to its defaults.
A field every scene has (`keyIntensity`, `exposure`, `depthOfField.blur`, ...) cannot be cleared: `null` on it fails with the default to pass instead. `fogDensity: null` is a value, no override.
Vector arrays replace their previous vector.
The complete `pointLights` list replaces the previous list, including `[]` to remove all point lights.
Final merged look fields pass normalization before any command publishes.

```js
const checkpoint = scene.checkpoint();
scene.apply([
  { type: 'set-environment', environment: { keyIntensity: 0.4, volumeFog: { density: 0.03 } } },
  { type: 'set-effects', effects: { exposure: 1.4, bloom: { threshold: 1.5 } } },
  { type: 'set-shadow', shadow: { extent: 7 } },
], { expectedRevision: scene.revision });

scene.apply([
  { type: 'set-environment', environment: { pointLights: [] } },
], { expectedRevision: scene.revision });

scene.restore(checkpoint, { expectedRevision: scene.revision });
scene.releaseCheckpoint(checkpoint);
```

The helper normalizes a complete candidate rather than merging patches itself.
Session and transport adapters own patch merging and renderer updates.
Checkpoint restore recovers canonical lighting, effects, and shadow controls with the rest of the scene.

## Environment

All numeric values must be finite and representable as Float32.
RGB arrays contain exactly three numbers.
Key light, point light, and fog colors use linear RGB.
Sky colors use display RGB, matching the renderer's existing environment contract.

| Field | Default | Range or meaning |
| --- | --- | --- |
| `world` | `false` | Boolean world presentation flag. With `true` the setup environment is also the background, unless you set `skyTop` or `skyBottom` to other than the setup's colours: then those two colours are drawn as the background gradient and the setup still lights the scene (a `sky` or `hdri` always draws its own background) |
| `hdri` | absent | A shipped HDRI (`sky-clouds`, `studio-softbox`) or the 64-character ID of a `.hdr` file in `scene_asset_catalog`. It lights, reflects and (with `world: true`) forms the background instead of the setup sky; `environmentIntensity` is its strength and `environmentRotation` turns it about the vertical axis. The setup still gives the key light, so set `keyIntensity: 0` when the HDRI has its own sun. `null` clears. See [Catalog HDRIs and looks](#catalog-hdris-and-looks) |
| `keyFromHdri` | absent | Absent unless set. `true`, together with `hdri`, finds the sun in the HDRI and gives the key light its direction (turned by `environmentRotation`), colour and strength, then takes the sun out of the map so it does not light twice; the background still shows the sun disc. It replaces `lightDirection`, `keyColor` and `keyIntensity` when the scene is built, and the recipe keeps the values you wrote. The fill and baked light (`bake`) are not changed. An HDRI with no distinct sun, as on an overcast sky, is an error that says to pick another HDRI or set the key yourself; `sky` cannot be combined with it |
| `ground` | on | Absent unless set. `false` removes the preview's automatic floor and contact shadow |
| `resolveCoplanar` | `'offset'` | Flush and near-flush faces, inside one mesh or across parts, are ranked per triangle and drawn with a small depth-only bias, so the face in front wins at every distance and nothing flickers. Geometry never moves. `false` opts out, and `scene_inspect` then lists each pair as a `coplanar-overlap` warning (only pairs closer than the pair's own reach, never more than 50 mm). Parts that set `decal` or `depthLayer` keep their own layer. Where an opaque face covers another on the same plane, or in front of it by at most a thousandth of the shared face (between a millimetre and a centimetre), the covered part is cut out of the drawn copy of the hidden face (the part and its geometry stay as you made them), so a stack of any depth is settled and the path tracer sees one face. What cannot be settled comes back as a `coplanar-overlap` warning with a `reason`: `rank-overflow` (more than 16 faces a wider gap apart), `double-sided-gap`, `unchecked` (past the triangle or pair budget, the part the search stopped at is named) or `collapsed-node` (an axis a millionth of the longest one; a 2 cm slab 400 m wide is a ground, not a collapse). A scene of millions of triangles gets a coarser search grid instead of an error; the search only fails, with a message naming this field, when even the coarsest grid is too large. Parts that change every frame, particles and a sea with an `oceanTime` track, are left out of the ranking, so playing the timeline never searches the scene again |
| `objectReflections` | on | Absent unless set. Each smooth metal part (`metallic` 0.5 or more, `roughness` 0.6 or less; at most 8 such parts, in a scene with at most 1,024 other parts) gets a reflection probe of the scene around it, so a chrome sphere shows the floor and its neighbours. A smaller part that holds the probe inside its solid (a glowing bulb at the middle of a ring) is left out of that probe, since it would fill every direction. `false` turns it off. Probes are traced at rest, so a part that moves reflects the scene as it started. `scene_inspect` names them in `reflections` |
| `sky` | absent | Absent unless set. `{ type: 'physical', preset, clockTime, sunElevation, sunRotation, turbidity, groundAlbedo, aerialPerspective, ozone, sunDisc }`: one time-of-day control. `clockTime` `{ hours, latitude, dayOfYear, northOffset }` places the sun from a clock instead (`hours` 0 to 24, required, 12 is solar noon; `latitude` -90 to 90 degrees north (0); `dayOfYear` 1 to 366 (80, the equinox); `northOffset` -360 to 360 degrees that the scene's north is turned clockwise from -Z (0)): it fills `sunElevation` and `sunRotation` by standard solar geometry (checked to under half a degree: noon at latitude 41.7 on the equinox is 48.3 degrees up, due south, which is +Z), the recipe stores those two angles and not the clock, and naming `sunElevation`, `sunRotation` or `preset` beside it fails. A Roblox `ClockTime` is `hours`, its `GeographicLatitude` is `latitude`. `sunElevation` -90 to 90 degrees (default 45), `sunRotation` degrees clockwise from -Z seen from above (0), `turbidity` 1 to 10 haze (3), `groundAlbedo` 0 to 1 (0.3), `aerialPerspective` 0 to 4 scales the distance haze (1; 0 for none), `ozone` 0 to 10 Chappuis-band absorption (1), `sunDisc` boolean (true; the disc is drawn per pixel at `sunAngularRadius`, 0.5 degrees by default, so it stays a sharp round disc at any zoom, and it is not in the baked sky map). `preset` is `golden-hour` (sun 4 degrees up), `sunset` (1 degree) or `blue-hour` (4 degrees below the horizon), each with the sun turned to rotation 250: it supplies the sun only, fields beside it win, and a preset in a `set-environment` patch starts the sky again from its own sun with the other fields at their defaults. A sun below 14 degrees is fitted to Blender's sky (checked at 2, 6 and 15 degrees, comparison in `docs/golden-hour-comparison.jpg`): a narrow saturated orange band forms along the horizon, the zenith dims and the key warms and strengthens; at 14 degrees and above the sky is unchanged. The sky sets `lightDirection`, `keyColor` (the sun reddens and dims with air mass and sets below the horizon), `skyTop`, `skyBottom`, `fogColor` and `fogDensity`, and replaces the setup's environment map with the sky. A `keyColor`, `fogColor` or `fogDensity` you write beside the sky (in the recipe or in the same `set-environment` patch) wins over the value the sky derives, so a preset fills them only when you leave them out; `lightDirection`, `skyTop` and `skyBottom` always follow the sky. A later patch that changes the sky without naming them goes back to the derived values. `environment` motion tracks can animate `sunElevation`, `sunRotation`, `turbidity`, `groundAlbedo`, `aerialPerspective` and `ozone` for time-of-day arcs. A `set-environment` patch changes the fields it names and keeps the rest; `sky: null` in a patch keeps the last derived values as plain fields. It is an analytic single-scattering approximation (Rayleigh, aerosol and ozone, Kasten-Young air mass), not Blender's Nishita integration: no clouds. Raster first: the path tracer backends read the same environment map and key light, but are not yet checked against it. |
| `skybox` | absent | `{ front, back, left, right, up, down }`, each the 64-character ID of an image in `scene_asset_catalog` (local scene assets only, no URLs; all six are needed; a PNG, JPEG or WebP the browser decodes, within the same size limits as map sequence frames). The six faces are folded into one 2048 by 1024 environment map, sampled bilinearly,, which is the background, the diffuse light and the reflections, so `environmentIntensity` and `environmentRotation` act on it as on an HDRI. Faces are upright images as a viewer inside the cube sees them: `front` looks toward -Z (the default camera), `right` is +X, `left` is -X, `back` is +Z, and `up` (+Y) and `down` (-Y) are the top and bottom of a cross laid around `front`, so the bottom edge of `up` and the top edge of `down` touch `front`. The faces are sRGB 8-bit, so the sky tops out at white (1.0): the key light still comes from `lightDirection`, so point it where the picture's sun is. Not together with `hdri` or `sky`; `null` clears it. Raster only |
| `sky` (gradient) | absent | `{ type: 'gradient', stops: [{ at, color }], horizonGlow: { color, width, intensity } }`: a sky whose colours you pick, for a mood that physics would not give (a teal anime sky with a bright cyan band at the horizon). `stops` holds 1 to 8 entries with `at` rising from 0 (horizon) to 1 (zenith, by elevation angle) and `color` as a `#rrggbb` hex in sRGB; below the horizon the first stop continues. `horizonGlow` is optional: `color` as hex, `width` 0.5 to 45 degrees of elevation (the half width of the band, default 6) and `intensity` 0 to 20 (default 1) multiplies the glow colour at the horizon, so 1 shows the colour as given; the band blends toward the glow colour, so it keeps its hue and does not wash to white until the colour itself is bright. The stop and glow colours are compensated for the scene's view transform and the display power, so the frame shows the hex you gave at the horizon, the stops, the zenith and the glow peak (measured within 1 level under `aces` and `neutral`); between stops the colours blend in OKLab, which keeps the lightness and hue steady and bands less than a blend of encoded values. The inverse assumes exposure 1, no look and no post effect, divides by `environmentIntensity`, and is exact for `aces`; `agx` and `neutral` are solved numerically, and a colour they cannot show (a saturated red under `neutral`, pure white under `agx`) lands on the nearest one they can. The scene light and the water reflection read the same compensated radiance, so a gradient lights the scene more strongly than the same hex taken as plain radiance would. The same colours are the background (with `world: true`), the light and reflections of the scene, and the water reflection. It sets `skyTop`, `skyBottom` and `fogColor` from the first and last stop and leaves the sun, the key light and the fog density to the setup and the recipe. A `set-environment` patch with `type: 'gradient'` replaces a physical sky; a patch without `type` edits the gradient in place. Raster first; the path tracer backends read the same map but are not checked against it. |
| `floorSkyTrace` | on | Absent unless set. A closed room a sun lights gets the sky each floor texel sees traced into its floor (`applyFloorSkyVisibility`, strength 0.2), so shadowed floors under a roof or between walls get less world and sky light; it makes the dark end of halls closer to Cycles. Open scenes and rooms lit by lamps alone are left as they are. `false` turns it off; a value that is not a boolean is refused. It loads lazily with a recipe that names its sun (`keyColor` or `keyIntensity`), costs about 1 s of trace when the scene is built and adds triangles to the floor (0.1 to 0.4 ms per frame in the reference halls). |
| `specularAntiAliasing` | `1` | Absent unless set. `0` to `4`. Widens highlights where the shading normal or normal map detail changes within a pixel (geometric specular anti-aliasing plus a Toksvig term read from the filtered normal map length and, for the direct lights, a fade by the normal spread measured per mip level at upload), so grainy or scanned metal stops sparkling from frame to frame at grazing angles. `0` gives a highlight that follows every texel; above `1` is softer. |
| `sunBounce` | `1` | Absent unless set. A number of 0 or more. A closed room a sun lights gets a few point lights at its sunlit patches (`withSunBounce`, found when the scene is prepared), so the floor, walls and pillars around a patch are lit by the light it bounces and the far end of the room less. `0` turns it off and gives the look without it; `1` is fitted to Cycles; above `1` is stronger. A value that is not a number of 0 or more is refused. Open scenes and rooms with no sun are left as they are. It loads lazily with the sun, and the lights take up to 6 of the 16 point light slots. |
| `wetness` | absent | `0` (dry) to `1` (soaked), `0.5` is damp. Darkens porous surfaces (bright paint is spared so it keeps its hue) by up to 80 percent of their colour, pulls their roughness toward 0.4 through a squared wetness curve, with fine grain so the surface texture keeps showing (a sheen that blurs the sky, and at full wetness a soft planar reflection of the scene) and weights their sky reflection down by up to 40 percent (the values of a wet asphalt scan against a dry one, ambientCG Asphalt025C and Asphalt025A, CC0), rougher surfaces more, along a curve that does most of its work early (`0.5` acts as `0.75`); metals are left alone, and water, fire and smoke tags are skipped. The shader code compiles only when `wetness` is above 0, so a scene without it draws the same program and pixels as before. The realtime rasterizer draws it; the path tracers ignore it and render the dry look. |
| `puddles` | absent | `{coverage, from}`. `coverage` 0 to 1 (default 0.5) sets how much of the ground can hold water: at most a quarter of it at coverage 1 and wetness 1 (share = 0.25 x coverage x wetness squared, so 0.5 and 0.5 gives about 3 percent and 1 and 0.5 about 12 percent), so a damp scene gets a few puddles and a soaked one many; puddles need `wetness` above 0. `from: "height"` (the only source so far) pools water where a noise basin on the ground plane rises above a fill level chosen for that share, measured from the height of the ground plane (the top of the widest part), so ground at y 3 or y -2 floods like ground at y 0 and terrain fills its low spots first. Only flat surfaces (under about 5 degrees) take water, and puddles stay at least 18 cm clear of thin raised parts, thinning out to about 1 m (footprint under 1.5 m: markings, kerbs, posts, props; the first 24 are measured). Only the water mirrors: the road around it is dark, gritty and satin, lit by the sky and the sun but never a mirror. The water is a flat, smooth surface over the wet road (the bottom keeps at least nine tenths of the wet road's light, as a path trace of water over asphalt gives, less the share the water reflects at that angle; its grit and tint are mostly hidden under the film, and the road's own olive is not boosted), with a narrow edge (a few centimetres) that the road stones break, a damp band just outside it (the road darkens gradually toward the shore over about 9 cm, by at most a fifth, with a few sparse glints on near stones at a grazing view, and never a dark or bright outline), and a band of darker road about 30 cm wide beyond that; the water carries a faint, slow ripple. The road grit follows the road's own colour and normal maps when it has them (so the road is the same road dry and wet); a road without maps gets stones of mixed sizes. Grit fades in with the wetness and fades out where a pixel is wider than the stones. With `puddles` set, the flat ground parts at the level of the largest one (not metal, not water) draw the scene a second time from the mirrored camera, the same water mirror as a lake (`src/water-reflection.js`, loaded by the recipe text `"puddles":`), so the sky, the objects standing in the puddle and their lit sides show in it, sharp at the edges of the objects. Fresnel makes the reflection strong at grazing angles and faint looking down. The mirror needs a host that attaches it (the preview and render jobs do); a host that does not shows the sky reflection only. `"cavity"` and a mask are not available yet and are refused with a message that says to pass `"height"`. Standing water mirrors the scene at the full size of the frame and crisp: the mirror picture has no ripple shake and no blur beyond the water's own tiny roughness, and the damp band outside it fades into the road over about 12 cm. |
| `setup` | `daylight` | `daylight`, `overcast`, `sunset` or `studio`. See Lighting setups |
| `ambientColor` | absent | Three numbers, `0` to `10`, linear RGB. Absent unless set. A flat diffuse fill tinted by the surface colour (a Roblox `OutdoorAmbient`; about `0.3` is a clear daytime fill). It fades out where the key light reaches the surface (fully by a surface angle of about 7 degrees to the sun, so a face at 0.3 N.L takes none), so it tints shadow and faces turned from the sun and leaves sunlit ground and walls as they were, and it does not touch reflections. Raster only: the path tracers ignore it. `environmentDiffuseScale` and `ambientIntensity` multiply it, and a room's bounce light adds beside it |
| `environmentDiffuseScale` | absent (`1`) | `0` to `100`. Scales the environment's diffuse light and leaves its reflections alone, where `environmentIntensity` scales both (a Roblox `EnvironmentDiffuseScale`). Raster only |
| `environmentIntensity` | `1` | `0` to `100`. Scales the setup's environment light and reflections, multiplied by `ambientIntensity` |
| `environmentRotation` | `0` | `-100` to `100` radians around the vertical axis |
| `lightDirection` | the setup's | Components within ±1000000, length at least `0.000001` |
| `keyColor` | the setup's | Components from `0` to `1000` |
| `keyIntensity` | `1` | `0` to `100` |
| `fillIntensity` | `0` | `0` to `100` |
| `ambientIntensity` | `1` | `0` to `100`. Scales the sky ambient and also the diffuse light and reflections of the setup environment map or HDRI, so `0` renders an HDRI-lit scene black whatever `environmentIntensity` is. For an HDRI-only scene keep it above `0` and set `keyIntensity` and `fillIntensity` to `0` |
| `daylight` | `1` | `0` to `100` |
| `pointLights` | `[]` | At most 16 point light records |
| `skyTop` | `[0.2, 0.38, 0.52]` | Components from `0` to `1` |
| `skyBottom` | `[0.62, 0.7, 0.67]` | Components from `0` to `1` |
| `fogColor` | `[0.35, 0.43, 0.43]` | Components from `0` to `1` |
| `fogDensity` | `null` | `0` to `10`. `null` fits the density to the scene: `0.006`, or `1.2` divided by the scene diagonal in metres when that is smaller, so a 900 m scene keeps 30 percent of its contrast at the far side. Set `0` for no fog |
| `volumeFog` | Complete defaults below | One bounded world volume |
| `localVolumes` | Absent | Up to 8 box, sphere or mesh (a part) volumes that absorb and emit light; see [volume fog](https://crucible.codepawl.com/volumetric.md#local-volumes) |

Directional key radiance equals `keyColor * keyIntensity`.
Zero intensity disables that lighting contribution.
Direction magnitude remains in the canonical recipe.
The shadow projector uses its normalized direction, so changing only magnitude does not change shadow placement.

### Coplanar findings in edit answers

A `coplanar-overlap` finding rides along with an edit answer (`scene_apply`, `mesh_edit` and the other edit tools) only when it is new or when one of its parts moved or changed shape since the last answer carried it. When a batch leaves reported findings untouched, the answer adds one `coplanar-overlap-unchanged` entry with a count, for example "2 coplanar overlaps reported earlier are unchanged". `scene_inspect` always lists every finding. A finding that goes away and later comes back is reported again.
High radiance can clip at the renderer's half-float HDR target limit of `65504` before bloom and tone mapping.

## Light units and three.js conversion

Every intensity is a linear scene value, not a photometric unit with its own scale.
For a white diffuse surface facing a light, the outgoing radiance is `intensity * color / PI`, the same as three.js r155 and later (`useLegacyLights` removed, physical units).
So a three.js light copies over with the factor below, and a scene lit by one light matches without tuning.
Compare at the same `exposure` (three.js `toneMappingExposure`), and note that Crucible tone maps with an ACES-style curve only when `hdr` is off.

| Crucible field | Unit | three.js light | Value to use |
| --- | --- | --- | --- |
| `keyColor * keyIntensity` | Irradiance on a surface facing the light, lux-like | `DirectionalLight.color * intensity` | Same value. Put the intensity in `keyIntensity` and keep `keyColor` in `0` to `1` |
| `pointLights[].intensity` | Candela-like: irradiance at distance `d` is `intensity / d^2` | `PointLight.intensity` | Same value. `range` is `distance` (the same smooth cutoff). Set `radius: 0.1` to match three.js's clamp of `d^2` at `0.01` |
| `spotLights[].intensity` | Candela-like, as a point light, scaled by the cone | `SpotLight.intensity` | Same value. `angle` is the same half angle in radians. `penumbra` fades in cosine here and in angle in three.js; both agree at `0` and `1` |
| `areaLights[].intensity` | Candela-like: on axis, far from the light, irradiance is `intensity / d^2`, and `intensity / (d^2 + width * height / PI)` in general | `RectAreaLight.intensity` (nits) | `nits * width * height` |
| `fillIntensity`, `ambientIntensity`, `environmentIntensity` | Unitless multipliers on the fill rig, the sky ambient and the setup's environment map | `AmbientLight`, `HemisphereLight`, `scene.environmentIntensity` | No exact equivalent. |

A three.js scene built before r155 with the legacy light model multiplies each of those intensities by `PI` to get the Crucible value.
`tests/light-units.test.js` ports a directional, point, spot and area light this way and checks the irradiance each produces against the three.js formula within 2 percent.

## Lighting setups

A recipe with no lighting settings uses `daylight` (and no occlusion): a small procedural sky map (128 by 64, generated in code, no files or URLs) lights every surface and shows in metal and glossy reflections, with a warm key light for shadows.
The four setups are `daylight`, `overcast` (even grey light, weak key), `sunset` (low warm sun, dark blue zenith) and `studio` (neutral room with three soft boxes).
Setting `setup` through `set-environment` resets `lightDirection`, `keyColor`, `keyIntensity`, `fillIntensity`, `ambientIntensity`, `skyTop` and `skyBottom` to that setup; fields in the same call still win, and fields set earlier are replaced.
Remote URLs and HDRI files are not accepted from tool input.
This changes the look of every recipe that sets no lighting: before, the default had no environment map, a key color of `[5.2, 4.7, 4.1]` and a fill intensity of `1`.
To get the earlier flat look, set `keyColor`, `fillIntensity` and `environmentIntensity: 0` yourself.
The MCP preview adds an automatic floor: a light grey disc under the scene's lowest geometry, at that height, which catches the key light's shadow. It is not a recipe node and is not exported. A part that already forms a floor (spans at least 90 percent of the scene's width and depth, is thinner than a quarter of its width and is the lowest geometry) switches it off, and `environment.ground: false` removes it. While a motion time is sampled (a render job, or `scene_look` at a time) the floor is decided and sized once from the pose at time 0, so flying or falling parts never resize it or move the horizon. Code that builds its own `CrucibleRenderer` gets it by passing `createAgentGround(agentGroundPlacement(parts, environment))` as the `ground` option (`src/agent-ground.js`).

## Point lights

Each point light requires a world-space `position`.
The renderer uses inverse-square attenuation outside its radius.
Radius limits attenuation rather than creating an area emitter or softening shadows.
Point lights do not scatter through volume fog. A point light casts a local shadow only with `castShadow: true` (see [Local shadows](lighting.md#local-shadows)).

| Field | Default | Range |
| --- | --- | --- |
| `position` | Required | Three components within ±1000000 |
| `color` | `[1, 1, 1]` | Linear RGB components from `0` to `1` |
| `intensity` | `1` | `0` to `100000` |
| `radius` | `0.05` | `0.001` to `1000000` |
| `range` | `0` | `0` for unlimited falloff, otherwise `0.001` to `1000000` |

Range values between zero and `0.001` reject.
The directional shadow map shadows the sun. A point light with `castShadow: true` also draws its own shadow; without it the light can illuminate through opaque walls.

## Outlines and toon light

`environment.lines` draws outlines, an optional banded light and screen-width polylines. One edit turns it on:

```json
{ "type": "set-environment", "environment": { "lines": { "width": 2, "toon": 3 } } }
```

`"lines": null` turns it off. A material can also set `toon` (0 to 8) for its own bands. The fields, limits and costs are in [line art](line-art.md). `scene_capabilities` reports `lineArt` and the `toon` layer field.

## Volume fog

Active volume fog requires an opaque renderer with `{ hdr: true, depth: true }` and negotiated HDR support.
The volume uses resolved opaque depth and directional scattering with the directional shadow map.
Density zero disables the volume.
These controls reuse `resolveVolumeFog` and its existing domain rules.

| Field | Default | Range |
| --- | --- | --- |
| `density` | `0` | `0` to `10` |
| `minimum` | `[-100, 0, -100]` | Three components within ±100000 |
| `maximum` | `[100, 20, 100]` | Three components within ±100000, strictly above minimum after Float32 rounding |
| `color` | `[0.8, 0.85, 0.9]` | Linear RGB components from `0` to `1` |
| `ambient` | `[0.03, 0.035, 0.04]` | Linear RGB components from `0` to `10` |
| `drift` | `[0.03, 0, 0]` | Three components within ±100 |
| `steps` | `16` | Integer from `8` to `48` |
| `anisotropy` | `0.3` | `-0.9` to `0.9` |
| `noiseAmount` | `0.5` | `0` to `1` |
| `noiseScale` | `0.3` | `0.001` to `100` |
| `maxDistance` | `100` | `0.01` to `10000` |
| `shadowAmbient` | derived from the scene: 0.15 in a closed room, 1 under open sky | `0` to `1` |
| `scatterOctaves`, `multiScatter`, `multiExtinction`, `multiAnisotropy`, `keyTransmittance`, `surfaceTransmittance`, `beamRadius` | `1`, `0.5`, `0.5`, `0.5`, `0`, `0`, `0` | Integer `1` to `4`, then `0` to `1` each, `beamRadius` `0` to `20` metres; off by default, see [volume fog](https://crucible.codepawl.com/volumetric.md) |
| `detailOctaves`, `detailAmount`, `warp`, `contrast`, `profileSoftness`, `keyScattering` | `1`, `0.5`, `0`, `1`, `0.5`, `1` | Integer `1` to `3`, `0` to `1`, `0` to `4`, `0` to `4`, `0` to `0.95`, `0` to `10`; see [volume fog](https://crucible.codepawl.com/volumetric.md) |

Fog bounds reject dimensions that collapse after Float32 rounding.
The current volume supports one directional scattering source.
Local point scattering, transparent depth, multiple scattering, and multiple volumes remain outside this contract.
See [volume fog](https://crucible.codepawl.com/volumetric.md) for renderer requirements and frame-time limits.

## Effects

The controls reuse `resolveEffects` with a preview bloom strength of `0.12`.
Exposure remains independent and maps to `frame.exposure`.
Bloom strength zero disables bloom.
Ambient occlusion reads the depth texture, so it needs the HDR depth target that previews use. A renderer built without `depth: true` skips the pass and lists an `ambient-occlusion-without-depth` warning in `renderer.diagnostics` (the preview's render info carries it too). The program compiles and its half-resolution target allocates on first use. On SwiftShader at 960 by 540 it adds about 16 ms to a 190 ms frame (measured, 8 percent). It is off by default: against Cycles on 10 reference scenes it improved no score by more than 0.002 and made most slightly worse, because the largest gaps are cast shadow shape and reflections, not contact darkening. Pixels that direct light already brightens keep less of it, because occlusion belongs to indirect light. Each depth sample is rebuilt at the centre of the texel it was read from, so a flat wall at a slant stays unchanged instead of drawing vertical bands (the `corner` bench scene, FLIP against Cycles 0.1253 before, 0.1085 after, 0.1064 without the pass).

| Field | Default | Range |
| --- | --- | --- |
| `exposure` | `1` | `0.01` to `16` |
| `saturation` | `1` | `0` to `2` |
| `contrast` | `1` | `0.1` to `2` |
| `temperature` | `0` | `-1` to `1` |
| `vignette` | `0` | `0` to `1` |
| `grain` | `0` | `0` to `0.1` |
| `ambientOcclusion` | `0` | `0` to `1`. Screen-space contact darkening, off by default; any value above `0` runs the pass |
| `ambientOcclusionRadius` | `0.5` | `0.01` to `100` world units |
| `bloom.strength` | `0.12` | `0` to `8` |
| `bloom.threshold` | `1` | `0` to `10` |
| `bloom.radius` | `1` | `0.1` to `16` |
| `depthOfField.blur` | `0` | `0` to `1`. Lens blur from depth, off by default; the widest circle is 5 percent of the image height |
| `depthOfField.focusDistance` | `5` | `0.01` to `100000` metres from the camera that stay sharp |
| `motionBlur.shutter` | `0` | `0` to `0.5` seconds of camera motion to smear |
| `motionBlur.objects` | `0` | `0` to `1`. How much of each moving part's own motion to smear over the same shutter; `0` leaves it off |
| `colorCorrection.brightness` | `0` | `-1` to `1`, in stops of two: `0.5` doubles the light, `-0.5` halves it. A cheap grade with no LUT file, in the order of a Roblox `ColorCorrectionEffect` (`Brightness`) |
| `colorCorrection.contrast` | `0` | `-1` to `1`. `1` doubles the steepness about middle grey (`0.18`), `-1` flattens the frame to it |
| `colorCorrection.saturation` | `0` | `-1` to `1`. `-1` is greyscale, `1` doubles the saturation as a chroma scale in Oklab (positive values gain less on colours that are already vivid, and a colour is pulled back before a channel clips, so greens stay greens) |
| `colorCorrection.tint` | `[1, 1, 1]` | Three numbers, `0` to `4`, that multiply red, green and blue; `[1, 0.9, 0.8]` is warm. Applied first, then brightness, contrast and saturation. At all four defaults the step is skipped, so the frame is byte for byte what it was without it |
| `sunRays.intensity` | `0.25` | `0` to `4`. Light the rays add, in the key light's colour; `0` turns the step off. A screen-space shaft pass (a Roblox `SunRaysEffect`): each pixel of a half-resolution pass marches 24 taps toward the sun and gathers the glow of the sun's disc through the taps that see open sky in the depth buffer (a radial blur of the sky mask), so a tree, mast or wall in front of the sun breaks the glow into beams that radiate from it; it only adds light, so there is no dark halo. A faint haze of the glow also reaches pixels whose rays are all blocked, so the sky beside a crown in front of the sun is as bright as the sky farther away and no dark ring forms. Nothing in the frame blocking the sun gives a plain glow around it. The sun is the `lightDirection`; a sun behind the camera sends no rays. A depth-aware upsample adds it to the full frame. Costs two passes only while the step is named, and none while the sun is behind the camera |
| `sunRays.spread` | `1` | `0` to `1`. How far the rays reach from the sun, as a share of the way to it (`0.15` to `1`) and the radius of the glow (`0.3` to `1.3` of the frame height) |
| `colorBalance.lift` | `[0, 0, 0]` | Three numbers, `-1` to `1`. Raises the shadows per channel and fades out toward white |
| `colorBalance.gamma` | `[1, 1, 1]` | Three numbers, `0.1` to `4`. Bends the midtones; above `1` is brighter |
| `colorBalance.gain` | `[1, 1, 1]` | Three numbers, `0` to `4`. Scales the highlights |
| `glare.streaks` | `0` | `0` to `1`. Thin star streaks from every pixel above the threshold, bright at the core and fading to the tip |
| `glare.count` | `4` | Whole number, `1` to `8`. Arms spaced evenly around the circle: `2` is one straight line (a horizontal anamorphic streak at angle `0`), `4` a plus, `6` a six-point star |
| `glare.angle` | `0` | `-360` to `360` degrees. Turns the first arm from the horizontal; `45` turns a plus into an X |
| `glare.fogGlow` | `0` | `0` to `1`. A soft halo around the same bright pixels |
| `glare.threshold` | `1` | `0` to `10`. Peak scene brightness (linear, before tone mapping) from which a pixel glares |
| `glare.size` | `0.15` | `0.01` to `1`. Streak length and halo radius as a fraction of the image height |
| `stylize.sharpen` | off | `0` to `2`. Adds the difference between a pixel and its four neighbours back to it |
| `stylize.kuwahara` | off | Whole number, `0` to `8`. Painterly smoothing: each pixel takes the mean of the least varying quadrant within this many pixels |
| `stylize.posterize` | off | Whole number, `0` to `256`. Rounds each channel to this many steps |
| `stylize.pixelate` | off | Whole number, `0` to `64`. Block size in pixels |
| `autoExposure.metering` | `average` | `average` or `centre-weighted`. Setting any `autoExposure` field turns automatic exposure on; the metered value is the log-average luminance of the frame on a 16 by 16 grid |
| `autoExposure.key` | `0.18` | `0.01` to `1`. The luminance the metered frame is brought to (middle grey) |
| `autoExposure.minimum`, `autoExposure.maximum` | `0.25`, `4` | `0.01` to `16`, minimum not above maximum. Limits of the chosen exposure; it replaces `exposure` while on |
| `autoExposure.speed` | `1.5` | `0.01` to `100` per second. How fast the exposure follows a change, on the frame time |
| `colorBalance.mask`, `stylize.mask` | none | Limits the step to part of the frame, see below |
| `composite.background` | none | `{ color: [r, g, b] }` or `{ top, bottom }` (a vertical gradient), each channel `0` to `64`. Shows through keyed pixels and through any alpha the frame has |
| `composite.key.chroma` | none | `{ color, tolerance, softness }`: pixels whose chroma (hue and saturation, not brightness) is within `tolerance` (`0` to `1`, default `0.3`) of `color` turn transparent, fading over `softness` (`0` to `1`, default `0.1`) |
| `composite.key.luma` | none | `{ low, high, invert }`: pixels darker than `low` turn transparent and those brighter than `high` stay, `0` to `10` in linear light (`0.18` is middle grey), smooth between. `invert: true` keeps the dark ones instead |
| `composite.mask` | none | Limits the key to part of the frame, same fields as the other masks |
| `lensDistortion.distortion` | `0` | `-1` to `1`. Above `0` is barrel, below is pincushion |
| `lensDistortion.dispersion` | `0` | `0` to `1`. Red and blue split apart toward the edges, up to 3 percent of the distance from the center |
| `localToneMapping.strength` | `0.4` | `0` to `1`. How much of the compression below applies; `0` draws nothing |
| `localToneMapping.highlightContrast` | `0.6` | `0` to `1`, `1` leaves bright regions alone. Lower pulls the part past `midtoneRange` (a low sun's sky) down toward middle grey (`0.18` linear); `0` at full strength flattens it |
| `localToneMapping.shadowContrast` | `0.6` | `0` to `1`, `1` leaves dark regions alone. Lower lifts the part past `midtoneRange` (shaded grass) toward middle grey by the same rule, by at most 2 stops, so deep shadows stay dark |
| `localToneMapping.detail` | `1` | `0` to `2`. Gain on the fine detail kept apart from the base; `1` keeps it as rendered |
| `localToneMapping.blurRadius` | `0.08` | `0.01` to `0.25`. Reach of the base blur as a fraction of the image height; taps stop at strong brightness edges, so a bright sky does not bleed into the ground |
| `localToneMapping.midtoneRange` | `1.5` | `0` to `4`. Stops either side of middle grey that are left exactly as rendered; only brighter or darker regions are compressed, so the frame keeps its contrast. `0` compresses from middle grey outward |

`localToneMapping` splits the frame into a blurred base and the detail, compresses the base in log luminance toward middle grey (`0.18`), only where it lies past `midtoneRange`, and adds the detail back; the gain is one number for all three channels, so hue and saturation stay as rendered; naming the group turns it on at the defaults, `strength: 0` turns it off. It needs the HDR frame (it stays off on a benchmark renderer), runs in every render job that draws the raster frame, and does not touch the path tracer output yet. It runs after glare, so glare still sees the scene's real highlights, and before bloom, which then reads the mapped frame.

Automatic exposure is off until `effects.autoExposure` is set and needs the HDR renderer (the render jobs and the preview use it). It adapts from the exposure of the frame before it on the frame's own time, so a render job that steps frames at a fixed interval gives the same frames on every run; a still, a repeated time or a seek back goes straight to the metered exposure. It is not applied to `linearOutput` frames. `scene_inspect` reports `look.autoExposure.chosen` (exposure, target and metered luminance at exposure 1) from a frame it draws at time 0, and `chosen: null` when it has no GPU preview.

A step with a `mask` applies only where the mask is on; with no `mask` it applies to the whole frame, as before. `mask` takes `objects` (one to 16 part names, the node ids of the parts in the scene; `scene_look` takes no `pass` argument), `depth` (`near`, `far` metres along the view direction, and `feather`, the metres over which each end fades; defaults `0`, `100000`, `0`), or both, which multiply, and `invert: true` to flip the result. A grade for the hero part only: `{ "colorBalance": { "gain": [1.3, 1, 0.8], "mask": { "objects": ["hero"] } } }`. A mask by parts reads the object ID pass, so the frame is drawn twice, and its edges are hard because an object ID cannot be antialiased; a mask by depth costs nothing extra. A name that is not a part of the frame fails with the names it knows. A mask cannot be combined with an active `lensDistortion` (distortion other than 0, or dispersion above 0): the mask is built in undistorted screen space, so it would not line up with the warped image, and the recipe fails with an error that says so. `composite` runs last, after `stylize`: it keys the finished frame, grade and filters included, and draws it over the background, so key a green screen with the colour it has after those steps. A key needs a background, and a mask needs a key. Only keys are in so far: alpha over an image, Z combine and cryptomatte are not. A mask on `composite` limits where the key applies, so pixels outside it stay as drawn. `stylize` runs after color balance: pixelate first (the other filters read the blocks), then kuwahara, sharpen, posterize. Every filter is off until named, and a filter set to `0` is off.

Depth of field and motion blur are deterministic: they read the frame, its depth and the camera, with fixed sample patterns, so a seek to a time gives the same pixels as playing to it.
Depth of field applies to every render, including `scene_look`.
Motion blur needs camera `motion` tracks and a render job with `settings.motion`: the job samples the camera at `motion.start + elapsed - shutter` as well, and smears each pixel along the screen movement between the two.
With `motionBlur.objects` above zero, a part that moves between `motion.start + elapsed - shutter` and `motion.start + elapsed` also smears along its own screen path while the still background stays sharp (`1` is the full shutter). It reads each pixel's part from an object ID pass, so it costs a second draw of the frame, and it replaces the camera smear on that frame, since it covers the camera's motion too. A part is moved as one rigid body by its node transform: a skinned or morphed part, an imported asset and a translucent part are not smeared per object.
Both effects compile their shader and allocate their targets the first time a frame uses them, and a scene that leaves them at zero pays nothing.

The named post steps are `depthOfField` (defocus from depth), `colorBalance`, `colorCorrection`, `sunRays`, `distortion`, `flash`, `glare`, `lensDistortion`, `stylize`, `composite` and `localToneMapping`. Each is its own group, off until a recipe names it, and a group at its neutral values draws nothing. They run on the resolved HDR frame, before bloom and tone mapping, in this order: depth of field, motion blur, distortion, flash, glare, local tone mapping, lens distortion, color balance, stylize, composite. Like the two above they are deterministic, and `colorBalance`, `glare`, `lensDistortion`, `stylize` and `composite` load their code and shaders only for a recipe that names one.

### Air distortion and flash

![A street before and after the shock ring and heat haze: the ring bends the building edges, the haze shimmers around the fire, and the cars in front stay put.](https://raw.githubusercontent.com/codepawl/crucible/main/docs/post-distortion-comparison.jpg)

A blast sells itself in its first frames: a flash, a ring that bends the air, and shimmer above the fire. `effects.distortion` bends the picture behind it, and `effects.flash` lifts the light around a point for a moment. Both are steps you place in the scene, like a light, and both follow the scene clock, so any frame renders the same.

```json
{ "effects": {
  "flash": { "node": "bomb", "startTime": 0, "attack": 0, "decay": 0.15, "intensity": 3.5, "radius": 6, "ambient": 0.15 },
  "distortion": [
    { "shape": "ring", "node": "bomb", "startTime": 0, "speed": 45, "thickness": 2.2, "strength": 1, "falloff": 0.6, "edge": 0.5 },
    { "shape": "haze", "centre": [0, 3, -16], "region": "sphere", "size": [5, 4, 5], "noiseScale": 1.1, "scroll": 3, "strength": 0.9 }
  ]
} }
```

Each step takes one source or a list of up to four. Every source places itself with `centre` (`[x, y, z]` metres) or with `node`, the ID of a node it follows; the recipe fails with the node IDs it has when one is unknown.

| Field | Default | Meaning |
| --- | --- | --- |
| `distortion.shape` | required | `ring` or `haze` |
| `distortion.startTime` | `0` | Ring only. Seconds on the scene clock, `0` to `3600` |
| `distortion.speed` | `40` | Ring only. Metres per second, `0` to `10000`; the radius at time `t` is `speed * (t - startTime)` |
| `distortion.thickness` | `1.5` | Ring only. Metres, `0.01` to `1000` |
| `distortion.strength` | `0.5` ring, `0.3` haze | `0` to `1`. At `1` the picture shifts by up to 15 percent of the image height for a ring and 4 percent for haze |
| `distortion.falloff` | `0.4` | Ring only. `0` to `20`; the strength decays as `exp(-falloff * seconds)` while the ring grows |
| `distortion.edge` | `0` | Ring only. `0` to `2`. A warm light lift on the thin band at the ring radius, scaled by the ring's strength, so the front reads as a visible edge on flat walls. Off by default |
| `distortion.maxRadius` | `200` | Ring only. Metres, `0.01` to `100000`; the ring vanishes past it |
| `distortion.region` | `box` | Haze only. `box` or `sphere` |
| `distortion.size` | `[2, 2, 2]` | Haze only. Half-extents in metres, each `0.01` to `1000` |
| `distortion.noiseScale` | `1.5` | Haze only. Noise cells per metre, `0.01` to `100` |
| `distortion.scroll` | `1` | Haze only. Metres per second the shimmer rises, `0` to `100` |
| `flash.startTime` | `0` | Seconds on the scene clock |
| `flash.attack` | `0.05` | Seconds to rise to full brightness, `0` to `60`; `0` is instant |
| `flash.decay` | `0.4` | Seconds to fall from full brightness to zero, `0.01` to `60` |
| `flash.intensity` | `4` | `0` to `1000`, linear scene light added at the point |
| `flash.color` | `[1, 0.85, 0.6]` | Three numbers, `0` to `1` |
| `flash.radius` | `50` | Metres, `0.01` to `100000`. The light is `intensity / (1 + (distance / radius)^2)`, so it halves at this distance from the point |
| `flash.ambient` | `0` | `0` to `0.5`. A screen-wide gain at the flash's peak (`0.15` is 15 percent), so the frame far from the point does not read dark beside it |
| `*.time` | `0` | Seconds. The scene sets it from the playhead; set it yourself to hold a still of a scene with no motion |

The ring bends the picture where the line of sight passes the centre at the ring radius, and the haze shifts it by noise taken inside its box or sphere. Both read the depth buffer: a surface in front of the bending air is not dragged along, and air behind a wall does nothing. The flash adds light before bloom and tone mapping, so a bright flash feeds bloom where bloom is on. Surfaces are lit by their distance from the point; sky is lit by the distance of its line of sight.

Animate them with the clock and with motion tracks. `sampleMotion` and a timeline set the time of every source, and a followed node carries its source along. A track `{ "kind": "effects", "property": "distortionStrength" }` or `"flashIntensity"` multiplies every source of that step by a gain from `0` to `1`, to fade or to key them by hand; it needs the step in the recipe. A mask on `colorBalance`, `stylize` or `composite` cannot be combined with an active distortion, because the mask is built in the undistorted frame. The steps draw nothing, and load no code, in a recipe that does not name them.

To reproduce the picture and the clip: `node bench/post/air-distortion.mjs --out=artifacts/air-distortion`.

## Directional shadows

Shadow controls define an orthographic projector aligned with the current light direction.
The derived eye equals `target + normalize(lightDirection) * distance`.
The projector uses up vector `[0, 0, 1]` when the absolute normalized Y component exceeds `0.99`.
Other directions use `[0, 1, 0]`.
This avoids a collinear camera up vector for vertical lights.

| Field | Default | Range |
| --- | --- | --- |
| `target` | `[0, 1, 0]` | Three components within ±1000000 |
| `extent` | `3.5` | `0.01` to `100000`, half-width and half-height |
| `distance` | `8` | `0.01` to `1000000` |
| `near` | `0.1` | `0.001` to `1000000` |
| `far` | `15` | `0.001` to `1000000`, above near after Float32 rounding |

The derived eye and target must remain distinguishable at Float32 precision.
View, projection, and combined matrices must remain finite and nonsingular at Float32 precision.
Large targets and short distances can fail these combined checks even when each field fits its individual range.
Derived projectors do not automatically fit scene or fog bounds.

Recipes always derive the eye from `lightDirection`, so shadows follow the light. A custom adapter that passes its own `shadowBounds.eye` to the renderer overrides that: the eye decides where shadows fall, and `lightDirection` only moves the shading. When the two differ by 10 degrees or more, the renderer lists a `shadow-light-direction-mismatch` warning in `renderer.diagnostics`. Leave `eye` out of `shadowBounds` to make the shadow follow the light.

`renderer.render({ effects })` draws `depthOfField` (`blur`, `focusDistance`), `motionBlur` (`shutter`, `objects`), `bloom` (`strength`, `threshold`, `radius`), `saturation`, `contrast`, `temperature`, `vignette`, `grain` and `ambientOcclusion` with `ambientOcclusionRadius`. Any other key, or a field inside one of those groups it does not read (such as `depthOfField.aperture`), is not drawn, and the renderer lists an `effect-not-drawn` warning for it in `renderer.diagnostics`. `exposure` belongs on the frame (`render({ exposure })`). The post steps (`glare`, `lensDistortion`, `stylize`, `distortion`, `flash`, `colorBalance`, `composite`) run only in a scene recipe's render, not in a bare `renderer.render` call.

The renderer refuses a `lightDirection` holding NaN or Infinity, and a shadow view whose `extent` is 0 or whose `far` is not above `near`, with an error that names the value to pass.

## Validation boundary

Every object rejects unknown keys.
Inputs must contain ordinary plain JSON objects and dense arrays without extra fields or hidden properties.
Accessors, executable values, cyclic references, typed arrays, and nonfinite numbers reject.
The helpers return independent arrays, including volume defaults.
JSON nesting has a maximum depth of 32, and look arrays have at most 16 entries.

| Design | Benefit | Cost |
| --- | --- | --- |
| Forward raw renderer environment and postprocess options | Direct access to every renderer field | Defaults and validation vary across adapters |
| Normalize a bounded JSON look before publication | Canonical defaults, replay, atomic validation, and one derived shadow direction | Explicit field vocabulary |

The helper normalizes bounded JSON while reusing the engine's lighting, effects, and volume validators.
Session and transport code remain responsible for revisions, patches, checkpoint ownership, and rendering.

A fitted look is applied with scene_apply; [fit the look to references](https://crucible.codepawl.com/agent-fit-look.md) fits the parameters to reference colours.
