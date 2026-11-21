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

## Round 4 (galleon-preview-4.png, galleon-preview-4.mp4, sheet4.png; builder preview/build-round4.mjs)

Root cause of the water glitch (measured, engine commit 3d85dae2 for rounds 3 and 4 alike in the controls; round 3 itself was rendered on an older build): the clock-driven wind ripples of the water shader (`waterDetailSlope`), not the far-sea sheet, foam, spray, mist, `oceanTime` or the camera. Filed as #2843.

Water diff = mean absolute grey difference between consecutive frames in the near-water crop (bottom 30 % of the frame; left 30 % and right 30 %), 480x270, 24 fps, extracted from the mp4 of each round. Script: `diff.py`.

| Case | nearL mean / p99 | nearR mean / p99 |
|---|---|---|
| Round 3 clip (moving) | 7.65 / 39.2 | 6.96 / 36.8 |
| Round 4 clip (moving, ship swell, 48 fps blended to 24) | 6.27 / 30.6 | 5.72 / 28.9 |
| Frozen control, stills (camera fixed, flat `oceanTime`, no particles) | 4.68 / 26.5 | 4.49 / 26.3 |
| Frozen control, 48 fps blended to 24 | 4.17 / 21.2 | 4.20 / 22.2 |
| Frozen, ripple clock multiplied by 0 | 0.78 / 5.8 | 0.76 / 6.4 |
| Frozen, ripple speed capped at 12 rad/s | 4.67 / 26.8 | 4.47 / 26.6 |
| Frozen, 960x540 area-downscaled | 4.49 / 24.0 | 4.24 / 24.3 |

- Proof: a frozen scene has 0.0 difference in the sky rows and 4.7 in the near water; stopping the ripple clock removes about 85 % of it. The ripples that matter are the 0.6 to 3 m ones (4.5 to 12 rad/s), they run in all directions and not with the wind.
- Ruled out by measurement: the far-sea sheet (no far sheet: 7.99 against 7.87, within noise; the z-fighting warning is real but its overlap is 2 m2), wake foam, spray and mist (no particles: frozen 4.68 against 5.05), `oceanTime` and camera motion (frozen 4.68 of a moving 10.7 is the ripple floor), 480p point sampling (960 downscaled: 4.49), video encoding (lossless stills show the same 4.7 to 5.1).
- Not fixed: the engine has no knob for the ripples, so the clip still has the strobing. Round 4 only lowers the moving number by 18 percent with a workaround: render at 48 fps and blend pairs of frames to 24 fps (a wider shutter). A real fix needs an engine change (issue #2843), which alters every water look and needs look approval, so no PR was opened.
- Ship motion: heave 0.28 m, roll 1.7 degrees, pitch 1.1 degrees on periods of 4.2, 5.1 and 4.2 s (`translation` and `rotation` node tracks, keys every 0.25 s, smooth). The ship bobs in place; it does not sail, because the wake points are static and the emitters do not follow a moving node (#2829).
- Mid-water crop (left, 55 to 68 percent of the height) rose from 0.74 to 1.14 because the hull now moves through it.
- Still weak: the glitch itself (see above), mist faint, sails grey, the z-fighting warning between the two sea sheets remains.

## Round 5 (galleon-preview-5.png, galleon-preview-5.mp4, sheet5.png; builder preview/build-round5.mjs)

The sea uses the new water material control `ripples { strength, speed, windDirection }` (PR #2844, issue #2843): strength 0.15, speed 1, windDirection 0 (downwind with the ocean). The 48 fps blend workaround is gone: the clip is rendered at 24 fps directly. Ship bob from round 4 kept. 480x270, 24 fps, 6 s, COOK_DISABLE=1, engine build of branch 2843-water-ripple-control at e6ec7f16. Same `diff.py` and crops as round 4.

| Case | nearL mean / p99 | nearR mean / p99 |
|---|---|---|
| Frozen, default ripples (24 fps, no blend) | 4.35 / 23.5 | 4.23 / 23.6 |
| Frozen, ripples strength 0.25, wind-aligned | 1.78 / 10.7 | 2.26 / 11.9 |
| Frozen, ripples strength 0.15, wind-aligned | 1.24 / 8.1 | 1.63 / 9.0 |
| Round 4 clip (moving, 48 fps blended to 24) | 6.27 / 30.6 | 5.72 / 28.9 |
| Round 5 clip (moving, 24 fps, strength 0.15) | 4.77 / 35.2 | 4.17 / 29.2 |

- Frozen near-water mean is under 2 on both crops at strength 0.15 (measured); 0.25 passes on the left crop only (2.26 on the right), so I kept 0.15. One retune only.
- Moving near-water mean fell by about 24 percent left and 27 percent right against round 4. The p99 did not fall on the left (35.2 against 30.6): the remaining difference is camera motion, the ship's own heave, the wake and the particles, which the ripple control does not touch. Mid crop 1.31 against 1.14 and far 0.98 against 0.90 are the moving hull and the clip's own motion, within the noise of round 4.
- Not judged here: how the calmer water looks. Strength 0.15 lowers the sun-glint facets too, which is a look call for An.
