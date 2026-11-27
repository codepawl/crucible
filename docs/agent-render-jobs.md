# Render jobs

Release `0.6.0` includes five MCP tools for asynchronous image and video rendering.

## Agent workflow

1. Install `crucible` with `npm install crucible@npm:@codepawlhq/crucible@0.7.0`.
2. Launch `npx crucible-mcp --backend cpu --jobs C:/projects/my-scene/render-jobs`.
3. Create a scene and inspect its current revision.
4. Submit `scene_render_submit` with the session ID, current revision and render settings.
5. Poll `scene_render_status` until the job reaches a terminal state. The job tools take `jobId` alone; a `sessionId` is refused with that hint. A path traced job on the default cpu backend whose scene is estimated above twice 400000 triangles (the estimate can run 1.5 times high on non-indexed geometry) is refused at submit with the count, instead of failing after it started; a scene between the cap and that margin is checked exactly when the trace starts.
6. Read `scene_render_result` after completion to obtain output paths, and SHA-256 hashes with `response_format: "detailed"`. The answer attaches the PNGs of a job of up to 8 files (up to 1 MiB each) as images, whatever `response_format` is, and adds a resource link to each file; a job of more than 8 files attaches none, because a harness that keeps the transcript pays for every picture on each later turn. Pass `images: false` to get the paths, sizes and metrics only, or `images` as a list of up to 8 artifact indexes (counted from 0) to attach just those frames of a large job. Video is never attached.
7. Release unwanted outputs with `scene_render_release`.

For MP4 jobs, FFmpeg must be on PATH or configured with `--ffmpeg` and an absolute executable path.
The job store must be private, absolute and dedicated to this runtime.
The store records UUIDs that `scene_capabilities` lists after a restart.

Artifact publication checks that the opened file still matches the checked path before
hashing, and rejects linked artifacts or bytes changed during the read. On Windows,
a path stat can report device `0` while the opened handle reports a volume serial
(observed on Node 22.13.1). In that case the inode must still match. Reported device
mismatches remain errors on other platforms, and on Windows when the path device is nonzero.

```json
{
  "sessionId": "<session UUID>",
  "expectedRevision": 0,
  "settings": {
    "kind": "video", "width": 640, "height": 360,
    "fps": 24, "duration": 3,
    "animation": { "clip": 0, "start": 1 },
    "rendererTime": { "start": 0, "rate": 1 }
  }
}
```

The runtime captures the source recipe and verified asset bytes before returning a job ID.
The job uses a separate browser page and temporarily leases the single renderer.
While a job runs, these tools fail until it finishes or is cancelled: `scene_create`, `scene_create_asset`, `scene_apply`, `mesh_edit`, `mesh_stack`, `scene_look`, `scene_review`, `scene_checkpoint`, `scene_restore`, `scene_release_checkpoint`, `scene_export_glb`, `scene_export_web`, `scene_dispose` and `scene_render_submit`. Inspection (`scene_inspect`, `mesh_inspect`, `scene_walkmap`), `scene_export_recipe` and the `scene_render_*` status, cancel, result and release tools stay available. The error names the running job, how many frames it has done and the two tools to call: `scene_render_status` with its `jobId`, or `scene_render_cancel`.
The source revision, pose and checkpoints survive completion or cancellation.
Cancellation becomes terminal after the owned encoder and job page stop and the preview recovers.

An `image` job is one frame at `motion.start`, so it refuses `duration` and `fps` (they would change nothing); `stills` and `video` jobs read both. `stillCount` needs `stills` and `encoder` and `audio` need `video`.
Video uses H.264 (CPU by default, see `settings.encoder`), even dimensions and one streamed frame at a time.
With `settings.encoder` `nvenc`, MCP video frames are encoded in the page by the browser's hardware H.264 encoder in the same task as the draw, and only the encoded chunks travel to Node over one binary WebSocket on the preview server port, where `ffmpeg -c copy` muxes them with the audio (issue #301). Without NVENC, or when the browser cannot encode the size, frames are JPEG screenshots encoded by ffmpeg.
The encoder runs at H.264 quantizer 16 (`DEFAULT_PAGE_ENCODER_QUANTIZER`), and the stream is marked full range BT.709. Against the lossless frames of the same render, 640 by 360 clips reach 37.9 dB PSNR (RGB) and 1280 by 720 reach 39.1 dB at 1.5 to 1.7 times the file size of quantizer 20 (36.8 and 37.9 dB); 4:2:0 chroma caps any H.264 file near 39 to 40 dB.
PNG stills and render passes still use a DevTools screenshot, byte for byte as before.
`metrics.captureSeconds` and `metrics.renderSeconds` report the two costs, and `metrics.videoEncoder` is `browser-h264`, `h264_nvenc` or `libx264`. On the 4,488 frame film at 1280 by 720 on an RTX 3060 (loaded machine, one evening), in-page encoding took 20.6 s in all with 2.2 ms a frame of capture and 2.0 ms of draw, screenshots took 139.6 s (25.1 ms a frame of capture) and reading raw pixels over a WebSocket took 405.1 s (84.8 ms a frame), so pixels never travel to Node.
The render backend can use GPU or CPU. Memory limits can reduce the actual output dimensions.
Results report actual dimensions and measured timings. They do not embed video bytes.

Release `0.8.0` also samples imported character tracks and can layer them over an independently sampled imported clip.

Release `0.7.0` samples recipe-owned [procedural motion](agent-motion.md) with `settings.motion: { start: 0 }`.
Job frames use `start + elapsed`. Omission holds the initial motion pose.
Nonlooping samples must fit the motion duration. Looping samples wrap and remain bounded by 3600 absolute seconds.

Creation and edits author tracks through scene recipes and `set-motion`, before job submission.
Static recipes remain static unless a shader uses renderer time.
Imported clips retain separate absolute sampling through `settings.animation`.

## Timeline, audio and encoder

A recipe `timeline` plays shots one after another over the recipe's motion clock. It is small on purpose: the video sequence
editor is a non-goal of the engine (`docs/goal.md`), so there are no layers, overlaps, trimming or crossfades. Shots cut, or dip through black.

```json
{ "timeline": { "shots": [
  { "name": "wide", "duration": 20, "camera": { "eye": [0, 3, 14], "target": [0, 0, 0] } },
  { "name": "close", "duration": 20, "motionStart": 1, "camera": { "eye": [0, 0.6, 2.4], "fov": 50 } },
  { "name": "dusk", "duration": 20, "dip": 1 }
] } }
```

| Shot field | Meaning |
| --- | --- |
| `name` | 1 to 24 letters, digits, `-` or `_`, unique. Job metrics list shots by name with their start second. |
| `duration` | 0.1 to 30 s. The timeline holds up to 64 shots and 60 s. |
| `endAt` | A marker name (see below) in place of `duration`: the shot ends at that cue, so `duration` is the marker time minus the shot start. Both may be set only when they agree. |
| `motionStart` | Second of the motion clock the shot starts at. Omitted, the shot reads the motion at its place on the timeline, so a non-looping motion must cover it. Only for recipes with motion, physics or cloth. |
| `camera` | A partial camera (`eye`, `target`, `up`, `fov`, `near`, `far`) on top of the sampled camera. Omitted, the shot keeps the camera of the motion tracks. |
| `focusDistance`, `blur` | Depth of field for this shot: focus distance 0.01 to 100000 m and blur 0 to 1. Each is optional and replaces the recipe `effects.depthOfField` value for the shot only, so a close-up can pull focus without a global setting. A seek into a shot gives the same bytes as the frame in a sequence. |
| `dip` | 0.05 to 4 s. The previous shot fades to black over the first half and this one fades up over the second half. |

### Markers

