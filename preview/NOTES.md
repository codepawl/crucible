# Dutch galleon on Crucible water: stage 1 preview (#2758)

Low-quality preview only. Not the showcase scene, no PR.

- Still: `preview/galleon-preview.png` (960x540). Clip: `preview/galleon-preview.mp4` (480x270, 6 s, 24 fps).
- Rebuild: `preview/build.mjs` (MCP client: `scene_create`, `scene_look`, `scene_render_submit`). It needs `galleon.glb` (the Dutch ship, keel at y 0, exported from the candidate's glTF with Blender, no sea plane) and `sky.hdr` (Poly Haven kloofendal_48d_partly_cloudy_puresky, CC0) in its `assets` folder. The ship credits are in CREDITS.md of branch `evidence-issue-2758`.

## What the scene uses

- Water: an `ocean` stack node on a 300 m sheet (17 cuts, subdivide 4: about 74k vertices, 1.1 m cells), `windSpeed` 9, `choppiness` 1.6, `size` 60, `resolution` 5, an `oceanTime` track at one second per second. Material `tag: "water"`, `waterPreset: "sea"`, dark body colour, `turbidity` 0.25. The shader gives the crest foam, the fresnel sky reflection (HDRI clouds) and the sun glint.
- Waterline and wake: the ocean node's `wake: { points, height }` with 62 hand-placed points: a foam ring along the hull at the waterline, a centre trail behind the stern that widens and fades, and two bow-wave arms. Static, because the ship does not move through the sea (see issues).
- VFX: two `particles.systems`. Bow spray: 2000 soft round cards (`plane` card, `alphaMode: "add"`, a `snippet` that draws a round falloff from the uv), a box emitter at the bow. Low mist: 400 big faint cards drifting over the sea (too faint to see in this cut). `sky` HDRI clouds and a `fogDensity` of 0.0009 for haze.
- Not done: birds, sun rays, crest droplets from the `spray` vertex group.

## What still looks weak

- Spray is small puffs, not a sheet of droplets; the cards do not face the camera.
- The mist cards are nearly invisible.
- The ship holds its place: no pitch or roll, wake does not travel with it.
- A bright cyan line at the horizon where the 300 m sheet ends.
- The wake and foam ring are blobs at 1.1 m cells; no contact foam where waves slap the hull.
- Ship sails read flat white-grey.
