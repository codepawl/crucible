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

## Round 6 (galleon-preview-6.png, galleon-preview-6.mp4, sheet6.png, hull12-r5.png, hull12-r6.png; builder preview/build-round6.mjs)

An rejected round 5: the ship stands still, yet foam kept popping around the hull and the bow threw spray. Round 6 is a stationary ship: no wake, no spray and mist emitters, ripples strength 0.15 kept, the ship's bob kept, a thin static contact rim requested (`contactFoam` width 3, drift 0). Engine: branch 2843-water-ripple-control (#2844). 480x270, 24 fps, 6 s.

Cause, by toggling each source (fixed camera, 36 frames, hull crop 19 to 75 percent of the width and 63 to 84 percent of the height, mean / p99 grey difference per frame pair):

| Case | hull mean / p99 |
|---|---|
| Round 5 setup (wake 90 points, spray and mist emitters) | 6.53 / 60.4 |
| No wake | 3.92 / 32.2 |
| No particle emitters | 6.39 / 62.2 |
| Ocean `spray: false` | 6.53 / 60.4 (identical) |
| No wake, no particles | 2.95 / 20.4 |
| ... and ocean time frozen | 1.85 / 15.0 |
| Wake cut to 10 hull-ring points | 4.35 / 34.9 against 3.25 / 22.4 with none (draft 4.8) |