The timeline names cue times in timeline seconds, so cuts can sit on the beat of a score you already have. `markers` is a list of `{ name, time }` (names as for shots, up to 256 markers, times 0 to 60 s). `beatGrid: { bpm, offset, count }` adds the markers `beat-0`, `beat-1` ... at `offset + index * 60 / bpm` seconds (`bpm` 1 to 400, `offset` default 0, `count` a whole number up to 256). A shot with `endAt` ends at its marker; the marker must lie after the shot start by the shot minimum and maximum. Crucible does not detect beats in an audio file: give it the bpm and offset, or the cue times.

```json
{ "timeline": { "beatGrid": { "bpm": 120, "count": 8 }, "shots": [
  { "name": "wide", "endAt": "beat-2" },
  { "name": "close", "endAt": "beat-4", "camera": { "fov": 30 } }
] } }
```

`set-timeline` edits the section and `null` removes it. A job renders it with `settings.timeline: { start }` (default 0) for kind `image`, `stills` or `video`.
`duration` defaults to the rest of the timeline. The timeline owns the motion clock, so `motion` and `animation` settings are rejected, and the renderer clock reads timeline time.
Imported assets have no timeline.

A frame depends only on its timeline time and keeps no state, so a seek to any time gives the same pixels as that frame inside a video or stills run.
Videos are capped at 60 s and 900 frames, so a 60 s video needs 15 fps or less. `scene_capabilities` jobs reports the caps as `maximumFps` (60) and `maximumFrames` (900), the same constants the job validator uses.

**Audio.** Start the server with `--audio <absolute folder>` and pass `settings.audio: { file, offset }` on a video job.
`file` is a plain name in that folder of letters, digits, `.`, `_` or `-` (up to 64 characters, starting with a letter or digit) ending in a lower-case `.wav`, `.mp3`, `.ogg` or `.flac`, so `Score.WAV` and `my score.wav` are refused (no path, drive or protocol syntax); the file must be a regular file of up to 32 MiB without links.
`offset` starts the sound that many seconds into the file. The sound is resampled to 48 kHz and encoded as AAC.
A job whose file is shorter than the video after its offset fails before rendering. After encoding, the job decodes both streams of the MP4 and reports `metrics.sync`
(`videoSeconds`, `audioSeconds`, `differenceSeconds`); a difference over 50 ms fails the job.
The `render-media` script applies the same rule to `--audio`: a sound shorter than the video after its start fails before the first frame instead of cutting the video (the error names the file and what to change; the check allows 10 ms, the precision ffmpeg prints). An offset is sent to ffmpeg as a plain decimal with six places, so `1e-7` counts as `0`. The encoder pads the sound with silence and cuts the file at exactly `frameCount / fps`, so AAC and PCM parts both end with the picture, and `render-media` fails when the finished video has no audio stream or its audio differs from the picture by more than 50 ms. With `--kind stills`, the 8 stills are `frame-0` to `frame-7` (`.png`, or `.jpg` with `--capture jpeg`) in the folder that holds `--output`; the file name part of `--output` is used only for the report, `<output>.json`. For `--kind video`, a height or width derived from the other one is rounded to an even number (`--width 1000` renders 1000x562).

### A scene file as a numbered frame range (#3233)

```sh
npm run render -- --scene file --config scene.json --camera camera.json --kind stills --fps 30 --frames 0-89 --width 1080 --height 1920 --output out/shot.png
```

`--frames FIRST-LAST` (both included, or one number) writes one PNG per frame into the folder that holds `--output`: `frame-0000.png` to `frame-0089.png`, padded to four digits or to the width of the last number, `.jpg` with `--capture jpeg`. Frame `n` is drawn at exactly `n / fps` seconds, so a range split over several runs matches one long run. It needs `--kind stills`, refuses `--start`, `--time` and `--duration` (the range sets the times), takes at most 3600 frames per run, and fails before the first frame when the last frame lies past the end of the camera track. Without `--frames`, `--kind stills` still writes the 8 stills. The report `<output>.json` lists `frames: { first, last, count, millisecondsPerFrame }`.

Motion blur comes from the scene file's `frame`, the same fields as the recipe look:

```json
{ "frame": { "effects": { "motionBlur": { "shutter": 0.1, "objects": 1 } } } }
```

`shutter` (0 to 0.5 seconds) smears camera motion from the `--camera` track, sampled at `time - shutter`. `objects` (0 to 1) also smears each moving part of the GLB's first animation clip, posed at `time - shutter` and at `time`; parts move rigidly, so a skinned part blurs only by its node transform. Frame 0 has nothing before it and is sharp. A scene file without `motionBlur` loads none of this. Two runs of the same range on the same machine give identical PNG hashes (`tests/render-media-frame-range-chrome.test.js`).
ffmpeg only receives the resolved path with `-protocol_whitelist file`; no URL, argument or output path comes from the agent.

### Batch rendering with `--batch` (#3520)

```sh
npm run render -- --batch shots.json --backend gpu
```

`--batch <manifest.json>` renders 1 to 500 shots sequentially inside one Vite server and one Chromium browser, opening and closing a fresh page per shot so WebGL contexts and routes never leak while avoiding per-shot startup overhead.

- **Manifest shape:** either an array of shot objects (`[ { ... }, ... ]`) or `{ "defaults": { ... }, "shots": [ { ... }, ... ] }`. Both kebab-case (`jpeg-quality`) and camelCase (`jpegQuality`) keys are accepted.
- **Defaults precedence:** shared CLI flags (`--backend`, `--preset`, `--width`, `--height`, `--fps`, `--aspect`, `--memory`, `--encoder`, `--capture`, `--jpeg-quality`, `--root`, `--kind`, `--scene`, `--assembly`) are overridden by `manifest.defaults`, which are overridden by each shot. All shots in a batch must share one `--backend` (`gpu` or `cpu`).
- **Per-shot flags:** `--batch` refuses single-shot target flags (`--output`, `--config`, `--camera`, `--asset`, `--time`, `--frames`, `--start`, `--duration`, `--audio`) on the command line. Every shot must specify a distinct `output` path.
- **Output:** each shot writes its media files and `<output>.json` report just like single-shot mode, and the command prints and returns `{ batch: true, totalShots, startupSeconds, elapsedSeconds, shots }`.

