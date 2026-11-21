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

## Issues

- Opened: #2829 (emitter follows a moving node), #2830 (camera-facing billboard particles, non-darkening fade).
- Already open and relevant: #2034 (contact foam at hulls), #2040 (spray from bows and crests), #2823 (spray emitter on a 74k-vertex sea exceeds 30 s in `scene_create`; not hit here because no crest emitter was added).

## Round 2 (galleon-preview-2.png, galleon-preview-2.mp4; round 1 files kept)

- Horizon: a second 9 km coarse sea sheet under the 300 m one, plus fog 0.0022 tinted like the HDRI horizon, so the sheet edge is gone and distance fades to haze.
- Water: `windSpeed` 13, `size` 110, darker body colour, roughness 0.05.
- Wake: 61 points, a ring along the hull, a 120 m widening, swaying trail behind the stern, and bow-wave arms that start at the cutwater.
- Spray: fine 0.12 to 0.45 m cards flung forward and up, plus a soft bow mist; low mist cards at opacity 0.07.
- Camera lowered (y 1.8) and the ship sunk to a 4.6 m draft; one frame of the clip has a swell hiding the hull.
- Sun shafts: tried `environment.volumeFog` (0.012 whites the frame out, 0.0015 gives only haze, no shafts). Filed #2831.
- 1440x900 desktop still not made: `scene_look` caps width at 1024.
- Workarounds for #2829 and #2830 are commented on those issues.
- Still weak: the mist is barely visible, the hull looks green under the water, the wake trail is faint at the far end, the water is still pale at distance.

## Round 3 (galleon-preview-3.png, galleon-preview-3.mp4)

- Hull: camera raised to y 3.6 and 3.3, swell lowered (`windSpeed` 10, `size` 70, `resolution` 6, new seed), draft 3.9 m. The hull shows in every sampled clip frame (0, 50, 100, 143).
- Colour and contrast: fog 0.0011 (was 0.0022), key light 1.4, darker water body (0.001, 0.008, 0.028), roughness 0.035. The hull is browner; the lower hull still has green paint of its own.
- Wake: a V of two stern arms (16 points each side, widening 0.24 m per metre), a short central trail, a bow wave and a foam ring along the hull. Still faint at its far end.
- Still weak: the sea and far-sea sheets raise a z-fighting warning (0.6 m apart at the far edge), a single ocean spectrum so waves still repeat at long range, the mist is faint, the sails read grey.