The popping foam is the ocean `wake` option (filed as #2849). The particle cards and the ocean `spray` flag add almost nothing at the hull. Ocean foam coverage -0.7 and the contact rim changed the number by less than 0.15.

Full clips (camera moving, 144 frames, same hull crop): round 5 6.89 / 66.1, round 6 3.49 / 23.1 (mean / p99). The remaining 3.5 is the ship's own bob, the camera move and the moving sea.

Things to know: without the wake's water lift (height 0.45) the sea near the ship sits lower, so the hull hung above the water at draft 3.9; round 6 uses draft 4.8 (1.5 m of hull under the mean waterline). The contact rim drew nothing visible on the imported hull at widths 3, 6 and 12 (commented on #2034), so the hull meets the water with no foam at all. Not judged here: how the dry-looking waterline reads, a look call for An.

## Round 7 (galleon-preview-7.png, galleon-preview-7.mp4, sheet7.png, hull12-r7.png; builder preview/build-round7.mjs)

An rejected rounds 5 and 6: round 5 still flickered, round 6 had no foam and the ship looked like it was sinking through the water.

Mesh verdict (measured on the GLB, keel at y 0): not a broken mesh. The hull is widest (half beam 4.29 m) 2 to 3 m above the keel, its flat bottom is 97 m2 facing down, and the main deck surfaces (57 to 106 m2 facing up) sit 4 to 6 m above the keel. About 5 percent of the hull's edges are open seams, none of it at the waterline band, and 34 of 110,616 faces wind against their normals. The sinking was the draft: round 6 used 4.8 m, which puts the mean waterline at the main deck, and the sea near the ship rises 1.3 m above and falls 1.3 m below its calm level (min -1.27, p5 -0.91, median -0.16, p95 0.53, max 1.33 over 0 to 6 s), so crests washed the deck. A hull at draft 6 shows only deck and rigging, draft 0 a hull floating above the sea.

Fix: draft 2.2 m (waterline about 2.5 m above the keel, at the widest part of the hull; main deck 1.5 m clear on average, crests plus the 0.36 m bob reach it only at the highest peaks).

Foam: the engine `contactFoam` rim still draws nothing on the imported hull (commented on #2034; at a grazing view the sea pixels beside a vertical hull never see the hull within the rim's 0.5 m gap). Round 7 paints a static band on the water instead: a `waterHook` on the sea material, in world space around the hull outline, noise fixed, no time term, no wake points, no spray, no particles. It rides the waves and cannot pop. No engine PR.

Numbers (480x270, 24 fps, 6 s, moving camera, hull crop as in round 6): hull mean / p99 frame difference 2.80 / 19.5 (round 6: 3.49 / 23.1). One-frame-only white pixels above 220 in the water: 3602 (round 6: 751). The increase is almost all in the 15-row bands at y 196 to 226 and the columns 96 to 240, the foam band, where its edge crosses grey 220 as waves slide under it. Round 7 first try: 4129. This is the open problem: the band is steady in the 12-frame tile but its edge shimmers at the threshold.

## Round 8 (galleon-preview-8.png, galleon-preview-8.mp4, sheet8.png, hull12-r8.png; builder preview/build-round8.mjs with preview/ship-follow.mjs)

Round 7 judged: no blinking, no spray, but the ship floated. Cause: the sea under the hull moves from -1.27 to +1.33 m while the ship stayed at one height. Round 8 bakes the ship's motion from the same ocean formula the sea mesh uses (`oceanWaves` and `seaHeightAt`, calm level 0.5 m): height is the mean of bow, middle and stern, smoothed over 0.5 s, with pitch from the bow-stern slope and roll from the port-starboard slope (gain 0.7, at most 5 degrees), keys every 0.1 s. Over the clip the smoothed height under the hull ranges -0.62 to +0.27 m, pitch up to 1.5 and roll up to 2.7 degrees. Waterline fixed at 3.2 m above the keel. No Crucible gap to file for reading the height: `src/physics-buoyancy.js` already floats bodies on an ocean (`seaHeightAt`); baking was chosen for a camera-only clip.

Foam: a `waterHook` band tied to the hull outline read from the GLB at the waterline (2.2 to 3.0 m above the keel; the hull there runs 14.4 m behind the middle to 10 m ahead, not the 34 m of the model with its bowsprit): 0.55 m on the sides, 1.3 m at bow and stern, outer edge broken by fixed cellular noise, opacity 0.6, a thin darker band (0.35 m) where hull meets water, no time term.

Numbers (hull crop as before): mean / p99 2.90 / 19.6 (round 7: 2.80 / 19.5). One-frame-only white pixels above 220: 608 (round 7: 3602, round 6: 751).

## Round 9 (galleon-preview-9.png at 960x540, galleon-preview-9.mp4, sheet9.png, hull12-r9.png; builder preview/build-round9.mjs, preview/ship-follow.mjs, measurement scripts in preview/r9/)

Round 8 read as floating: the green lower hull and its rounded bottom showed. Waterline sweep (height above the keel at which the ship floats, ship following the sea, 480x270 stills at 0 to 5 s from the clip camera):

| Waterline | Main deck (6 m) lowest clearance over the formula sea | Gun-deck floor (4 m) lowest clearance | Hull bottom, seen in the renders |
|---|---|---|---|
| 3.2 | +2.27 m | +0.27 m | green lower hull and its round bottom exposed in most frames |
| 3.8 | +1.67 m | -0.33 m (11 of 15 points under) | still exposed in frames at 0 and 1 s |
| 4.3 | +1.17 m | -0.83 m | hull sits on the water in every sampled frame |
| 4.8 | +0.67 m | -1.33 m | not rendered in the final pictures (ship-only pass only); deck rail nearly at the sea |

Chosen: 4.3 m. The renders, not the formula, decide it: the formula (`seaHeightAt` plus the 0.5 m calm level) says the lower hull is hidden already at 3.2 (1.4 percent of near-side lower-hull points seen, none below 3 m), but the pictures show it exposed, so the sea is drawn lower than the formula near the hull. Pole check (a thin red post standing in the sea, side camera, pole foot against the predicted water row): the rendered water is lower than predicted by 20 px (about 0.9 m) at x 3, z -12 at 0 s and 2 s, and by 0 to 6 px (0 to 0.25 m) at x -6, z -8 at 1, 3 and 5 s. Five samples, one fov assumption; not filed as an engine bug, a candidate for a proper check. The gun-deck floor at 4 m is inside the hull; the visible waist deck is the 6 m surface (65 m2, the largest). The image-mask version of the hull-visible count failed (the ship-only pass changes the whole lower frame), so the table's last column is read from pictures.

Foam: the flat painted band cannot reach 3 px at this camera (a 1 m flat band lies at about 5 degrees to the view, so it shows 1 px). Round 9 stands the foam up: flattened torus rings attached to the ship at its waterline, an ellipse of 12.3 by about 3.9 m fitted to the hull outline: a foam collar 0.9 m tall (fixed cell noise on the uv, opacity 0.7, colour 0.68 to stay under grey 220), a thin dark ring just under it for the contact shadow, and a thicker arc around the stem for the bow wave. The collar shows about 4 to 5 px tall at 480 width. The painted water band stays, narrower (0.8 m sides, 1.2 m ends). No time term anywhere.

Pitch and roll: gain 1.0, limit 4 degrees; over the clip up to 2.2 degrees pitch and 3.9 degrees roll.

Numbers (hull crop as before): mean / p99 3.50 / 23.6 (round 8: 2.90 / 19.6; the larger tilt moves the hull more). One-frame-only white pixels above 220: 814 (round 8: 608; first try with a brighter collar 1860).
