# Check a preview before review

Every look preview, still or clip, goes through `scripts/check-preview.mjs` before anyone is asked to judge it. The script measures the faults that a person spots at once but a picture-by-picture read misses:

| Check | Fails when | Typical cause |
| --- | --- | --- |
| `exposure` | Highlights are clipped, the darkest values sit high (washed out), or the frame is far brighter or darker than a path-traced reference of the same scene and camera | Missing sky occlusion or ambient occlusion, wrong exposure or tone mapping |
| `shimmer` | Blocks of the picture change shape between frames instead of moving with the camera or with the blocks around them | Texture aliasing (mip bias, anisotropy, UV scale), thin geometry without enough samples |
| `near-plane` | A large featureless area fills a frame, or appears or vanishes from one frame to the next | The camera path starts in or passes through a wall |

| `regions` | With a reference: one region of a 4 by 3 grid has low structural similarity, differs in patches once its brightness offset is removed, or is far brighter or darker | Stains baked into blotches, a roof or ceiling gone flat, stretched textures, a missing light |

With a reference it also prints the whole-frame structural similarity, and fails on it only when `--min-similarity` is given.

A near object moves faster than the background when the camera trucks past it. Each block is therefore also matched near the motion its neighbouring blocks share, found on a half-size copy, and a block on the object's outline may match part object, part background. A block never vouches for itself, so texels that sparkle on a moving object still fail.

## Run it

```sh
node scripts/check-preview.mjs preview.png --reference cook.png
node scripts/check-preview.mjs clip.mp4 --reference cook.png --at 1.5
```

- `--reference` is a Cook or Cycles still of the same scene and camera. Without one, exposure is judged on its own.
- `--at` is the time in seconds of the clip frame to compare with the reference; `--from` skips the start of a clip.
- `--frames` (240, ten seconds at 24 fps) caps how many consecutive frames of a clip are read; a shorter clip is read whole, and `--width` (640) is the size they are measured at.
- `--lossless <folder>` measures the numbered PNG frames in a folder (`render-media --kind stills --frames 0-71` on the same camera path) instead of the clip's decoded frames, so loss from the video encoder is not blamed on the renderer. The clip argument is still needed to name the result. On the classroom truck clip the shimmer check reads 1.0% on the clip as encoded before #3366 and 0.6% on both the lossless frames and the new clip.
- `--json` prints the measurements for a script.

PNG files are read directly. JPEG, WebP and clips need `ffmpeg` and `ffprobe` on the path.

Each check prints one line with `PASS` or `FAIL`, the measurements and a hint for each problem. The command exits 1 when a check fails and 2 when it cannot read its input.

```text
FAIL exposure: median 182.7, shadow 117.7, highlight 235, brightClippedPercent 0 | reference median 33.8, shadow 7.5, highlight 181, brightClippedPercent 0
  - the darkest 5% of pixels are still at 117.7 (limit 70): the frame is washed out, with no dark values
  - median 182.7 is 148.9 brighter than the reference 33.8 (limit 25)
```

## How the limits were set

The limits come from the realtime candidates rejected in #2755 and from clean controls made from Cook stills:

| Input | exposure | shimmer | near-plane |
| --- | --- | --- | --- |
| Monk realtime still (courtyard view) | fail: median 183, darkest 5% at 118 | | pass |
| Monk realtime still at the camera of its Cook still, which starts inside a wall | fail: median 224 | | fail: 100% featureless |
| Classroom realtime still against its Cook still (similarity 0.59) | pass: median 115 against 123 | | pass |
| Monk arcade and push clips | fail: darkest 5% at 119 | pass: 0.2 to 0.4% | pass |
| Classroom truck clip | pass | fail: 1.9%, lower left (chairs) | fail: 27% featureless at frame 0 against 10% typical |
| Cook still panned and zoomed without minifying | | pass: 0 to 0.2% | pass |
| Cook still zoomed while minified with bilinear sampling (aliased on purpose) | | fail: 1.5% | |
| Classroom mid clip, a truck past chairs near the lens | | fail: 1.0%; 6.0% before the neighbour search counted parallax | |
| The same clip rendered at twice the size and scaled down | | pass: 0.6% | |

The region limits come from the classroom hero camera, the one scene whose Cook still matches the realtime camera exactly:

| Input | worst region similarity | largest patchiness | largest brightness difference |
| --- | --- | --- | --- |
| Cook still against itself moved by one pixel | 0.88 | 9.8 | 0 |
| Cook still with blotches of plus or minus 15% over two regions | 1.0 | 17.2 | 0 |
| Classroom realtime still, rejected for a cold, flat ceiling and wall | 0.12 (top row) | 58 | 83 darker |

Limits: similarity at least 0.6, patchiness at most 25, brightness within 40 levels. A realtime still is never pixel-equal to a path-traced one, so these limits are wide; the pass side is set only from Cook controls until a realtime still of a matched camera is approved.

The functions behind each check are in `scripts/preview-checks.mjs` and work on plain luminance planes; `tests/check-preview.test.js` covers them with small synthetic frames.