**Joining parts.** A film longer than one job (60 s, 900 frames) is rendered as several video jobs. Do not join AAC parts: each carries encoder priming and padding, which leaves a dropout of about 5 ms at every join (issue #389).
Give every part `audio: { file, offset, track: 'pcm' }` (`offset` = the part's start in the sound), which writes lossless audio with no priming. Then copy the video of the parts and lay the sound once:

```
ffmpeg -f concat -safe 0 -i parts.txt -c copy joined.mp4
ffmpeg -i joined.mp4 -map 0:v -map 0:a -c:v copy -c:a aac -b:a 192k film.mp4
```

Or skip the sound in the parts' join and lay the source file instead: `ffmpeg -i joined.mp4 -i score.wav -map 0:v -map 1:a -c:v copy -c:a aac -shortest film.mp4`.

**Encoder.** `settings.encoder` is `cpu` (libx264, default) or `nvenc` (h264_nvenc). A machine without NVENC fails the job with the ffmpeg error and never falls back.

`npm run smoke:film-timeline` proves it through MCP on SwiftShader (`cpu` backend): 9 PNG seeks over 8 stills across three shots and a dip are identical to the byte,
and a click placed on a cut in a WAV lands on the decoded cut frame within a frame. `FILM_SECONDS=60` renders the 60 s case.

## Render passes

`scene_look` draws one of these as a quick check, without a job: see [Channel views](#channel-views-in-scene_look).

`image` and `stills` jobs accept `settings.passes`, a list of `albedo`, `normal`, `emission`, `depth`, `objectId`, `diffuse`, `glossy`, `shadow`, `ao`, `mist`, `position`, `velocity`, `uv`, `transmission`, `volume`, `environment`, `cryptomatte`, `aov`, `roughness`, `metallic`, `lighting` and `wireframe`.
Each frame writes its lit image and then one PNG per pass: `render.png` and `render-<pass>.png` for an image, `frame-N.png` and `frame-N-<pass>.png` for stills.
Passes are raw data at the lit image's size: no tone mapping, grading, bloom, depth of field or antialiasing, so values stay exact at silhouettes.
Only opaque and cutout geometry appears. Liquid, foam and blended parts, the sky and the environment background do not.

| Pass | Pixel value |
| --- | --- |
| `albedo` | Base colour after maps and vertex colour, as stored |
| `normal` | World-space normal after normal maps, `normal * 0.5 + 0.5` |
| `emission` | Emissive colour times strength (an 8-bit pass clamps it at 1, an `exr` float pass keeps the whole value) |
| `depth` | Metres from the camera over 100 m as a 16-bit value, high byte in red and low byte in green. Background is `255, 255, 0` |
| `objectId` | 24-bit ID, low byte in red, then green, then blue. Zero is background |
| `diffuse` | Linear diffuse light (every light, sky and bounce) times exposure, before fog and without emission. Background 0 |
| `glossy` | Linear specular light (each light's lobe and the sky reflection) times exposure, before fog. Background 0 |
| `shadow` | Sun shadow visibility, 1 lit and 0 shadowed. Background 1 |
| `ao` | Ambient occlusion the shader applies (occlusion map, vertex sky visibility, room term). Background 1 |
| `mist` | Fog amount `1 - exp(-distance * fogDensity)`. Background 1 |
| `position` | World-space XYZ in metres (float in `exr`, mapped over `±100 m` into `0..1` in `png` and `png16`). Background 0 |
| `velocity` | Screen-space motion vector `(dx, dy)` in normalized screen coordinates from camera and object motion (signed in `exr`, `vel * 0.5 + 0.5` in `png` and `png16`). Background 0 |
| `uv` | Primary texture coordinate `(U, V)` in red and green (`U, V` channels in `exr`). Background 0 |
| `transmission` | Transmitted light for materials with `transmission > 0`, scaled by `transmissionMap`. Background 0 |
| `volume` | Volumetric / fog scattering contribution along the view ray. Background 0 |
| `environment` | Image-based / sky environment lighting contribution times exposure. Background 0 |
| `cryptomatte` | Deterministic float hash per object in red, per material in green and coverage `1` in blue (`metrics.cryptomatte` holds the `{ objects, materials }` manifest). Background 0 |
| `aov` | Custom material AOV from `material.aov` (`0..1` scalar or RGB) and/or a material graph's `aov` output. Background 0 |
| `roughness` | Roughness after maps, wear and specular antialiasing, as grey. Background 0 |
| `metallic` | Metallic after maps and wear, as grey. Background 0 |
| `lighting` | The `diffuse` light on a white, non-metal surface: lighting only, with no albedo, texture or metal tint. Background 0 |
| `wireframe` | The `diffuse` surface with every polygon edge drawn over it, for reviewing topology; see below. Background light grey |

### Channel views in scene_look

`scene_look` takes `view`: `beauty` (the default, the lit image, unchanged), `albedo`, `normal`, `roughness`, `metallic`, `ao` or `lighting`. Any other name is an error that lists the valid ones.
A view draws the render pass of the same name into the preview PNG, so the values are the linear ones in the table above, and the metadata says which `view` it drew. The exposure findings read the lit frame, so a view leaves them out; labels still draw.
`scene_look` always draws on the raster renderer, so there is no path traced view and no fallback to note. A job's `renderer: "native"` writes the lit image only, as in [Path tracer](#path-tracer).
The `lookViews` topic of `scene_capabilities` lists the names.

### Wireframe pass

The wireframe pass shows the topology of the mesh a part really has, without changing its geometry or vertex count. It draws the polygon edges of each part (a recipe mesh's own quads and n-gons, or the welded, quad-joined view of other geometry, the same view `mesh_inspect` reads), so the diagonals that triangulation adds inside a planar quad are never drawn and a quad reads as a quad. Edges hidden behind a surface stay hidden.

| Edge colour | Meaning | `mesh_inspect` problem |
| --- | --- | --- |
| dark | Regular edge: two faces, wound the same way round it | |
| orange | Boundary edge: one face, an open rim | `boundary-edge` |
| red | Non-manifold edge: three or more faces | `non-manifold-edge` |
| cyan | Flipped edge: two faces that run the same way along it, so one normal points the wrong way | `inconsistent-winding` |
| magenta | Edge of a degenerate (zero-area) face | `degenerate-face` |

Fault edges are drawn about twice as wide as regular ones. An edge with several faults shows the most urgent one: non-manifold, then degenerate, then flipped, then boundary.
The job metrics carry `metrics.wireframe`: `edges` (the count of each kind over the drawn parts), `faultyParts` (up to 20 parts, worst first, each with its fault counts so a coloured edge maps to a node name), `faultyPartsOmitted`, `partsOmitted` and `partsSkipped`, and `truncated`.
Output is bounded: a mesh contributes at most 200,000 edges and a frame at most 1,000,000. Fault edges are kept before regular ones, a part past the frame limit is left out and counted in `partsOmitted`, and a part with no polygon view (every triangle collapses) is counted in `partsSkipped`.
The pass is 8-bit like the others, works with `png16` and `exr` and packs into a `multilayer` EXR. It shows rest geometry: skinning and morph targets are not applied to the edges.

#### Use the pass from the library

`import { withWireframe } from '@codepawlhq/crucible/addons/wireframe-pass'` draws the same edges for a renderer you drive yourself: `withWireframe(renderer, renderFrame, options)` runs `renderFrame`, which must draw one `wireframe` pass frame, and returns the report above. The render jobs always use the defaults.

| Option | Default | Effect |
| --- | --- | --- |
| `faults` | `true` | `false` draws boundary, non-manifold, flipped and degenerate edges as regular edges, for a film or a showcase where a model with split edges should not look broken. The report still counts them |
| `color` | `[0.06, 0.07, 0.09]` | Three numbers from 0 to 1: the colour of regular edges, and of every edge when `faults` is `false` |
| `halfWidth` | `0.7` | Half the line width in pixels, above 0 and at most 32, with the same reach as `color` |

The lighting passes hold linear values above 1, so write them as `exr` (a `png` or `png16` file clamps at 1). They add back to the lit image: `diffuse + glossy + emission * exposure` is the radiance before fog, and with an open world the lit image is that radiance mixed toward the fog colour by `mist`, then tone mapped. `tests/lighting-passes.test.js` checks the sum against the beauty frame (mean difference under 1.5 display levels, under 2% of samples off by more than 4). Not covered: unlit parts, the editor floor, parts that a probe or irradiance grid changes after the sky term, and anything the lit image adds after the shader (bloom, grading, depth of field).

`scene_render_result` metrics carry `objectNames`, the part name for ID 1, 2 and so on (the first 1000, with `objectNamesTruncated`), `objectNodes` (`{ "<node id>": [ids] }`: a placed asset with five parts is one node owning five IDs; the first 1000 nodes, with `objectNodesTruncated`), and `depthRangeMetres`.
IDs follow draw order, which groups parts by shared geometry, so read the names list and not node order.
Videos hold the lit image only.

A seek to any frame gives the same pixels: a job samples each frame from its time and keeps no state between frames.
`npm run smoke:render-passes` proves it through MCP: it renders eight stills with every pass, then renders frame 3 again as an image in a different order of seeks and compares the bytes of the lit image and all five passes.

### ID mattes

`settings.mattes` on an `image` or `stills` job writes one gray PNG per entry next to the lit image: `render-matte-<n>.png` (`frame-N-matte-<n>.png` for stills), where `<n>` is the entry's position. A pixel is white where the named part is drawn and black elsewhere.

```json
{ "kind": "image", "width": 1280, "height": 720, "mattes": [{ "object": "hero" }, { "material": "stone" }] }
```

Each entry names exactly one `object` (a part name from `metrics.objectNames`) or one `material` (a name from `metrics.cryptomatte.materials`), up to 8 entries and 120 characters a name. An object matte is read from the exact 24-bit object ID, so a part that other parts overlap still gets its own clean edge. A part with a `blend` material (tree leaves exported as BLEND) is in the ID passes too, drawn as a cutout where its alpha is at least 0.5, so its see-through texels leave the part behind it visible. A material matte is read from the `cryptomatte` pass, whose hash has 255 values: two materials can share one, and then `metrics.mattes[n].sharedWith` lists the other names and the matte holds both. A name the scene does not have fails the job with the list of names it does have.
`metrics.mattes` holds `{ object, partIds, coveragePixels }` or `{ material, sharedWith?, coveragePixels }` for each entry, from the last frame. Mattes are 8-bit PNG: they need `format` png, no `multilayer` and no `renderer`, and they cost about one extra pass each in the job estimate.

### Combining pass pixels

`src/pass-compositing.js` holds the pixel steps that put passes together. They work on plain RGBA8 buffers (top row first, up to 3840x2160) with integer math, so the same input gives the same bytes on every machine, and each throws an error that says which buffer to pass instead.

| Function | Result |
| --- | --- |
| `zCombine({ width, height, colorA, depthA, colorB, depthB })` | Per pixel, the colour and depth of the nearer input; a tie keeps A. Returns `{ color, depth, nearest }`. `depthMetresFromPass` reads a depth pass into the metres these take, and a background pixel reads `Infinity`, so it never wins. |
| `alphaOver({ width, height, foreground, background })` | The foreground over the background, straight alpha in and out, each channel rounded to the nearest byte. |
| `objectIdMatte`, `cryptomatteMatte` | The 0 or 255 masks behind `settings.mattes`, from an object ID pass or from the red (object) or green (material) channel of a Cryptomatte pass. |
| `applyMatteAsAlpha({ width, height, color, mask })` | A colour buffer with the mask as its alpha: the cut-out of a part, ready for `alphaOver`. |

These are library functions for scripts and addons; no MCP tool combines passes yet, and `scene_render_submit` reads no image from disk.

## Output options: transparent, 16-bit PNG, EXR, region and 60 fps

### A transparent frame sequence {since 0.21.0}

A `stills` job with `stillCount: N` (2 to 300) writes N numbered PNGs, `frame-0.png` to `frame-<N-1>.png`, instead of 8 spread over `duration`. Frame i samples the motion clock at `i / fps` seconds from `motion.start` (or the timeline start), the same instants a video of that `fps` would show. `duration` is then `(stillCount - 1) / fps` and is left out. With `transparent: true` each frame is an RGBA PNG, so the sequence composites over other footage. A longer clip is rendered in parts: submit the next job with `motion.start` advanced by `stillCount / fps`. The combined output stays under 128 MiB per job (`scene_capabilities` jobs: `maximumOutputBytes`). Each submit result estimates `outputMiB` and refuses oversized sequences with the frame count that fits. If a rendered sequence still overflows at finalization, the controller keeps its leading complete frames for `scene_render_result`. A square frame fits up to 1440x1440 for stills and video and 2880x2880 for an image job (`scene_capabilities` jobs: `maximumSquareSequenceSide`, `maximumSquareSide`).

Four optional settings, each off by default. A job without them writes the same bytes as before.

| Setting | Meaning |
| --- | --- |
| `transparent: true` | `image` and `stills`: the lit image keeps alpha (a PNG of colour type 6). The sky, the environment background and the automatic ground are not drawn, so give the scene its own ground or a `shadowCatcher` node (see `renderFlags` in `scene_capabilities`). Volume fog is refused. Passes ignore it. |
| `format` | `image` and `stills`: `png` (8-bit, default), `png16` or `exr`. The lit image is drawn into a half-float target and read back, so the file holds the same graded display colour as the 8-bit PNG (within one 8-bit step) with 16-bit steps. |
| `multilayer: true` | With `format: "exr"` and `passes`: writes one OpenEXR file per frame (`render.exr` or `frame-N.exr`) containing `Combined.R/G/B(/A)` and `<pass>.<channel>` for every requested pass (`depth.Z`, `objectId.id`, `position.X/Y/Z`, `velocity.X/Y`, `uv.U/V`, `<pass>.R/G/B`). |
| `region: { x, y, width, height }` | Pixels from the top left, each side at least 16. The frame is rendered whole and the crop is kept, so the look is the same as the full frame. Works for `image`, `stills` and `video` (a video region has even sides). Not with `renderer`. |
| `fps` | Up to 60 for video, within the 900 frame limit. |

`png16` writes `render.png` (RGB, or RGBA with `transparent`; alpha is straight) and one PNG per pass. A depth pass is a 16-bit gray PNG holding the raw step 0 to 65535 over 100 m, an `objectId` pass is a 16-bit gray PNG of the ID (a scene with more than 65535 objects fails: use `exr`), and `albedo`, `normal` and `emission` are 16-bit RGB with the same values as the 8-bit pass.
`exr` writes `render.exr` (half-float R, G, B and A when transparent; alpha stays premultiplied) and `render-<pass>.exr`. `depth` is one float32 channel `Z` in metres (the far limit, 100, is background), `objectId` one float32 channel `id` (0 is background), and `albedo`, `normal` and `emission` are half-float RGB. Files use ZIP compression and open in Blender, Nuke and OpenEXR tools.
Passes in these formats are drawn into half-float targets, so albedo, normal and emission carry half-float precision, not the 8 bits of the default passes.
Every screenshot frame is clipped to the requested size, and an image or still whose PNG comes back at another size fails with both sizes in the message instead of returning a cropped picture (#3120).

The path tracer writes an 8-bit PNG of the whole frame: `transparent`, `format` and `region` are refused with `renderer`. H.264 has no alpha, so `transparent` and `format` are refused for video. 16-bit and EXR output need `EXT_color_buffer_float`; without it the job fails with a message that says to use `png`.
A `png16` or `exr` frame is up to four times the 8-bit frame limit (48 MiB). A region with the browser H.264 encoder (`encoder: "nvenc"`) uses screenshot frames instead.

## Icons

`kind: "icons"` renders a set of GLBs as matching transparent square icons in one job, for inventories, asset browsers and docs. It is a job kind of `scene_render_submit`, so status, result and release work as for any job. The scene you submit it with is not drawn (any open scene will do, for instance an empty one).

```json
{ "kind": "icons", "items": ["sword.glb", "chest.glb", "coin.glb"], "size": 256, "style": "toon", "scale": "relative" }
```

| Field | Meaning |
| --- | --- |
| `items` | 1 to 256 catalog GLB names (as `scene_asset_catalog` lists them, inside `--assets` or `--packs`) or 64 character asset ids. Names are pinned to their asset id at submit. No paths outside the catalog and no URLs. |
| `size` | 64, 128, 256 (default) or 512 pixels per icon side. The atlas side is at most 4096 px, so 512 takes up to 64 single-angle items. |
| `style` | `clean` (default, the shaded render), `toon` (outlines and three light bands, from [line art](line-art.md)) or `sketch` (ink outline, pencil hatching that follows the light, paper fill; see below). |
| `viewpoint` | `"three-quarter"` (default: azimuth 35, elevation 25 degrees) or `{ azimuth, elevation }` in degrees, from the front of the model (+Z in glTF). |
| `scale` | `fit` (default): every item fills its icon. `relative`: one view height for the set, so the largest item fills its icon and a sword stays smaller than a chest. |
| `padding` | The empty border as a fraction of the icon side, 0.02 to 0.4 (default 0.08), the same for every item. |
| `angles` | 1 (default), 4 or 8: a turnaround per item, with that many views spaced evenly round the model starting at the viewpoint azimuth. The atlas gets one row per item and one column per angle. Items times `angles` is at most 256 and `angles` times `size` at most 4096. Each item keeps one view height across its views (under `relative`, the whole set shares one). |
| `breakdown` | `true` (sketch only): per item, a strip of four steps (shaded, outline, hatching, final) drawn from the camera of the item's first view. |
| `seed` | 0 to 65535 (sketch only, default 0): the line wobble. The same items, settings and seed give the same bytes. |
| `sketch` | `{ inkColor, paperColor, hatchDensity, jitter }` (sketch only): ink `#rrggbb` (default `#2b2a33`), paper `#rrggbb` (`#f4ecd8`), hatch density 0.5 to 2 (1) and line jitter 0 to 1 (0.35). |

The camera is orthographic, so an item's size does not depend on its distance, and the light is a fixed three-point rig that turns with the view, so every icon is lit from the same side. There is no ground and no sky: the background is transparent (a sketch icon is filled with its paper colour where the model is).

Framing fits the silhouette, not the bounding sphere. The job draws the item once from a bounding sphere, measures the alpha box of what was drawn and moves the camera until that box is centred and spans the icon minus its padding (up to four draws per item). A thin or flat item such as a sword or a coin therefore fills its icon instead of drawing small. An item that draws nothing, or cannot be framed in four draws, fails the job and names the item.

### The sketch style

Sketch is a [user pass](user-passes.md) on the shaded frame, so it has the same scene, camera and framing as the other styles. It inks the outline from the silhouette, the depth steps and the creases, hatches the shadow with pencil lines in three directions chosen by how dark the light is, and fills the model with paper. Hatch spacing is laid out in whole pixels (3 px at 64, growing with the icon) so the lines do not beat against the pixel grid. A test renders a model at 64 px and checks that the sketch stays a line pattern: the outline is inked along at least 95 percent of the silhouette, and in the hatched band at least 80 percent of the pixels are clearly paper or ink, not grey, with a contrast of at least 0.7 of the ink to paper range. [Icon sheets](https://github.com/codepawl/crucible/blob/main/docs/learn/icon-sheets.md) (the docs guide page) shows the three styles and a breakdown.

Output, all in the job's folder: `icon-0.png` to `icon-<n-1>.png` (one per frame, items first and then angles), `breakdown-<item>.png` (one strip per item, with `breakdown`), `atlas.png` (a near square grid, row by row, transparent where unused) and `icons.json`:

```json
{ "version": 1, "size": 256, "style": "toon", "scale": "relative", "padding": 0.08, "viewpoint": { "azimuth": 35, "elevation": 25 },
  "atlas": { "file": "atlas.png", "width": 512, "height": 512, "columns": 2, "rows": 2 },
  "icons": [{ "name": "sword", "file": "icon-0.png", "source": "sword.glb", "asset": "<id>", "item": 0, "turn": 0, "angle": 35, "breakdown": "breakdown-0.png",
    "rect": { "x": 0, "y": 0, "width": 256, "height": 256 }, "bounds": { "x": 70, "y": 21, "width": 116, "height": 214 }, "viewHeight": 2.1 }] }
```

A sketch job adds `angles`, `seed` and `sketch` at the top level. `item` is the item's index, `turn` the view's index and `angle` its azimuth in degrees; `breakdown` names the item's strip and appears on its first view only. `rect` is the icon's cell in the atlas, `bounds` the box of its pixels inside the icon, and `viewHeight` the metres the icon's height spans. The JSON is plain, so Godot, Unity, Phaser and web code read it without a converter. The same items and settings give byte-identical files on the `cpu` backend.

Not in this release: HDRI lighting, `background` and `outline` (issue #2031; each is refused by name), and scene node ids as items. The job's deadline grows with the frame count: about 4 s per frame (twice when the scale is shared across views) and 6 s per breakdown strip. `scene_capabilities` topic `jobs` lists the limits under `icons`. `node scripts/smoke-icons.mjs --assets <folder> --out <folder> --style toon` renders a folder of GLBs and checks every icon's frame.

## Path tracer

An `image`, `stills` or `video` job can ask for the offline [path tracer](https://github.com/codepawl/crucible/blob/main/docs/path-tracer.md) with `settings.renderer`:

```json
{ "kind": "image", "width": 960, "height": 540,
  "renderer": { "type": "pathTracer", "backend": "gpu", "samples": 64, "bounces": 8, "denoise": true, "seed": 0, "maxSeconds": 120 } }
```

Every field after `type` is optional. `denoise: true` (the default) and the `final` quality tier use OIDN when its binary is installed (`npx crucible-oidn-fetch`), and the wavelet filter with a `denoiserNote` when not; the `samples` you asked for stay. `backend` is `cpu` (the default, byte-identical on SwiftShader smokes), `gpu`, which traces in a WebGL2 shader and needs a runtime started on the GPU backend (a `--backend cpu` runtime refuses it at `scene_render_submit`, before the job is queued), or `native`, which traces on hardware ray queries (Vulkan) through the optional `@codepawlhq/cook` package. A native job exports the scene from the job page, traces it in the job runner with the Cycles-matching kernel (`JS67_NATIVE_KERNEL=legacy` keeps the older one), then denoises (OIDN runs on a device kept alive between frames when the OIDN library is installed, so only the first frame pays for the device and the filter commit; `metrics.pathTracer.oidnMode` says `in-process` or `cli`) and writes the PNG as the other backends do: `denoise: true` means OIDN with the albedo and normal guides when its binary is installed (`npx crucible-oidn-fetch`), else (or when OIDN fails) the GPU a-trous filter of the native tracer with a note in `metrics.pathTracer.denoiserNote` (`denoiser: "atrous"`; it is biased, it smooths; `denoise: "wavelet"` asks for the CPU filter). The report carries `kernel` and `averageSamples`. The Cycles-matching kernel takes up to 4,000,000 unique triangles (copies of a shared mesh count once, and the scene may hold four times that with every copy counted); the job reads the scene from its page as one Blob over the DevTools stream (about half the time of returning it as base64, and no single message bounds it); from the second frame of a `stills` or `video` job the page sends only the table bytes that changed since the frame before (a scene with moving particles sends the particles, not the static meshes; a table that changed length sends the changes in the bytes it shares with the old one and the new tail), the job rebuilds the same tables from them, and `metrics.pathTracer.exportSentBytes` says how many bytes crossed (`JS67_NATIVE_EXPORT_DELTA=off` reads every table whole); the `cpu` backend and the older kernel keep 400,000, and the `gpu` backend takes what the page's WebGL2 context holds, up to 2,000,000 (see [path-tracer.md](https://github.com/codepawl/crucible/blob/main/docs/path-tracer.md)). A larger scene is refused with an error that names the limit. On the Cycles-matching kernel the job sends each material whole (FORMAT-v2 tables, instanced or not): blend opacity (`alphaMode: "blend"` with `opacity` below 1), sheen, `specular` and `specularColor`, anisotropy, iridescence, attenuation, and the clearcoat, transmission, sheen, anisotropy and coat normal maps all reach the kernel, and `metrics.pathTracer.ignored` lists only what it does not shade (the legacy kernel keeps the v1 tables and the old notes). A scene whose materials cannot be exported whole is traced from the v1 tables for that frame with the reason in `materialsReason`; the native tracer stays usable. It never fails for lack of the package: without it, without its built binary or without a Vulkan ray query adapter the job runs on `gpu` (`cpu` on a cpu runtime) and `metrics.pathTracer.backendNote` says why; `metrics.pathTracer.backend` always names what ran. The look up costs one import and is cached per process. Native traces volume fog and subsurface scattering with the same walk as the WebGPU megakernel, honours `maxSeconds`, and honours `noiseThreshold` on the GPU (after 16 samples, and then every 8, a converged pixel draws no more; `report.averageSamples` is the mean a pixel drew). The `gpu` fallback ignores `noiseThreshold`. The report in `metrics.pathTracer` names the `backend` that ran, the `gpu`, `gpuCompileSeconds` and `gpuKernelCompiles`. A `stills` or `video` job traces every frame with the same options: the kernel compiles once per job page and each frame reuses it, so a film shows `gpuKernelCompiles: 1`. A native `stills` or `video` job (the Cycles-matching kernel) also keeps one native session for the whole job: a frame that only moves the camera reuses the uploaded scene, the compiled kernel and the acceleration structures; changed materials, lights, instance transforms or triangles (the table may change length) are sent to the session, which rebuilds only the changed meshes' acceleration structures; a frame whose record counts, placed meshes, emissive meshes, textures or environment changed gets a new session, and a failed session update or render falls back to a new session or a one-shot trace for that frame. `metrics.pathTracer.nativeSession` says which one each frame took (`path` is `new-session`, `reused`, `updated` or `one-shot`, with `reason`, `changedTables`, `changedMeshes` (after a triangles update), `pipelineReused` and `accelerationReused`); `metrics.nativeSessionRoutes` lists the `path` of every frame. A job reuses the session only when the tables the page exports are equal to the previous frame's apart from the camera (`reused`), or differ in material values, lights, instance transforms or triangles (`updated`). Geometry that moves with the time, such as particle systems (sparks, swaying hair) or a moved node in a scene exported as flattened triangles, goes through `updated` and costs one BLAS build per changed mesh plus the TLAS. A changed emissive mesh, other record counts or another set of placed meshes gives that frame a new session, which costs what a one-shot trace costs and is byte-identical to it; `reason` names the first table that differed. A single-frame job and `JS67_NATIVE_KERNEL=legacy` trace one-shot and carry no `nativeSession`; `JS67_NATIVE_SESSIONS=off` in the server's environment traces every frame one-shot (default on). The session is closed when the job ends or fails, and every frame of a stills job equals the one-shot render byte for byte. A native video also blends its frames over time, so the noise the denoiser leaves does not shimmer from frame to frame: each pixel finds where its surface point was in the frame before (from the first-hit distance and the two cameras) and the filtered light is averaged with what was gathered there. A pixel whose surface was hidden, off screen, another surface or seen from a direction more than about 6 degrees away in the frame before starts again, so a cut to another view starts again too, and the whole image starts again at a new shot of a `timeline` and on any frame whose scene, light or render settings changed (its route is not `reused`), so a video with moving parts or lights, or a dip through black, gets no blending on those frames. On a depth step, such as the edge of a leaf blurred by depth of field, if the matching same-surface texels already meet the fetch weight they keep their full unclamped history; otherwise texels inside the nearest-to-farthest first-hit range of the 3x3 pixels around (including matching-depth texels whose averaged normal turned) are rescued weighted by depth closeness, clamped to the mean plus or minus half a standard deviation (YCoCg) of the 3x3 colours of the new frame, and capped at 8 frames of history so light of the surface behind cannot ghost in. Each frame of such a video traces with its own seed (`seed` plus the frame number), and `metrics.pathTracer.temporal` reports `historyShare` (the share of pixels that found their history, from the last frame) with `restarted` saying why an image started again. The blend assumes a still scene under a moving camera: light that depends on the view (a sharp reflection, a highlight, the view through glass) trails the camera by a few frames, and an orthographic camera is not blended. `JS67_NATIVE_TEMPORAL=off` in the server's environment turns the blending off, which makes every video frame equal its one-shot render again. A video of traced frames goes through the ffmpeg encoder (the browser H.264 encoder has no drawn frame to read), `maxSeconds` limits each frame, and the job deadline is `maxSeconds` times the frame count plus 60 seconds, up to the job ceiling. Limits: `samples` 1 to 1024, `bounces` 1 to 16, `seed` 0 to 2147483647, `maxSeconds` 1 to 600 (the job's deadline is `maxSeconds` plus 60 seconds; a 1920 by 1080 still of a 180,000 triangle room at 64 samples took 246 s, so give a large still `maxSeconds` 600). A scene with `postPasses` is traced without them: the PNG is the plain traced frame and `metrics.diagnostics` carries a `post-passes-skipped` warning naming the passes (see [user-passes.md](user-passes.md)). `passes` are refused with it, because the tracer has no object ID, depth or normal pass; part findings (framing, floating, intersecting, textures, z-fighting) still reach `metrics.diagnostics` from the first frame, with a `findings-unavailable` entry saying that exposure findings are not available on a traced job (see [mcp.md](mcp.md)). The tracer loads in the job page on demand, uses eight threads at below-normal priority, stops pixels that have converged (`report.averageSamples`), and writes `render.png`; `scene_render_result` metrics carry `pathTracer` with the samples, threads, seconds and what the scene asked for that was not drawn. The same recipe and seed give the same PNG on the cpu and gpu backends; the native Cycles-matching kernel is not always byte-identical between runs (on the demo room at 960 by 540 and 256 samples two jobs differed in a few bytes; a 480 by 270 job with OIDN did not). A job that passes `maxSeconds` fails and writes no image.

A native frame that compiled its kernel says so in `metrics.pathTracer`: `compileSeconds` is the compile, `gpuTraceSeconds` the trace; a compile over one second adds `kernelCompileNote`. The first trace of each scene variant (a scene with no emitter is its own variant) compiles; later frames of the job reuse it. `metrics.pathTracer` describes the last frame, so the job adds the compile of every frame into `metrics.kernelCompile`, and `metrics.report.kernelCompile` carries it with a note once it reaches one second (see [mcp.md](mcp.md)). Details: [path-tracer.md](https://github.com/codepawl/crucible/blob/main/docs/path-tracer.md).

## Controller API

This module provides persistent job records around a trusted render callback.
It does not launch a browser, sample animation, encode video, or register MCP tools.
The runtime integration owns those operations.

The controller accepts one active job and rejects additional submissions until that job settles.
It copies the recipe, clip metadata, settings, and asset Buffer before asynchronous admission begins.
Asset recipes must bind their copied bytes through the recipe's SHA-256 `assetId`.
The controller never modifies the source scene or its revision.

## API

```js
// scripts/agent-render-jobs.mjs in a checkout of the repository; the npm package does not ship it.
const { createAgentRenderJobs } = await import(pathToRepositoryScript);

const jobs = await createAgentRenderJobs({
  root: absoluteJobDirectory,
  run: async ({ jobId, directory, snapshot, settings, signal, progress }) => {
    // The runner writes render.mp4.partial inside directory.
    // It checks signal and stops its owned browser and encoder on abort.
    await progress({ frames: settings.frameCount, maximumPendingFrames: 1 });
    return {
      artifacts: [{
        temporary: 'render.mp4.partial',
        filename: 'render.mp4',
        mimeType: 'video/mp4',
      }],
      metrics: { maximumPendingFrames: 1 },
    };
  },
});

const submitted = await jobs.submit({
  sourceRevision: 7,
  snapshot: {
    recipe: canonicalRecipe,
    assetBytes: immutableAssetBuffer,
    clips: [{ duration: 5 }],
  },
  settings: {
    kind: 'video', width: 640, height: 360,
    fps: 24, duration: 3,
    animation: { clip: 0, start: 1 },
    rendererTime: { start: 0, rate: 1 },
  },
});

const status = jobs.status(submitted.jobId);
const acknowledgement = jobs.cancel(submitted.jobId);
await jobs.close();
```

| Method | Result |
| --- | --- |
| `submit(input)` | Promise of a queued job record after snapshot persistence |
| `status(jobId)` | Detached current record |
| `list()` | Detached retained records, including recovered jobs |
| `cancel(jobId)` | Immediate record with `cancelling`, or an existing terminal state |
| `result(jobId)` | Completed artifact metadata and metrics (plus kept leading frames on a partial budget failure) without arbitrary paths |
| `release(jobId)` | Promise of release confirmation for a settled terminal job |
| `close()` | Promise that aborts work, waits for settlement, and releases store ownership |

`settings.frameCount` contains 1 for images, 8 for stills (or `settings.stillCount`, see below), or `ceil(duration * fps)` for video.
The defaults are 24 fps and one second.
Images sample `animation.start` without requiring the default duration to fit the clip.
Stills and videos require the entire requested animation range to fit the selected clip.
A scene with no clips rejects `settings.animation` with an error that says so; drop `animation` or add a clip first.
A scene recipe that places clips (`asset.clip`) counts as having them, one per placement in placement order, each as long as it needs to play once (its `start` plus its length at its `speed`). They play on scene time, the clock of `motion`, so no motion track is needed: `settings.animation { clip, start }` is the same as `settings.motion { start }`, and sending both is an error. A video or stills job with one of them and no `duration` runs as long as the longest placed clip, counted from `start`. A clip loops or holds on its own `asset.clip.loop`, so the render may run longer than one pass.
Renderer time defaults to `{ start: 0, rate: 1 }` and remains separate from animation sampling.

`progress(update)` accepts monotonic `frames` and a `maximumPendingFrames` value of zero or one.
It returns a Promise for the corresponding status write.
Runner metrics must contain finite JSON within 64 KiB.

## Runner ownership

| Kind | Required output names | MIME type |
| --- | --- | --- |
| `image` | `render.png.partial` | `image/png` |
| `stills` | `frame-0.png.partial` through `frame-7.png.partial` (through `frame-<stillCount - 1>` with `settings.stillCount`) | `image/png` |
| `video` | `render.mp4.partial` | `video/mp4` |

The runner returns every required artifact with its temporary filename, final filename, and MIME type.
Final filenames omit `.partial`.
The controller checks names, regular-file ownership, byte limits, and SHA-256 hashes before publication.
It hashes through a stream rather than loading the complete video into memory.
It renames outputs only after callback success and cancellation checks.
The completed result becomes visible after its status record persists.

The runner must enforce capture memory limits, frame byte limits, and encoder backpressure during execution.
The controller checks PNG artifact sizes and completed MP4 sizes.
It cannot measure transient video frame buffers or prevent an arbitrary callback from writing excess bytes before returning.
The runner must write only the documented partial files inside its assigned directory.

## States and cancellation

Normal execution follows `queued`, `running`, `finalizing`, and `completed`.
Cancellation follows `cancelling` and `cancelled` after the callback settles.
Deadline expiration aborts the callback and ends with `failed` after settlement.
Callback errors and output validation failures also produce `failed`.
Unfinished records from an earlier process become `interrupted` during recovery.
Recovery does not restart rendering.

`cancel()` aborts the signal immediately and does not wait behind rendering or disk persistence.
The runner must interrupt capture, encoder drain, and encoder finalization waits when aborted.
`close()` waits at most five seconds for a cancelled callback to settle.
If the callback remains active, `close()` rejects and keeps the store locked.
A later `close()` can release the lock after the callback settles.
An in-process controller cannot force an arbitrary callback to stop.

## Persistence and limits

The root must be an explicit absolute directory.
A store marker and exclusive process lock distinguish owned job storage from foreign files.
Each UUID directory contains an ownership marker, JSON snapshot, status record, and optional `asset.glb`.

Admission writes those files in a reserved `.pending-<storeId>-<jobId>` directory before renaming it to the published UUID.
No active job exists until that rename succeeds.
Interrupted or failed admissions remain quarantined, count toward the byte budget, and do not become jobs.
Reopening preserves their files, including malformed JSON and foreign regular files, so older completed results remain accessible.
Only verified empty pending directories are removed automatically.

The controller rejects links, file aliases, unknown filenames, foreign directories, and persisted path traversal.
It verifies completed artifact hashes when reopening a store.
It removes files individually during release, without recursive deletion.

A program that polls `status.json` can hold it open, and on Windows that blocks the rename that replaces it. The controller retries that rename for under a second on `EPERM`, `EBUSY` and `EACCES`. If the file stays held, the last good `status.json` stays on disk, a `CRUCIBLE_STATUS_BLOCKED` process warning is emitted and the job carries on. `scene_render_status` answers from memory, so prefer it to reading the file.

The lock protects cooperating controller processes.
The filesystem must remain private to the owner while jobs run.
It does not isolate an arbitrary callback or hostile concurrent filesystem writer.

Malformed published job records require repair before the controller can reopen the store.
Quarantined admissions need explicit inspection and cleanup to reclaim their space.
Their directories must contain regular files without links or aliases. Other entry types require repair.

A client that closes the connection waits about two seconds before it kills the server, and a killed server leaves `store.lock` behind.
The next controller takes over a lock when the file is well formed and its process ID belongs to no running process. Only one process can take over a given dead lock: it first creates a claim file `store.lock.claim-<token>`, re-reads the lock under that claim, and removes the lock only if it still holds the dead token, then creates its own. Locks and claims are written to a temporary file and linked into place, so they never exist empty or half written; a lock that still does not parse is treated as owned by a live starter. If the lock changed under the claim, the start begins again once. A process killed while it holds a claim leaves the claim behind, which blocks the takeover of that one lock; the next start names the exact `store.lock.claim-<token>` file to delete, and does the same for a claim it cannot read.
A lock whose process is alive, or a file that is not a recognized lock, is still refused. The operating system can hand a dead owner's process ID to an unrelated process; that lock looks alive and stays until a person confirms nothing owns the dedicated private store and removes `store.lock`.

A render or review job fails when its Node RSS passes 512 MiB or its browser heap passes 256 MiB. After each frame the browser heap is read, and when it is over the limit it is garbage collected and read again, so only memory the page still holds counts. A physics bake leaves tens of MiB of garbage after its first frame; a real leak survives the collection and still stops the job. The `peakBrowserHeap` metric is read before that collection, so it includes garbage: one 200k triangle GLB read about 770 bytes per triangle there while the page held about 25 bytes per triangle after a collection. The flush-face search no longer builds an object per triangle, which cut that peak to about 350 bytes per triangle with the default ranking and about 145 with `resolveCoplanar: false` (#1343); `node scripts/measure-glb-heap.mjs` reproduces the numbers.

A job that traces on the native path tracer holds more in the Node process, because the tracer tables, the OIDN denoiser, the frame planes and the temporal history all live there. Once a frame traces natively, the runtime adds an allowance on top of the 512 MiB: 640 MiB plus 1 KiB for each pixel of the frame, never more than 2 GiB (about 1.6 GiB of Node RSS in all for 960 x 540, 2.5 GiB at the cap). The allowance applies to every later render job and scene review of that server process, and it is kept when a job falls back to another backend, because the OIDN device stays loaded for the life of the process. It never shrinks, and it is one figure rather than separate parts for the tracer, OIDN and temporal history, on purpose. The runner waits one event-loop turn after each native frame, because the addon's frame planes are freed from the event loop, so a film's memory stays flat per frame instead of growing about 9 MB a frame (480 x 360). Measured over 500 frames of one session with OIDN on an RTX 3060 (Windows), RSS rises for the first 100 frames and then holds at about 513 MB, and closing a session gives its memory back for the next one (12 sessions opened and closed in a row stay within 2 MB); `node --expose-gc bench/native-tracer/frame-memory.mjs` repeats that check and fails when a frame or a session cycle adds memory. Native + OIDN video jobs of the demo room peaked at 1224 MiB of Node RSS at 960 x 540, 1360 MiB at 1280 x 720 and 2149 MiB at 1920 x 1080 (RTX 3060, Windows), which the allowance covers with 35, 51 and 19 percent to spare. A Linux box with a GPU has not been measured yet. On a software Vulkan adapter (llvmpipe, lavapipe or SwiftShader) the native tracer runs on the CPU, and the first job of a fresh process also compiles the kernel, which adds about 430 MiB: a 960 x 540 video of the demo room peaked at 3226 MiB of Node RSS on lavapipe (GitHub `ubuntu-latest`), and a warm trace holds about 840 to 920 MiB. So once a trace runs on a software adapter, the runtime adds 2304 MiB more on top of the per-pixel allowance (3962 MiB of Node RSS in all at 960 x 540, 23 percent above that peak), and the `cook-addon` workflow renders that first 960 x 540 job on every run to prove it fits. A job over its limit still fails, and the error names the limit, the observed and allowed MiB and what to change.

| Budget | Default |
| --- | --- |
| Retained records | 32 |
| Total store bytes | 512 MiB |
| Combined output bytes per job | 128 MiB |
| PNG artifact bytes | 12 MiB each (a 1920x1080 frame; the limit grows with the pixels above that, 48 MiB at 3840x2160); 48 MiB each for `png16` and `exr` |
| Snapshot JSON | 1 MiB |
| Asset bytes | 64 MiB |
| Dimensions | An `image` job: 64 to 3840 pixels each, at most 3840x2160 pixels in all (2880x1620 fits). `stills` and `video`: 64 to 1920 each, at most 1920x1080 in all (1080x1920 fits). A frame larger than 1920x1080 that `--memory` cannot hold is refused with the `--memory` it needs, never shrunk; `--memory` tops out at half of the machine's RAM, at most 4096 MiB (measured: 2880x1620 of a plain scene asks for `--memory 373` on the GPU backend; textures add to that) |
| Video frame rate | 1 to 60 fps |
| Duration | 0.1 to 60 seconds |
| Maximum video frames | 900 |
| Still frames | 8, or 2 to 300 with `settings.stillCount` |
| Job elapsed deadline | 60 seconds plus 2 seconds per frame, multiplied for frames larger than 1024x576 (360 frames at 1024x576 get 13 minutes), never more than 30 minutes; a video that has finished frames is held to 1.5 times its measured time per frame for all its frames instead when that is longer, so a heavy scene is not cut off at the 2 second guess; it counts render time only and starts once the job has its turn and the scene page is handed over |
| Job queue wait | Five minutes behind other calls and the page handoff, counted apart from the elapsed deadline; the failure says "queue wait deadline" |
| Video encoder drain and finalization | 30 seconds each |
| Close settlement deadline | Five seconds |

Handing the scene page to a job, or to a review, and bringing it back each get four times the ordinary 30 second call limit, 120 seconds, because a job that ran out of time usually shared the GPU with another process.
A job that passes its elapsed deadline fails alone, and the failure says how many frames it finished and about how many seconds a frame took, so a shorter clip can be sized from it. Retry it once the card is free. If the scene page still does not come back within 120 seconds, the runtime is `failed`, and calls on the lost scene say so. The next `scene_create` starts a fresh runtime (a new browser, no scenes carried over) and the call after it works as usual; no server restart is needed.
Other calls (`scene_inspect`, `scene_apply`) queue behind that handoff, so after a deadline failure they can wait up to 120 seconds, and the job stays `cancelling` for that long.
One server owns one `--jobs` folder. A second server given the same folder fails with "The job store is already owned by a live process", and the error says to start it with its own `--jobs` folder.

The controller rejects odd MP4 dimensions.
Admission reserves the job's own estimated output (frames, pixels, passes and mattes, with a margin, never more than the output budget) plus snapshot and metadata space.
The optional `limits` object can reduce controller budgets for bounded tests.
It cannot increase production limits.
Partial files count toward the store budget and remain until explicit release.
Each submit needs room for its snapshot and an output reservation sized to that job: a single image holds a few MiB, a 72 frame 1080x1080 stills job about 93 MiB, and nothing holds more than the 128 MiB output budget. When the store is too full, the controller first releases completed jobs whose `scene_render_result` was already read, oldest first, and stops as soon as the new job fits; the files of a released job are gone, so copy outputs you keep before you submit the next job. A job whose result was never read is never released this way. If the job still does not fit, the error says how many MiB it needs and how many are free, and names the three largest finished jobs by id and size to read with `scene_render_result` and free with `scene_render_release`. A job read before a server restart counts as unread again. A job may write more than it reserved, up to the output budget, while the store has room; after each frame past its reservation the job stops with a failed state when one more frame would not fit beside the other jobs, so the store never grows past its total budget.

## Linux GPU box

Start the server with `--backend gpu` and a Chrome that runs on the GPU through Vulkan. A small wrapper does it: `exec google-chrome --use-angle=vulkan --enable-features=Vulkan --ignore-gpu-blocklist --no-sandbox "$@"`, passed as `--browser <wrapper>`. `scene_look` should report an `ANGLE (NVIDIA, Vulkan ...)` renderer; a `llvmpipe` or SwiftShader name means the container has no NVIDIA Vulkan driver and renders on the CPU.

`node scripts/measure-linux-gpu-render.mjs --out artifacts/linux-gpu` renders a 30 frame 1080x1920 `stills` job and a path traced still at 540x960 and 1080x1920 through this server and writes `report.json` with the seconds, the frame sizes and the hash of the first frame. Run it first on a new box.

The GPU path tracer draws each sample in tiles of at most 65,536 pixels and waits for each tile with a GPU fence, because a sandboxed driver can return from `gl.finish()` before the work is done, which let draws queue until the watchdog fired (Xid 109) above about 540x960 (#2833).

## CPU checks

1. Run `node --test tests/agent-render-jobs.test.js`.

The tests use actual temporary files and controlled callbacks.
They cover snapshots, persistence, hashes, cancellation, deadlines, restart recovery, quotas, path rejection, and file aliases.
The tests do not run browsers, ffmpeg, or GPU rendering.

A recipe whose only moving content is `physics`, `cloth` or `particles` takes the same `motion` setting, and plays from `motion.start` 0 when the job leaves it out (unless the job is longer than the bake, which then holds the first pose): the job plays the bake on the motion clock, with no authored motion and no `bake-motion` step (so the 32 node cap does not apply). A video without `duration` runs as long as the bake, counted from `motion.start`, and a longer one is rejected. A recipe with nothing that moves fails with an error that lists authored motion, physics, cloth, particles, placed clips and map sequences as the accepted sources.

The camera does not move with the bake. A recipe `camera` (`eye`, `target`, lens) is the same on every frame of a physics, cloth or particle film, so shards flying out of frame do not pull the view. Nothing frames the scene by its bounds: only an authored `camera` motion track or a timeline shot changes the camera. Set `camera.eye` and `camera.target` for a locked shot; left out, the default camera is used, also locked. `tests/physics-film.test.js` checks that a static marker stays on the same pixels from the first frame to the last.
