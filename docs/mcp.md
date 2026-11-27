# MCP scene authoring

The `crucible-mcp` stdio server is included in npm release `0.5.0` and later.
It uses the maintained MCP TypeScript SDK v2 server and a local browser runtime.
The [official SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/) describes its transport and protocol APIs.

Release `0.5.0` exposes twelve tools for bounded JSON scene authoring and local GLB imports.
Release `0.6.0` adds five render job tools for PNG images, still sequences and MP4 video.
Release `0.7.0` adds [procedural motion](agent-motion.md), transient preview seeks and motion sampling in snapshot jobs.
Release `0.8.0` adds [imported character motion](agent-character-motion.md) with source joints and independent clip timing.
Release `0.9.0` adds [visual review](agent-review.md) for several labeled views or poses from one isolated snapshot.

This guide follows `main`, and the npm release can be older. A field, tool or behavior that the last release does not have carries a tag such as `{since 0.23.0}`: it needs that release or a later one, and an older server refuses it by name. `npx -y -p @codepawlhq/crucible crucible-mcp --version` prints the installed version. `npm run check:guide-fields` fails when this guide or the [game guide](game.md) names a field that is newer than the last release without the tag.

To see what changed, including changes not yet released, read `https://crucible.codepawl.com/changelog.json`: `released` sections, `unreleased` entries and each entry's issue number and `breaking` flag.

It renders scenes (several can be open) and returns PNG images through MCP image content.
Tool results also contain JSON text and structured metadata.
The image bytes appear only in the image content block.

## Requirements and launch

The server requires Node.js 20.19 or later and an installed Chrome or Chromium executable.
The npm package contains a prebuilt server and browser preview. A source checkout and Vite are unnecessary.
The browser driver loads when `scene_create` or `scene_create_asset` runs. It does not download a browser.

The runtime serves its bundled scene page on the loopback interface.
The MCP connection uses stdin and stdout, without an HTTP MCP listener.

1. Install the package in your project:

   ```powershell
   npm install crucible@npm:@codepawlhq/crucible
   ```

   Run the installed command with `npx crucible-mcp --backend gpu --memory 192`.
   For a standalone launch, use `npx --package @codepawlhq/crucible crucible-mcp --backend gpu --memory 192`. Add `@<version>` after the package name to pin one.
   `crucible-mcp --help` lists options. `crucible-mcp --version` reports the installed version.

   For trees with scanned bark and leaves, download the `vegetation-scans` pack (3.8 MB, CC0) from the
   [Marketplace](https://crucible.codepawl.com/marketplace.html), unzip it into its own folder under one packs folder
   and add `--packs`:

   ```powershell
   npx crucible-mcp --backend gpu --memory 256 --packs C:/projects/my-scene/packs
   ```

   Without the pack, trees draw procedural bark and leaves. `scene_capabilities` topic `packs` says which one is on.

2. Configure your MCP client with absolute paths to Node and the installed CLI:

   ```json
   {
     "mcpServers": {
       "crucible-scene": {
         "command": "C:/Program Files/nodejs/node.exe",
         "args": [
           "C:/projects/my-scene/node_modules/crucible/bin/crucible-mcp.mjs",
           "--backend", "gpu",
           "--memory", "256",
           "--packs", "C:/projects/my-scene/packs",
           "--browser", "C:/Program Files/Google/Chrome/Application/chrome.exe"
         ]
       }
     }
   }
   ```

The browser path is optional for a standard Google Chrome installation. Pass `--browser` for another Chromium executable.
Using Node directly also avoids shell-specific npm launcher behavior in MCP clients on Windows.
`--backend` accepts `gpu` or `cpu` and defaults to `gpu`.
`--memory` accepts an integer from 32 up to half of the machine's RAM, at most 4096 MiB (never less than 384), and defaults to 192; a value above that is refused at launch with the maximum for the machine. A 1920x1080 frame needs about 175 MiB of render targets (measured, 4 samples), so the default fits an empty room at that size and 256 leaves room for textures; raise it for textured scenes or for a 1080p frame of a heavy scene. An image job may ask for up to 3840x2160 (measured: 2880x1620 of a plain scene needs `--memory 373`; textures add to that, so raise `--memory` for them); a frame the budget would shrink is refused with the --memory it needs. When a frame would need more than this machine's maximum, a reduced frame says so and names what to shrink (textures, geometry, size, HDR or bloom) instead of asking for a larger `--memory`.

A scene the budget cannot hold fails the call with the bytes it counted and a fix the agent can take in that call: set the resolution of baked textures to 512, use fewer textures or remove parts. If the scene still needs more, the error names the `--memory` the operator restarts the server with, or says the machine cannot reach it. No tool takes a memory argument, so the budget stays the operator's.

The memory guard of a render job or review follows `--memory`: the job fails when the Node process RSS passes max(512, memory + 128) MiB or the sampled browser heap passes max(256, two thirds of memory) MiB, so 384 and below keep the old 512 and 256 and a larger `--memory` raises both. A job on the native path tracer (`backend: "native"`) runs the Cook addon inside the Node process, so it gets an extra allowance on top of the Node limit: 640 MiB, plus 1 KiB per pixel, plus 2 MiB for each MiB of `--memory` (the 2 is a headroom choice, not a measurement), capped at 2048 MiB plus the same share of `--memory`. The error names the limit that tripped and, while `--memory` can still go up, the maximum for this machine.

`--assets` selects an absolute directory containing GLB files.
`--max-asset-bytes <bytes>` raises (or lowers) the 64 MiB limit on one GLB and on the assets of one call and scene, from 1048576 (1 MiB) to 268435456 (256 MiB). The default stays 64 MiB because a local Chrome test lost the preview page from 80 MiB; raise it only on a machine you control, for large scans such as Poly Haven trees. The limit error lists the three largest assets of the call with their sizes and suggests `gltf-transform simplify`, `gltf-transform meshopt` or smaller textures.
The asset catalog reads regular files directly inside that directory, with limits of 256 GLB, BVH, HDR and CUBE files (images have their own cap; `.md`, `.txt` and `.json` files are not counted) and 64 MiB per file. A scene places at most 32 different assets, so unused files only count against the 256; both limit errors list the files or assets they counted. One call that places several assets, motion sources and sequence frames sends them to the preview page in one message, so their total is capped at 64 MiB too (`maxCombinedBytes`); grid files (`.67vg`) and look files count too. A call over it fails with an error that names the limit and the total, and the agent places the rest in later calls. The cap also holds for the whole scene: a render job loads every unique asset at once, so `scene_apply` refuses an add-node that would take the scene's unique assets (one asset placed many times counts once) past it, before the preview page loads anything. The scene's grid files count in that total, and a render job or review of a scene already over it fails with the same message before the preview page is handed over, so the page keeps its scene. The server adds up the file sizes first, so a refused call reads no file. Decoding takes 1,000,000 vertices, 4,096 parts and 1,024 joints at most; `scene_capabilities` reports every number under `assets`. They are lower than the `loadGltf` defaults (256 MiB, 8,000,000 vertices) because the server hands the whole file to the preview page as one base64 string, which crashed the page from 80 MiB in a local Chrome test. A file over a limit fails with an error that names the limit and the value it hit; a larger scene loads through `loadGltf` in code (see [gltf.md](gltf.md)). All limits live in `src/agent-asset-limits.js`.
Asset IDs bind file contents through SHA-256. The `--assets` folder is looked at again (names, sizes and modification times only, no file is read) whenever `scene_asset_catalog` is called and whenever a recipe, edit or icon item names a GLB or image sequence by name, so a GLB, image or HDRI copied in during the session is listed by the next catalog call and can be placed by name without a restart. A removed file leaves the list, and a rewritten file is listed under its new ID. An ID already pinned in a scene keeps its bytes check: if that file changed on disk, the read fails and the scene needs the new ID. The same count and size limits apply on every look. Installed packs are still checked once per runtime.
Catalog imports retain supported textures, skins, morphs and animation clips.
A Draco-compressed GLB (`KHR_draco_mesh_compression`, common in Sketchfab and NASA downloads) loads as it is: the server decodes its meshes when it reads the catalog, with the optional `draco3d` package, and the preview page receives a plain GLB. Install it where the MCP server runs (`npm install draco3d`). Without it, `scene_asset_catalog` lists the file under `skipped` with that advice, or re-export the file without Draco (in Blender, untick Compression in the glTF export). The 64 MiB limit applies to the decoded file, which is several times larger than the compressed one. A file whose Draco data holds a different point or face count than its accessors declare is skipped with both numbers.
A GLB with KTX2 textures (`KHR_texture_basisu`, what gltf-transform `optimize` and Sketchfab's optimised exports write) loads as it is too: when reading the catalog the server validates each KTX2 image (at most 4096 x 4096 pixels per image and 64 million pixels per file) with the Basis transcoder that the optional `three` package ships, and sends the compressed GLB straight to the preview page, which transcodes to GPU-compressed mip levels (BC7, ASTC, ETC2 or DXT) and only falls back to RGBA8 or PNG where needed (contexts without compression, shared texture transforms, path tracing, light baking or standalone web export). Install `three` where the MCP server runs (`npm install three`). Without it, `scene_asset_catalog` lists the file under `skipped` with that advice, or re-export the textures as PNG or JPEG. Unchanged KTX2 textures stay compressed through `scene_export_glb`, and the 64 MiB limit applies to the GLB file (and any transcoded PNG fallback).
A GLB that points at image files (a Kenney kit ships `boat.glb` plus `Textures/colormap.png`) loads as downloaded: the catalog reads each relative PNG, JPEG or WebP path from that folder or below it, counts it against the 64 MiB file limit and stores it inside the asset, so the asset ID covers the texture bytes. A remote or `data:` address, a path that leaves the folder (`..`, an absolute path, a link) and a missing or non-image file are refused with an error that names the GLB and the path. Buffers must still be embedded. Poly Haven and similar sites ship a glTF folder (`.gltf`, `.bin` and textures): bundle it first with one command (the `.bin` must be embedded; image files may stay beside the GLB), then put the result in the catalog directory: `npx @gltf-transform/cli copy tree_01_1k.gltf tree_01.glb`. A recipe places a catalog asset with an `asset` node field (see [the scene guide](agent-scene.md#placed-catalog-assets)).

The asset ID is the SHA-256 of the file, so it changes on every re-export. A placement can name the file instead: `asset: { "name": "sheep_body.glb" }` in `scene_create` and in a `scene_apply` add-node, or `assetName` beside `format` in the `scene_create_asset` recipe. Pass exactly one of `id` and `name`. The server resolves the name against the catalog when the call arrives and keeps only the ID, so the scene, its checkpoints and its render jobs stay pinned to the exact file. The name is the one `scene_asset_catalog` lists (`pack/file.glb` for a pack file) and must match exactly. An unknown name is refused with the nearest names, and two GLBs under one name are refused with a request to pass the ID.

`--jobs` selects the absolute folder that holds render jobs and exports (`scene_export_glb`, `scene_export_web`). The server checks it at startup. A directory link, such as a Windows junction made with `mklink /J` to put outputs on another drive, is followed once at startup, and the job store then works on and stays inside the real folder it points at; a path that is a file stops the server with a message naming `--jobs`. Links inside the folder are still never followed, and no tool call can name a path. `scene_capabilities` works without a job store: if the store cannot open it lists no records and reports `jobs.unavailable` with the reason, and a later call tries the store again.

The server keeps the frames of an `add-explosion` blast in a cache folder, so only the first process that needs a fuel, seed and velocity setting simulates it (about 5 seconds for 72 frames of 32^3); later processes read the file. The folder is `crucible/explosion-bakes` in the user cache folder (`XDG_CACHE_HOME`, else `LOCALAPPDATA` on Windows, else `~/.cache`), never the package or `--assets`. Set `CRUCIBLE_BAKE_CACHE` to another absolute folder, or to `off` to bake in every process. A file is used only when its length and SHA-256 check out and its name matches the solver version and bake settings; otherwise it is baked again. The folder holds at most 512 MiB, oldest file first out. The frames are the same bytes as a fresh bake.

The server also keeps Chrome's compiled GPU shaders between runs (GPU backend only), so a scene with a heavy shader, such as a volume composite, does not pay its whole driver compile again in every new server process. On the measured machine a box volume's first `scene_create` fell from 4.9 s to 0.8 s and a grid volume's from 2.9 s to 0.7 s once an earlier process had filled the cache. The folder is `crucible/shader-cache` in the user cache folder (same rule as the bake cache). Only Chrome's `GPUCache` folder is kept there, a few MB: never cookies, history, storage or the rest of the browser profile. Each server process runs Chrome on its own temporary profile, copies the cache in before the start and back after Chrome closes (written beside the old one, then renamed into place), so two servers never share a locked profile; a cache another process is saving at that moment is skipped, not waited for. A cache over 256 MiB is dropped. Set `CRUCIBLE_SHADER_CACHE` to another absolute folder, or to `0` (or `off`) to start Chrome fresh every time. Chrome keys the entries by its version and the graphics driver, so an update or a new driver only means one slow compile again. A preview call that adds a grid volume (a `scene_create` whose recipe has a `grid` local volume, or a `scene_apply` with `add-explosion`) may run 60 seconds instead of 30, because the first draw compiles the volume composite shader in the graphics driver, which took 5 s warm, 15 s after idle and 23 to 32 s on a loaded GPU before the cache; a call that bakes keeps its own longer limit. A plain call still stops at 30 seconds.

`--audio` selects an absolute folder of `.wav`, `.mp3`, `.ogg` or `.flac` files that video jobs may use as a score.

`--branches`, `--relations` and `--findings` each take `on` or `off` and default to `on`. `off` hides that feature from the tools: the `branch` field from `scene_apply`, the `relations` field from node records, and the findings from `scene_look`. They exist for benchmark control arms; any other value stops the server at startup.

`--tools` takes a comma-separated list of tool names, and the server lists and serves only those. Every tool schema is sent to the model on each turn, so a client that loads all of them up front pays for tools a task never uses; the render job tools alone are about 10 KB of schema. The list must include `scene_capabilities`, because the other tools point to it for their fields. An unknown name stops the server at startup with the list of valid names. The server instructions name the listed tools, so the model does not reach for a hidden one, and a call to a hidden tool is refused as not found. Without the flag every tool is listed, exactly as before. For example, `--tools scene_capabilities,scene_create,scene_apply,scene_inspect,scene_look,mesh_inspect,mesh_edit,scene_checkpoint,scene_restore,scene_export_recipe,scene_dispose` covers modeling and editing without render jobs or exports.

The server checks `--browser`, `--assets`, `--packs`, `--audio`, `--ffmpeg` and `--jobs` before it serves. A relative path, a missing executable or a bad flag value prints the reason and exits with code 1, instead of failing every request later.
`--gpu-queue` makes the server share the GPU through a queue you already run (a script that starts a command once the card has room). Pass an absolute executable path, or a JSON array such as `["bash","/path/to/gpu-lock.sh"]`; a script on Windows needs the array form with its interpreter, because a bare `.sh` or `.cmd` path cannot be started directly. The server runs that command once for each unit of GPU work, with a small program appended, and waits until the command starts that program. The wrapper must pass its standard input through to that program: the program holds the card until the server closes its input, and a wrapper that does not pass it through frees the card at once (the server prints one line to stderr when that happens). These tools wait for the queue: `scene_look` and `scene_review` take the card as `light`; render jobs, and scene creates or edits that bake light, take it as `heavy`. A look or review that arrives while the server already holds the card for a render job joins that hold instead of asking the queue again, so the server never queues against itself; a look that arrives while a render job is still waiting for the card does not wait behind that job, it asks the queue for a light hold of its own. A script path that Windows cannot start directly (`.cmd`, `.bat`, `.ps1`, `.sh`) is refused at launch with the array form to pass. The tools that draw outside those paths run without the queue: `scene_ask_user` frames, the exports (`scene_export_glb`, `scene_export_web`) and the inspect tools. A render job waits as `queued`, and its elapsed deadline starts only when the queue grants the card. Cancelling a job, or a failed or cancelled call, gives the card back; the server only holds it while it renders, never while an agent is editing. The weight reaches the command as the environment variable `CRUCIBLE_GPU_WEIGHT`, so a wrapper can map it to its own setting. `--gpu-queue-wait <1..3600>` bounds the wait (default 600 seconds), and a call that waits longer fails with an error naming it. Only the person who starts the server sets these flags; no tool argument can name a command, and no shell reads the value. Without `--gpu-queue` nothing changes.

`--addons` selects an absolute folder that holds `node_modules`, and each `--allow-addon <package name>` (repeat it, at most 16 times) allows one addon package from it ([third-party addons](addons.md#the-mcp-server-and-addons)). Only these two options choose addons, at startup. A tool call cannot load, name or change one. An addon that is not installed there, fails the addon contract, does not allow the running Crucible version, declares an entry file above 2 MiB, resolves to a real path outside the folder, or registers a kind it did not declare is skipped with a one-line reason on stderr, and the server keeps running. `scene_capabilities` topic `addons` lists the loaded and skipped addons and the kinds each registered. A recipe may then use a registered controller or camera kind in `game.player.controller` and `game.camera`; the error for an unknown name lists the available ones.

These launch options remain outside tool arguments.
The process runs below normal priority to reduce interference with other work.

Stdout contains only MCP protocol messages, while errors go to stderr.
Closing stdin or sending `SIGINT` or `SIGTERM` closes the runtime: it cancels a pending `scene_ask_user` (the page server and its timer end at once), gives back the job store lock and releases its browser resources. A browser that failed to launch does not stay failed: the next call tries again. A `scene_render_release` that fails halfway is finished by a retry, and the next server start removes what it left.

## Other clients and models

Every recorded agent run used Claude Code. This table says what was tried elsewhere on 2026-10-31 and what was not.

| Client or check | Result |
|---|---|
| Official MCP SDK client over stdio (`npm run smoke:mcp-package`) | Passes. |
| MCP Inspector CLI 2.13.0 (`npm run smoke:mcp-clients`) | Passes, 2026-11-03, Windows, `--backend cpu`. Lists all 26 tools through `tools/list` in 7 s. `tools/call` of `scene_create` with the lamp recipe succeeds in 10 s. The CLI starts a new server for every command and the scene lives in the server, so it cannot follow with `scene_look`. That call fails with "No scene is active" and returns no image. The preview image is not testable through this CLI. |
| Official MCP Python SDK 2.3.0 (`npm run smoke:mcp-clients`) | Passes, 2026-11-03, Windows, `--backend cpu`. Initialize, `tools/list` (22 tools), `scene_create` and `scene_look` in one session. `scene_look` returns a 20480 byte PNG. 11 s including the first `uv` download. |
| JSON Schema 2020-12 validator with strict mode (Ajv 8), run in `npm test` | Every tool input schema compiles. |
| Tool names and descriptions | Names are 9 to 24 characters from `[a-z_]`, within the 64-character limit OpenAI, Gemini and Anthropic share. No description is over 1024 characters. |
| Cursor, Gemini CLI, Claude Desktop, VS Code, any OpenAI or Gemini model | Not run. No account or client was available. Configure them with the same `command` and `args` as above, which is unverified. |
| Install by `npm install crucible@npm:@codepawlhq/crucible`, then `npx crucible-mcp`, or `npx --package @codepawlhq/crucible crucible-mcp`, or the absolute path to `bin/crucible-mcp.mjs` | All four start and report the version. |

Known gaps, checked by `npm run check:tool-schemas`:

- The schemas declare JSON Schema 2020-12, the MCP default. A client that compiles them with a draft-07 validator rejects them: Ajv in its default draft-07 mode throws on `$schema`, and then on `prefixItems`, which is how fixed-length vectors are written.
- OpenAI `strict: true` function tools would reject them: most properties are optional, objects do not set `additionalProperties: false`, and `oneOf`, `prefixItems` and `propertyNames` are outside the documented subset. A client that sends MCP tools as non-strict functions is unaffected.
- Gemini function declarations document a smaller keyword subset than we use (`const`, `oneOf`, `$ref`, `exclusiveMinimum`). Open-ended records (`select` rules, material graphs, relations) are schemas with no `type`. A client that converts schemas for Gemini needs to inline `$ref` and drop or rewrite those keywords.
- Whether a weaker or non-Anthropic model finds the tools is unmeasured: the agent-modeling suite ran only on Claude Sonnet and Haiku.

## Workflow

1. Call `scene_capabilities` for the topic index, then again with `topic` for the detail you need (limits, field lists).
2. Call `scene_create` with a [scene recipe](agent-scene.md#recipe-contract).
3. Call `scene_inspect` to read node IDs, bounds, counts, and the current revision.
4. Call `scene_checkpoint` before an experiment.
5. Call `scene_apply` with a small batch and the current `expectedRevision`.
6. Call `scene_look` to assess the rendered image.
7. Call `scene_restore` with the current revision if the experiment fails.
8. Call `scene_release_checkpoint` when you no longer need the saved state.
9. To try variants, call `scene_apply` once per variant with a `branch` name (the scene stays as it is), compare them with one `scene_review` that has a `branch` per shot, then call `scene_restore` with the winning `branch` to keep it.
10. Call `scene_export_recipe` to retain the canonical recipe.
11. Call `scene_dispose` to release the scene before creating another one.

`scene_create` returns the session ID, current revision, inspection, and render status. `scene_apply` and `scene_restore` return the same without the inspection, so an edit answer stays small; call `scene_inspect` to read the nodes.
`scene_checkpoint` returns a checkpoint UUID scoped to its session UUID.
A restore increments revision and keeps the checkpoint available.
To undo the last edits without a checkpoint, call `scene_restore` with `revision` set to an earlier revision number. The session keeps the 4 revisions before the current one (every `scene_apply` and `scene_restore` leaves one behind), drops the oldest first, and an unknown or dropped revision fails with the revisions still kept. The restore is itself a revision, so it can be undone the same way.
A stale revision or invalid command produces an error without publishing partial edits.
SDK validation rejects unknown tool fields before dispatch.
Backend errors return `isError: true` with a readable message.

Successful apply and restore responses include `committed: true`, the new revision, and `renderSucceeded`.
If rendering fails after the edit commits, the response retains that revision and includes `renderSucceeded: false` and `renderError`.
Its render metadata describes the last successful render, rather than a new frame.
Inspect or export the recipe before retrying. Context loss still permits recipe inspection, export, and disposal.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `scene_capabilities` | `topic` (optional; a name or a list of up to 8; in a list, unknown names come back in `unknown` with suggestions beside the answers of the valid ones; a bare geometry or op name that belongs to one topic, such as `cylinder`, is answered as `geometries.cylinder`) | A short index of topics; with a topic, its limits and fields (`motion`, `environment`, `materialFields`, `meshEdit` (each op with its arguments as `name:type`, `?` for optional, and the face, edge and vertex rules once), `meshEdit.<op>` (every field with its notes), `physics`, `jobs`, `examples` and more; `examples.<tool>` is a complete call for `scene_create`, `scene_apply`, `scene_create_asset` or `scene_render_submit`) |
| `scene_create` | `recipe` | Session ID, revision, inspection, and render status |
| `scene_asset_catalog` | None | Configured catalog and content-bound GLB, image, `.hdr` (kind `environment`) and `.cube` (kind `look`) IDs; an ID goes in `environment.hdri` or `environment.look`, see [agent-look](agent-look.md#catalog-hdris-and-looks). A file over its limit (an `.hdr` over 8 MiB, a `.cube` over 4 MiB, an image over 1024 pixels a side or 64 MiB decoded, read from its header), or a GLB whose image is missing next to it (the reason says which file to copy), is left out and listed with a reason in `skipped`, so the other IDs still list. A folder of more than 256 consecutively numbered images is listed once under `sequences` (`name` such as `frame_####.png`, `first`, `last`, `frames`, `width`, `height`), and a material `map.sequence` names it with `catalog` instead of listing the frame IDs, see [agent-scene](agent-scene.md#image-sequence-maps) |
| `scene_create_asset` | `recipe` using `crucible.asset`; optional `checkMesh: true` {since 0.23.0} | Imported scene ID, revision, inspection and render status; with `checkMesh`, also `assetWarnings` |
| `scene_inspect` | `sessionId`, optional `ids`, `limit`, `includeBounds`, `profile` {since 0.23.0}, `profileFrames` {since 0.23.0} | Compact node records and revision; `profile: true` adds ms per frame, draw calls, triangles, texture bytes and the heaviest nodes |
| `scene_apply` | `sessionId`, `expectedRevision`, `operations` | Updated revision, render status, results and diff |
| `scene_walkmap` | `sessionId` or `assetId` (query a big catalog GLB), `min`, `max`, optional `cellSize`, `clearance`, `keepOut`, `streetY`, `includeCells` | Grid rows of `.` walkable, `x` blocked and `#` no surface, with counts; ground height and headroom per cell with `includeCells`. See [scene-query.md](scene-query.md) |
| `mesh_inspect` | `sessionId`, optional `geometries` (up to 16 IDs) | Per geometry: polygon counts, face sizes, parts, face tags, bounds and lint problems with fixes |
| `mesh_edit` | `sessionId`, `expectedRevision`, `geometry`, `edits`, optional `replace` | Updated revision, render status and the mesh report with per-edit results |
| `mesh_stack` | `sessionId`, `expectedRevision`, `geometry`, optional `stack`, `apply` | Updated revision, render status and the mesh report with per-node results |
| `scene_look` | `sessionId`, optional `width`, `height`, `motionTime`, `labels`, `view` {since 0.22.0} | PNG image and metadata |
| `scene_ask_user` | `sessionId`, optional `prompt`, `maxMarks`, `timeoutSeconds`, `motionTime`, `reviewFile` | Opens the view in the browser, waits for Send, returns numbered marks with `partId`, `point`, `normal`, `note`, the camera and the marked PNG. With `reviewFile` it reads the marks a [review page](#review-link) saved instead (no browser, no image) |
| `scene_fit_look` | `sessionId`, `shots`, `regions`, `free`, optional `maxIterations`, `width`, `height` {since 0.23.0} | `scene_apply` operations that carry the fitted look, error per region before and after, iteration history, and the new revision. See [fit the look to references](https://crucible.codepawl.com/agent-fit-look.md) |
| `scene_review` | `sessionId`, `expectedRevision`, `shots` (each with an optional `branch`) or `wedge` {since 0.23.0}, optional `width`, `height`, `labels`, `response_format` | Labeled PNG grid and metadata from an isolated snapshot |
| `scene_checkpoint` | `sessionId` | Checkpoint ID, session ID, and revision |
| `scene_restore` | `sessionId`, `expectedRevision`, and a `checkpointId`, a `revision` or a `branch` | Updated revision and render status |
| `scene_release_checkpoint` | `sessionId`, `checkpointId` | Release confirmation |
| `scene_export_recipe` | `sessionId` | Canonical recipe and revision |
| `scene_export_glb` | `sessionId`, optional `clip` (index or name), `motionTime`, `maxTextureSize` | A GLB file under `<jobs>/exports/` with a server-chosen name: path, bytes, SHA-256. See [GLB export](export-glb.md) |
| `scene_export_web` | `sessionId`, optional `title`, `review` | A static web build folder under `<jobs>/exports/`: path of `index.html`, file count, bytes. Needs a `game` set with `set-game`, unless `review` is true. See [Game](game.md) and [Review link](#review-link) |
| `scene_dispose` | `sessionId` | Disposal confirmation |
| `scene_render_submit` | `sessionId`, `expectedRevision`, `settings` | Snapshot job ID and queued record |
| `scene_render_status` | `jobId`, optional `response_format` | State and durable frame progress |
| `scene_render_cancel` | `jobId` | Cancellation acknowledgement |
| `scene_render_result` | `jobId`, optional `response_format` | Completed output paths and metrics; `response_format: "detailed"` adds the SHA-256 of each file |
| `scene_render_release` | `jobId` | Confirmation that owned job files were removed |

`sessionId` is the scene ID: `scene_create` and `scene_create_asset` return it, and every scene tool takes it. It is optional: a call that leaves it out means the last used scene. An ID that names no open scene (an invented one, one from a disposed scene, or one that was evicted) is rejected with the open IDs in the message, because acting on a scene the caller did not name could edit the wrong one.

One server keeps up to 4 scenes open, within 96 MiB of resident geometry together. The 96 MiB counts the geometry every open scene holds (including its revision history and checkpoints) plus the new one; an imported GLB counts its vertex, index and morph target buffers, and so does each GLB a scene places (once, however many times it is placed), while textures stay outside the cap, under the `--memory` budget, so a few large scenes (terrain, vegetation, imported models) can fill it before the fourth scene opens; small scenes reach 4. Creating a scene past either cap closes the least recently used scenes until both hold, and the create result lists them under `evictedSessions` with `evictionReason`, which names the cap that was exceeded and the MiB involved; a later call with that ID fails with an `evicted` error that repeats the reason. Save a scene with `scene_export_recipe` before it can be evicted. Only one scene holds the preview renderer at a time, so a call on another scene rebuilds it first; that costs a moment, so finish a batch of calls on one scene before switching.

Each scene keeps up to 16 checkpoints. `scene_checkpoint` returns `checkpointId`; past the limit the oldest checkpoint is evicted and the result lists it under `evictedCheckpointIds`. A `checkpointId` belongs to the scene that returned it. A render job stays tied to the scene it was submitted for. While a job runs the preview renderer is leased, so `scene_create`, edits and disposal wait for it, as before.

### Review link

A person who is not at the agent's keyboard can mark a scene on a phone. `scene_export_web` with `review: true` needs no game: it renders the current view and writes `index.html` and `frame.png` under `<jobs>/exports/`, in the same folder and with the same newest-four retention as game builds. Host the folder on any static server or send it as is. The reviewer taps the picture to drop a pin (up to 16), writes a note for each, and presses Save file or Copy. Two fingers zoom and move the picture and never drop a pin. The page is a still, so it does not orbit.

Pass the text of the saved file to `scene_ask_user` as `reviewFile` (at most 16 KiB). The answer has the same fields as a local `scene_ask_user` call (`marks` with `partId`, `point`, `normal`, `note`, and the camera in `result.view`), without the marked PNG. The server keeps the camera of the last 8 review exports in memory, so the file carries only the marks and cannot choose the camera the server casts their rays from. Each export is read once: a second read of the same file, a file from an earlier server run, from an export dropped after 8 newer ones or disposed with its scene, or for another scene is refused with a message that says to export again. A review file proves nothing about who made it: the review ID is written into the exported page, so anyone who can read that folder, a model with file access included, can write a valid file. Unlike the inline view's nonce, which the model never sees, treat a review file's marks as notes from whoever had the page.

### Tool errors

Every error an agent can reach names what failed and what to do next. `tests/tool-errors.test.js` walks the triggers and fails on a message with no next action. A JavaScript engine fault (a `TypeError` such as reading a field of `undefined`, from a bug in the server) never reaches the agent: the agent gets one advice message (check the scene with `scene_inspect`, retry once, leave out the optional field, report the tool), and the detail goes to the server's stderr. A failed `scene_create` or `scene_create_asset` ends with "No scene was created ... call scene_create again", so the agent retries instead of calling `mesh_inspect` on nothing. `scene_inspect` on an imported asset takes a source-node ID (`node-40`) when the node holds exactly one part, and names the parts when it holds several. `tests/agent-preview-modules.test.js` walks every preview path (look, labels, review, snapshot, frame, GLB export, branches, mesh reports) in a fresh process where the on-demand scene modules start unloaded. `scene_apply` also names the fix when `set-node` or `set-material` fields are wrapped in a `node` or `material` key.

### Tool cost and diagnostics

Every tool schema is read on every turn, so `node scripts/measure-tool-cost.mjs` reports the bytes and estimated tokens of each schema and of each typical result, and `npm run tool-cost` fails a pull request when one grows past its allowance against the base branch (`bench/tool-cost/README.md`). The current total is the last line of that script's output, and `bench/tool-cost-ceilings.json` holds the ceiling it may not pass. To save space, a mesh geometry's `edits` and `stack` in a recipe, and `motion` in `scene_apply` and asset recipes, are advertised as plain objects: the full field list is in `mesh_edit`, `mesh_stack` and `scene_create`, and the backend still validates every field and names the valid choices when one is wrong. A small mesh change is far cheaper as `mesh_edit` (187 bytes in the measured case) than as a whole recipe rewrite (1,254 bytes with the dispose).

`mesh_inspect` lint adds warnings for `intersecting-parts`, `self-intersection`, `thin-wall`, `floating-part` and `asymmetric`. They never set `ok` to false, run within face budgets, and list any check they skipped in `skippedChecks`. `scene_inspect` returns a `diagnostics` list only when there is something to say: ignored material fields, blended transmission, unused materials or geometries, `reflection-skipped` (smooth metal keeps only the sky reflection because the automatic object probes were skipped: over 200000 triangles, too many reflective or other parts; the message names the count and the limit, the fix is fewer triangles or `environment.objectReflections` false, and `scene_apply` carries it too), and for imported assets the decoder's not-drawn features, rigs with no joints or no skin, and assets with no clips. Each item has `kind`, `severity`, `target`, `message` and `fix`.

`scene_inspect` (and so `scene_apply` and `scene_review`) adds an `unsupported-part` warning when a part hangs off what it rests on: a building with half its footprint past the edge of a rock. It casts 16 rays up from a grid over the part's footprint, at its lowest point; a ray is held up when another part has a surface within 2 cm of that point, or inside the part's own height (a building sunk into terrain). The warning names the part, the support and the unsupported share, and fires when under 70 percent of the footprint is held up. It stays quiet for a part with nothing under it at all (hovering on purpose), a part whose supports all sit inside its own footprint (a roof over walls, a table top on one pedestal), the lowest parts of the scene (they rest on the floor), animated, simulated and particle nodes, clouds and blended or additive parts. It checks the 64 largest footprints, skips parts under 10 cm wide and skips scenes over 400,000 triangles. The check lives in `src/unsupported-part.js`, loads on demand and reads the parts as drawn at the rest pose.

`scene_look` honours `width` and `height` up to 1024 each. The one cap on top of that is the 1 MiB response budget for the PNG, counted in bytes, so a calm scene keeps its whole size and a busy picture (hatching, line art, planks, bricks, emissive text) may not. When a busy picture encodes over the budget, the preview renders again at the scale that should fit (at most 0.9, at least 0.5 of the size, with the aspect kept), up to four times. Every look says what happened in `size`: `{ requested: { width, height }, returned: { width, height }, capped, maximumBytes }`. When `capped` is true, `returnedWidth`, `returnedHeight` and a `note` name the smaller size too; ask for that size or smaller to skip the retry. It fails only when the smallest step still does not fit.

`scene_look` returns the same kind of `diagnostics` list next to the picture, so an agent can check a frame without reading it. The findings carry the part names and the numbers in fields, and each list is capped (8 parts per finding, 8 findings per kind, with `nodeCount` or `droppedCount` saying how many were left out):

| kind | fields | meaning |
| --- | --- | --- |
| `floating-node` | `nodes`, `gapMeters`, `nearest` | The part is more than 2 cm from every other part and from the floor level (the lowest point of the scene). `nearest` is the closest part or `floor`. |
| `intersecting-nodes` | `nodes`, `penetrationMeters` | The bounds of two parts overlap by 2 cm or more on every axis. Bounds are axis aligned, so a rotated part can report an overlap its surface does not have; a part sunk into a small ground is reported too. A pair is skipped when one box covers the other's footprint and is 20 times its volume and 10 times its longest side (a terrain, room or bowl whose bounds enclose what rests in it). |
| `part-outside-frame` | `nodes`, `outsideCount`, `partCount` | Parts whose bounding sphere is outside the camera frustum or behind the camera. When more than half are outside, `subject-out-of-frame` is returned with the same fields instead. `scene_look` and the first frame of a path traced job report `part-outside-frame` and the two placement kinds; raster render jobs do not (they would repeat for every frame of a moving scene) and keep one `subject-out-of-frame` entry however the count changes. Texture and z-fighting findings are reported by `scene_look`, raster jobs and path traced jobs alike. |
| `texture-missing` | `nodes`, `field`, `material` | A material names a texture the renderer cannot draw: its `map`, `normalMap`, `metallicRoughnessMap`, `emissiveMap`, `occlusionMap`, `aovMap` or `transmissionMap` has no image, an image of no size, or fewer pixel bytes than its size needs. The parts draw flat where the texture should be. Parts that share a material are one finding. A catalog image that is absent already fails `scene_create` with an error, so this finding covers a scene whose image went missing after it was built. |
| `coplanar-overlap` | `nodes`, `parts`, `area` or `reason` | Z-fighting: two parts draw the same plane (`area` in square metres), or the draw-time ranking could not settle a part (`reason`: `rank-overflow`, `double-sided-gap`, `unchecked` or `collapsed-node`). A scene by default ranks flush faces, so `scene_look` reports only what the ranking left over; a scene with `environment.resolveCoplanar: false` gets the pairs. The check is bounded by a work budget and says when it ran out. |
| `exposure-clipped`, `exposure-black` | `whitePercent`, `blackPercent`, and `lights` on a clipped frame | Share of a 64 by 64 copy of the frame that is clipped to white (35 percent or more) or black (98 percent or more) after tone mapping. A clipped frame also lists its three strongest lights (`{ field, intensity }`, such as `environment.pointLights[1].intensity`), and its fix names the strongest, so an over-exposed light can be found without opening the image. |

The checks run on part bounds, material fields and that small copy of the frame, so they cost almost nothing. None of them reads an object ID pass: parts are named from the scene itself, so the findings are identical on the cpu and gpu backends. The object ID, depth and normal passes exist in every raster render job (`settings.passes`). A path traced job (`renderer.type` `pathTracer`) writes the lit image only: it has no passes, `passes` is refused with a message that says so, and the job's `metrics.diagnostics` carries the part findings of its first frame plus one `findings-unavailable` entry (severity `info`) saying that exposure findings and the passes are unavailable there and why. Check exposure with `scene_look` or a raster job before tracing. On a daylit interior the traced frame is about 1 to 2 stops brighter than the raster one at the same exposure (measured table in `docs/path-tracer.md`, Exposure), so lower the exposure for the trace. Scenes of over 256 parts get no floating or intersection findings. `src/frame-checks.js` holds them.

The recipe uses `format: 'crucible.scene'` and `schemaVersion: 1`.
Primitive sizes come from the node scale: a `box` is a unit cube, and `cylinder` and `sphere` have radius 1, so scale x and z (cylinder) or scale (sphere) is the radius, never the diameter. A 6-segment cylinder is a hexagonal prism with its corners on X (2 x scale apart) and its flats on Z (1.732 x scale apart); for a hex part W wide across the flats, scale x and z by W / 1.732.

Supported geometry types are `box`, `cylinder`, `sphere`, `torus`, `lathe`, `extrude`, `tube`, `curve`, `sdf`, `text`, `grid`, `terrain`, and `mesh`. The fields of `curve` and `text` are listed by `scene_capabilities` (`curveText.details`) and not repeated in every tool schema. Text uses the bundled font only; the MCP accepts no font file or URL.
A `mesh` geometry starts from one of the others as `base` and replays an edit log; see [mesh.md](mesh.md).
Geometry fields remain flat inside each geometry record.
Set operations use `set-node`, `set-material`, or `set-camera`, with fields directly on each command.

`set-motion` accepts a complete motion record or `null` to clear it, or `removeTracks` selectors to drop some tracks.
`scene_look` can seek procedural `motionTime` without changing revisions. Omission preserves the last preview pose.
An explicit `null` restores the authored base pose. Release `0.8.0` also supports imported source-node motion.
Imported clip sampling remains available through `set-animation`.

`scene_ask_user` is for a change the person cannot put in words. It renders the current view, opens it in their default browser on a loopback address under a random path, and waits up to `timeoutSeconds` (default 300, at most 900) for them to pin up to 16 points with a note of at most 280 characters each and press Send. Each mark comes back with its pixel, the `partId` and world `point` and `normal` the pin lands on (all `null` on empty sky), the `distance` from the camera and the part's `material`, plus the `result.view` camera and a PNG with the numbered pins. A cancelled or timed-out page returns `outcome` `cancelled` or `timeout` with no marks. Nothing leaves the machine and the tool takes no code or remote URL.

The page also offers three more mark tools alongside pins, all counting toward the 16 mark limit:

- `lasso`: the person draws a closed outline around a region (3 to 64 points, thinned from the pen stroke) and adds a note, so one mark can mean "these parts". It comes back with the pin fields plus `kind` `"lasso"`, `points` and `parts`. `parts` lists the parts under the outline, most covered first, each as `{ partId, samples, coverage, material }`: the server picks a fixed 24 by 24 grid of pixels over the outline's bounding box, keeps the ones inside it (even-odd rule) and runs the same pick as a pin on each, so `coverage` is the share of those pixels a part holds (pixels on empty sky count toward no part, so the shares may add up to less than 1). `pixel`, `partId`, `point`, `normal`, `distance` and `material` are those of the most covered part, taken at the picked pixel nearest the outline's centre; `parts` is empty and `partId` `null` when the outline holds only sky. A part under 0.15 coverage carries `edge: true` and stays listed: it only grazes the outline.
- `color` {since 0.23.0}: the person picks a target colour in the colour picker and clicks a spot on a rendered part. It resolves the hit part, world `point`, `normal`, `distance` and `material` just like a pin, and returns `kind` `"color"`, `color` (linear RGB `[r, g, b]` from 0 to 1, ready for `set-material`), `hex` (normalized `"#rrggbb"` sRGB) and `note`.
- `view` {since 0.23.0}: the person frames a camera view (orbit, pan, zoom and `fov` from 5 to 120 degrees; the browser page re-renders the live preview as they move) and captures it with Save view. It returns `kind` `"view"`, `camera` (`{ eye, target, fov }`) and `note`, without altering the scene revision.

A part whose material is also used by parts outside a pin, `color` or `lasso` mark carries `materialSharedWith` (those part IDs, sorted, at most 8, plus `materialSharedWithMore` with the count left over): recolouring that material would change them too, so give the part its own material first. Both the local browser page and the inline chat view offer all four mark tools (`Pin`, `Lasso`, `Color`, `Save view`), while the exported review page takes pins only. `motionTime` (0 to 3600 seconds) first seeks the scene's authored motion to that time, like `scene_look`, so a film scene can be marked at one moment: the picture shows that moment, the marks are resolved with the scene put back at it, and `result.view.motionTime` in the answer names it (left out for a scene with no motion). Not yet marks: dragged transforms (issue #922 lists them).

#### Inline in chat apps (MCP Apps)

A client that lists the MCP Apps extension (`io.modelcontextprotocol/ui` with the `text/html;profile=mcp-app` mime type in its `initialize` capabilities) gets the same view inside the conversation instead of a browser tab. This follows the MCP Apps spec of 2026-01-26 (SEP-1865). For that client only, the server turns on three things: the resource `ui://crucible/annotate` (one self-contained HTML page of at most 32 KiB, with no remote asset and no script from the model), a `_meta.ui.resourceUri` link on `scene_ask_user`, and the app-only tool `scene_ask_user_submit` (`_meta.ui.visibility` `["app"]`). `scene_ask_user` then returns at once with the rendered PNG and `outcome` `pending`, the view size and the limits, and a random 128-bit nonce in the result `_meta` only; the page draws the pins, calls `scene_ask_user_submit` with that nonce, the marks and the marked PNG through the host, and tells the chat the answer, which has the shape of a browser answer (`outcome` `sent`, marks with `partId`, `point`, `normal`, `note`). The nonce stays out of the content the model reads, because `visibility: ["app"]` is only a hint to the host: a model that could read it could call the submit tool and pass its own marks off as the person's. A nonce works once, the server keeps the last 8, and one expires after `timeoutSeconds` (default 300) with an error that says the person did not send in time; closing the server or disposing the scene drops it, and a failed pick leaves it open for a retry. Every other client sees the same tool list and the same browser flow as before. The page speaks the few `ui/` messages it needs itself, so there is no new dependency. Checked here with a mock host in a sandboxed iframe; Claude Desktop and VS Code have not been tried.

### Render estimate and report

`scene_render_submit` returns `estimate` beside the job record, so an agent can see what a job costs on this device before it waits for it: `seconds`, `peakMemoryMiB` (Node plus browser heap), `framesPerSecond`, `basis` and the scene numbers it used (`parts`, `triangles` counting every placed node and the geometry of placed assets, vegetation and crowds (the larger of the node list and half the resident vertex count), `materials`, `textures`, `lights`). `scene_capabilities` topic `jobs` has the one-line summary.

The estimate is a fixed cost model in `scripts/agent-render-estimate.mjs` (`COST_MODEL`): a start-up cost, a scene build cost per triangle, a per-frame cost from pixels, triangles, lights and passes, and for the path tracer a cost per pixel, sample and bounce (capped by `renderer.maxSeconds`) plus a build cost per triangle. The first GPU path trace in a server process adds about 10 s for its kernel. The same scene and settings always give the same numbers. The constants were fitted to jobs measured with `node scripts/measure-render-estimate.mjs`, which renders a small, a medium and a large scene and prints estimate against measurement; run it again after changing the model.

Measured on 2026-11-15 with `node scripts/measure-render-estimate.mjs` (RTX 3060, small, medium and large scenes, image, video and path trace jobs): the measured time over the estimate was 0.54 to 1.51 across the 10 jobs and the peak memory over the estimate 0.64 to 1.01, so the estimate stays within a factor of two.

The runtime keeps the last 16 jobs run from this jobs folder in `render-history.json`: each entry holds the model's estimate and the measurement of one finished job, with its kind (raster or path tracer, image or video, backend). Once two jobs of the same kind are there, the estimate is multiplied by the median measured-over-estimated ratio of those jobs, never by more than 4 either way, and `basis` says so, including when the time factor hit the 4x limit and when memory had too little history of its own. A job that ran at a smaller size than requested (the memory budget cut the frame) is recorded too, against the model's numbers for the size it really ran at, so a server whose default `--memory` always cuts the frame still learns. The file stays on the machine; a damaged file counts as no history. `modelSeconds` and `modelPeakMemoryMiB` are the numbers before this correction.

The jobs folder holds at most 512 MiB. A submit holds free space for the job's own estimated output (never more than 128 MiB), so small jobs leave room for many more results. When the folder is full, jobs you already read with `scene_render_result` are released oldest first; if that is not enough, the refusal names the three largest finished jobs and their sizes to read and free with `scene_render_release`. A job that writes more than it held stops as failed when the folder has no room for another frame. Its message names the job to release, since its partial output still holds space.

When a job completes, `scene_render_result` has `metrics.report`, one record of what happened: `measured` (`seconds`, `peakMemoryMiB`, `frames`, `secondsPerFrame`), the `estimate` it was compared with and `secondsRatio` (measured over estimated), `samplesDrawn` and `samplesRequested` for a path trace, `noise` for a path trace, and `fallbacks`, a list of sentences for everything that ran differently from the request (a frame cut down to fit `--memory`, a backend that fell back, a denoiser that was swapped). A native trace that compiled kernels for at least one second across the job adds `kernelCompile` (`seconds`, `frames`, `note`): the first trace of each scene variant compiles, the time counts in `seconds` and `secondsRatio`, and the estimate history learns the job without it. `noise.relative` is the estimated noise of the frame before any denoiser: the root mean square of each pixel's standard error (from the tracer's variance buffer) over the frame's mean luminance, so 0.03 means a typical pixel is off by 3% of the average brightness. `noise.verdict` says what to do: from 0.03 up it is `noisy: raise renderer.samples or set renderer.denoise` (only `raise renderer.samples` when a denoiser already ran), below it `clean enough`. The line sits between a 4 and a 16 sample trace of one small lit test scene (0.038 and 0.020); it comes from those numbers, not from a survey of scenes. Under 2 samples per pixel, or on a black frame, `relative` is `null` and the verdict says it was not measured. A raster job has no `noise`. The concise answer keeps only `seconds`, `secondsRatio`, `fallbacks`, the `kernelCompile` note and a measured `noise` of it; the detailed answer has the whole record and the raw counters it is built from (`peakNodeBytes`, `peakBrowserHeap`, `elapsedSeconds`).

Limits of the estimate: it covers a job's own time, not the wait for a busy machine; memory is the sampled Node RSS plus the browser JS heap, which is a lower bound for GPU memory; path tracer estimates assume the CPU or GPU backend named in the settings, and a native tracer that cannot run falls back (see `fallbacks`).

### Render budget

`settings.budget` lets a job choose its own renderer and size from what you can spend: `{ "secondsPerFrame": 2 }` for an offline render, `{ "framesPerSecond": 30 }` for a realtime preview, and optionally `"memoryMiB"` (64 to 65536) as a cap on the estimated peak memory. Give exactly one of `secondsPerFrame` (0.001 to 3600) and `framesPerSecond` (0.01 to 240). `width` and `height` stay the largest frame you want; `renderer` must be left out, because the budget picks it. A job that cannot go through the path tracer (`passes`, `transparent`, `region`, `multilayer`, a `format` other than png) only considers raster.

The runtime estimates these candidates with the cost model above (history correction included), best looking first, and takes the first one that fits: the path tracer at 256, 64 and 16 samples with `denoise: true` (OIDN when its package is installed, else the wavelet filter) at full size on the runtime's backend, then the raster renderer at full size, 0.75, 0.5 and 0.25 scale (sides rounded, even for video, at least 64). Each candidate belongs to a quality tier (below): the path tracer is `final`, the full size raster frame is `realtime-high` (`realtime` on a runtime without a GPU), and a smaller raster frame is `draft`, and `picked.tier` says which. Both sides of the raster frame shrink by one factor, so the aspect holds, and the short side stays at least 64 px; a size that repeats the previous candidate is dropped. A job with `region` keeps the full frame, because the region is in full-frame pixels. A candidate that cannot be estimated is skipped and listed in `skipped`. A candidate fits when its estimated time is at most 85% of the budget, because the estimate is only good to a few tens of percent, and its estimated peak memory is within `memoryMiB`. With `secondsPerFrame` the time is the whole job divided by its frames, so startup and scene build count, and a single image can never fit a very small budget. With `framesPerSecond` the time is the per-frame cost only: it is a render-speed budget, not `settings.fps` (the video's own rate), and startup and scene build (`estimate.fixedSeconds`) are reported in `warnings` instead. The server's `--memory` render-target cap can still shrink the frame while the job runs; `warnings` says so, and also when `memoryMiB` is above that cap. `metrics.report.fallbacks` in the result lists a reduction. The same scene, budget and history always give the same pick.

`scene_render_submit` returns `budget` beside `estimate`: `requested`, `picked` (label, size, renderer or `raster`, expected seconds per frame and memory), `fits`, `reason` (which better candidate was too expensive, or why nothing fits) and `considered`, every candidate with its expected cost. When nothing fits, the cheapest candidate runs anyway and `fits` is false; raise the budget or shorten the job. `scripts/measure-render-budget.mjs` submits tight, middle, loose and 30 fps budgets on two scenes and prints what each picked beside the measured time.

### Render quality

`settings.quality` names what a render is for, so a caller need not know the renderer behind it. The same scene renders in every tier from calls that differ only in `quality`.

| Tier | For | What runs |
| --- | --- | --- |
| `draft` | A quick look | Glaze with light shading, no multisampling and coarse level of detail (a mesh switches at 4 pixels of error) |
| `realtime` | Interactive use | Glaze at the preview's own settings: 4 samples, full shading |
| `realtime-high` | The best frame Glaze draws | Glaze with 8 samples and fine level of detail (0.5 pixels of error). Needs a hardware GPU. The real-time path tracer planned for this tier (#901, #902) is not reachable from the MCP tools yet |
| `final` | Offline images | The path tracer at 256 samples with `denoise: true` (OIDN when `@codepawlhq/crucible-denoise-oidn` and its binary are installed, else the wavelet filter, named in `denoiserNote`), on `native` when the optional package and a ray query adapter exist, else `gpu`, else `cpu` |

`quality` picks the renderer, so leave `renderer` and `budget` out: `budget` picks the tier from a limit (`picked.tier` in its report), `quality` fixes it. `width`, `height` and the rest keep their meaning.

A tier the device or the job cannot run falls back one tier, repeating until one can. `scene_render_submit` returns `quality` beside `estimate`: `requested`, `picked`, and when it fell back `steps` (each with `from`, `to` and `missing`) and a `message` such as `quality final could not run, so realtime-high ran: final lacks a job the path tracer can draw (it writes only the lit PNG image, and this job asks for passes).`. The missing capability is one of: a hardware GPU (`realtime-high` on a SwiftShader runtime, which draws one sample per pixel), a lit PNG (`final` with `passes`, `transparent`, `region`, `multilayer` or a `format` other than png), or a trace that fits (`final` when the estimate puts one frame past the path tracer's 120 s `maxSeconds`, as a 1080p or long job on the cpu backend would be: the job would fail at the limit, so it runs as `realtime-high` or `realtime` instead). `scene_capabilities` topic `jobs` lists `tiers` for this device: each with `available`, what `runs` it, or `missing` and `fallsBackTo`. The MSAA count a GPU actually grants is negotiated by the driver and is not checked at submission; `scene_look` and the job's render metrics report it.

#### Measured cost per tier

`node bench/tiers/measure-quality.mjs --runs 5` (run it through the GPU lock) renders one scene (a floor, 120 spheres and 4 point lights) at 960 by 540 in each tier through the MCP runtime, five runs a tier after a warm-up, and writes the JSON. Reference machine: RTX 3060 12 GB (driver 621.14), Intel i7-14700KF, Node 24.19.0, Chrome headless on D3D11, idle card, 2026-11-13. Job time is the whole job (page start, scene build, draw, capture); frame time is the draw or the trace alone; RAM is the sampled Node RSS plus browser heap; VRAM is the largest rise of the card's used memory in the runs, sampled every 100 ms, so a short raster job can show less than it used.

| Tier | Ran as | Job time (s) | Frame draw or trace (s) | RAM (MiB) | VRAM rise (MiB) |
| --- | --- | --- | --- | --- | --- |
| `draft` | Glaze, light | 0.91 | 0.0076 | 321 | 0 |
| `realtime` | Glaze | 0.89 | 0.0075 | 377 | 3 |
| `realtime-high` | Glaze, 8 samples | 1.05 | 0.0089 | 388 | 31 |
| `final` | path tracer, gpu backend, 256 samples | 29.71 | 28.70 | 173 | 418 |

On this scene the three raster tiers cost about the same, because capture and page start dominate a small frame; they differ in picture more than in time here. The tier benchmark in `bench/tiers/README.md` has the picture quality of each against Cycles and EEVEE.

#### Budgets pick different tiers

The same run submits two budgets on the same scene. `{ "framesPerSecond": 30 }` on a 60 frame, 480 by 270 video picked `realtime-high` (expected 0.020 s per frame) and measured 0.016 s per frame against the 0.0333 s limit. `{ "secondsPerFrame": 60 }` on a 960 by 540 image picked `final` (expected 29.7 s) and measured 41.7 s against the 60 s limit. Both met their budget; the same tier measured 29.7 s in the tier table, so one run varies by about 40 percent.

### Response format

`scene_review`, `scene_render_status`, `scene_render_result` and `scene_capabilities` take `response_format`: `concise` or `detailed`.
Leave it out for the default: `concise` on the first three, `detailed` on `scene_capabilities`, whose notes are the reason to call it.
Concise review drops the per-shot resource counters, memory peaks and unset clocks, and keeps each shot's camera, label positions and branch.
Concise status gives `jobId`, `state`, `frames`, `frameCount`, `reason` and the artifact names.
A failed job always fills `reason` (the field is `reason`, not `error`); a job that stops without a message says so and names `scene_render_submit` as the retry.
Concise result drops the SHA-256 digests and the render's resource counters; its other metrics (passes, depth range, object names, sync) stay.
Concise `scene_capabilities` drops the one-line notes of a schema topic and keeps field names, types, ranges and enums.
Pass `detailed` to get the earlier full answer. On a four-shot review the concise text is 657 bytes against 2,534 detailed.

`scene_review` compares up to four cameras or motion samples without changing the source recipe, revision or preview pose.
A review camera takes `eye`, `target`, `up`, `fov`, `near` and `far`; a field such as `focalLength` is refused by name, with `fov` in degrees as the fix. A review that passes its 30 second deadline says how many shots finished and how many to ask for.
Each shot starts from the authored base pose. The [review guide](agent-review.md) describes separate clocks, dimensions and resource limits.

`scene_apply` with a `branch` name forks instead of editing: the operations run on a scratch copy and the result is stored as that branch, so the scene, its revision and its checkpoints stay as they are. Branches are named with lowercase letters, digits, `_` and `-` (at most 24 characters); up to eight can exist, and branches that end in the same recipe share one snapshot. `scene_restore` with `branch` replays that branch's operations on the scene as one revision and drops every branch; it fails if the scene changed since the fork. Procedural scenes only; a scene that places catalog GLBs forks too, and a branch may place more of them. See the [review guide](agent-review.md#compare-branches-and-read-labels).

`set-node` can rebind a mesh to another geometry/material pair.

The tool schema types the common operations one by one. Rarely used ones (`bake-motion`, `fracture-node`, `add-explosion`, `settle`, `set-armatures`, `set-physics`, `set-cloth`, `set-timeline`, `set-particles`, `set-bake`, `set-pixel-grid`, `set-post-passes`, `set-game`, `set-shadow` and `remove-material`) share one branch to keep every turn smaller: their fields sit beside `type`, `scene_capabilities` topic `applyOperations` lists them, and the backend checks them and names the fix.

The recipe also accepts [authored lighting, fog, effects and shadow coverage](agent-look.md).
Use `set-environment`, `set-effects` and `set-shadow` with nested partial records to adjust the look.
Nested `volumeFog` and `bloom` fields merge. `pointLights` replaces the complete list.

`environment.lines` turns on outlines, toon light and polylines, and `lines: null` removes them. A material takes `toon` for its own light steps. The code loads only for a recipe that uses either. See [line art](line-art.md).

`postPasses` (set with `set-post-passes`, `null` clears) adds full-screen GLSL passes after the finished frame. A pass may list `objects` (part names, or a placed asset id for all its parts) to read which part is under a pixel with `objectSlotAt`. See [user passes](user-passes.md) for the rules. A compile failure comes back as `renderError` with the log mapped to the snippet's lines, and the session stays usable.

The preview allocates depth support at creation so enabling fog does not recreate render targets.
Active volume fog requires HDR support. Unsupported previews reject that edit before committing.

Build from an empty recipe by adding resources and nodes in one revisioned batch:

```js
[
  { type: 'add-geometry', geometry: { id: 'cube', type: 'box', bevel: 0.04 } },
  { type: 'add-material', material: { id: 'paint', color: [0.2, 0.6, 0.8] } },
  { type: 'add-node', node: { id: 'mesh', geometry: 'cube', material: 'paint' } }
]
```

Use `remove-node`, `remove-geometry` and `remove-material` with an `id` to remove entries. A geometry or material that nodes still use cannot be removed: the error names those nodes, so `set-node` them to another one or `remove-node` them first.
References must resolve after the complete batch. Removing a parent leaves its children unchanged unless `recursive: true` removes its subtree.
Reparent or remove those children before the parent removal command to avoid rejection.
The [scene contract](agent-scene.md) defines the geometry fields, transforms, materials, and atomic validation rules.

## Updates

`npx -y -p @codepawlhq/crucible crucible-mcp` reuses the copy npx cached on the first run, so a server can stay on an old version without anyone noticing. Each start therefore asks the npm registry once whether a newer version exists:

- **What is sent:** one `GET https://registry.npmjs.org/@codepawlhq/crucible/latest`, the same request `npm view` makes. It has no body and no identifier of ours. The registry sees what any HTTP request shows.
- **When:** in the background, so startup is never slower. The answer is cached in `<user cache folder>/crucible/update-check.json` (`$XDG_CACHE_HOME`, else `%LOCALAPPDATA%` on Windows, else `~/.cache`), and the registry is asked at most once a day. A timeout of 2 seconds ends a slow request. Offline or a registry error is silent.
- **What the agent sees:** when a newer stable version exists, the server `instructions` gain a short notice and the first `scene_capabilities` result carries `updateAvailable` with `current`, `latest`, `releaseNotes`, and the `update` command for each install route (`plugin`, `npx`, `project`). The first start after a new release may show the notice only in `scene_capabilities`, because `instructions` are read once and the answer can arrive after that. The agent tells the user and updates only after a yes.
- **Turn it off:** set `CRUCIBLE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`, or run with `CI` set. Nothing is requested or written then.
- **Ask by hand:** `crucible-mcp --version` prints the running version. `crucible-mcp --check-update` asks the registry now, prints the current and latest versions and exits.
- **Update:** plugin, `/plugin marketplace update Crucible` then `/plugin update crucible@crucible`; `npx`, run `npx -y -p @codepawlhq/crucible@latest crucible-mcp --version` once; project, `npm install @codepawlhq/crucible@latest`. Restart the client afterwards. The library itself makes no network request, and the plugin keeps its pinned start command.

## Call log

To see which tools agents use, set `CRUCIBLE_MCP_LOG=<file path>` before starting the server. It appends one JSON line per tool call: `time`, `tool`, `durationMs`, `ok`, `error` (`tool_error` or `thrown`, only on failure) and `resultBytes`. It never writes arguments, scene content or paths. With the variable unset nothing is written.

```sh
CRUCIBLE_MCP_LOG=calls.jsonl npx crucible-mcp
node scripts/summarize-mcp-log.mjs calls.jsonl other.jsonl
```

The script prints calls, errors, error rate and median duration per tool, most called first.

## Limits

| Budget | Limit |
| --- | --- |
| Open scenes | 4, within 96 MiB of resident geometry (placed GLBs included) |
| Nodes | 4096 |
| Geometries and materials | 256 each |
| Operations per batch | 256 |
| Checkpoints per session | 16 |
| Earlier revisions kept per session for `scene_restore` with `revision` | 4 |
| Geometry input points | 4096 per input, including all extrusion contours |
| Extrusion holes | 128 |
| Unique geometry vertices | 250000 |
| Unique geometry buffers | 32 MiB |
| Recipe or command JSON | 1 MiB |
| Incoming stdio buffer | 2 MiB |
| Preview dimensions | 64 to 1024 pixels per dimension (image jobs: up to 3840x2160, stills and video up to 1920x1080; `scene_capabilities` jobs lists both as `maximumWidth`, `maximumHeight`, `maximumPixels` and `maximumSequenceWidth`, `maximumSequenceHeight`, `maximumSequencePixels`; `maximumSquareSide` and `maximumSquareSequenceSide` give the largest square frame; a stills job with `stillCount` writes up to `maximumStillCount` numbered PNGs, see [agent-render-jobs](agent-render-jobs.md)) |
| Default preview dimensions | 768 by 512 pixels |
| PNG payload | 1 MiB |

The backend enforces combined budgets and numeric consistency beyond the advertised tool schemas.

Render targets can shrink to fit the configured memory budget.
Image metadata reports actual dimensions alongside requested dimensions and estimated render bytes.

An oversized PNG response returns an error. Request a smaller preview rather than treating the failure as an empty image.
Opening a browser page (the preview, a render job or a review page) and waiting for its preview to be ready may take up to 60 seconds on a busy machine, and an error that says the preview page did not load in 60 s means retry or run fewer jobs at once. Browser evaluations have a 30-second base deadline, doubled when `--gpu-queue` or streamed texture sequences are active, and `scene_create`, `scene_create_asset` and `scene_apply` add 1.5 more seconds per MiB of catalog assets, sequence frames, sources or grids sent to the page, at most 90 more, because the page decodes each file, scales its images and uploads them before the first draw (a 12 MiB hero asset with an 8K base colour and two 4K maps took 2 s on a free GPU and 13 to 70 s on a loaded one). Idempotent read-only preview calls (`scene_inspect`, `mesh_inspect`, `scene_walkmap`, `scene_look`, `scene_export_recipe`) tolerate one extra grace window before dropping sessions if a shared GPU stalls past the first deadline. When a call still times out, the error names the three largest placed files and says to shrink their textures, and closes the preview browser. A test harness that starts the server can raise it with `CRUCIBLE_TEST_PREVIEW_DEADLINE_SECONDS` (whole seconds from 30 to 180); the live smokes that render on SwiftShader set it so a loaded CI runner does not fail them. No tool call can set it.
Materials using `map: { sequence }` accept either `frames` or a catalog sequence `catalog` name, and support both `surface` and `unlit` tags (driving `emissiveMap` too when `emission > 0`).
Camera matrices must remain finite at every supported preview aspect ratio, from 1:16 to 16:1.

Geometry resources remain immutable. Remove an unused definition and add its replacement in one batch, or add a new resource ID and rebind its nodes.
Checkpoints retain their resource handles for exact restoration. Active, checkpoint and staged geometry share a bounded allocation budget.
Release unused checkpoints to free that ownership before adding detail.
The kept revisions share geometry buffers with the live scene, so four cost a recipe copy each (a few kilobytes) plus any geometry a later edit removed. That removed geometry counts in the same budget, and an edit that would exceed it drops the oldest kept revisions first instead of failing.

The preview reconciles rigid parts, textured ones with the `replace-textured-parts` addon, while retaining shader programs, render targets and shared geometry buffers.
A scene with material patterns gets a new renderer on each topology change instead. Skinned and morphed parts are not streamed either; `replaceParts` rejects adding or removing them.
Unchanged draw batches remain allocated. Changed instance groups receive new instance buffers. Retired buffers are released.

Staging must fit alongside the current render allocations, so a replacement can fail its GPU budget even when the final scene alone fits.
The committed revision and separate render failure remain visible in that case.
Request a smaller `scene_look` to release large frame targets before retrying reconciliation.

The [asset scene contract](agent-asset.md) defines root transforms, material overrides and absolute clip/time samples.
Imported scenes decode once, and `mesh_edit` and `mesh_inspect` take a part ID such as `mesh-10` to edit or check the topology of one imported part (see [the asset scene contract](agent-asset.md)); `mesh_stack` stays procedural.
Their bounds describe authored base vertices in the sampled world transforms, without claiming deformed skin or morph bounds.

The tools expose no arbitrary JavaScript execution, remote URLs or arbitrary caller-selected file paths. MCP accepts no host code at all. The one text that reaches a shader is a bounded GLSL fragment snippet in `postPasses`: at most 4 passes of 4 KB, with no preprocessor lines, no `while` or `do`, only counted `for` loops over integer literals (64 iterations at most), no `gl_` or `u67_` names beyond `gl_FragCoord`, and 16 declared numeric uniforms per pass. A strict validator refuses anything else, with the line, the column and a fix, before any compile. The same validator and limits cover the fragment hook of a material (`snippet`, one function of at most 4 KB, 16 uniforms, `mask` only the material's own map). See [user passes](user-passes.md).
Release `0.8.0` supports [imported source-node tracks](agent-character-motion.md) through the bounded motion recipe.
Facial morph track authoring and rig creation remain unsupported.
Render jobs use a configured private store and fixed output filenames.
`scene_export_glb` writes only to `exports/` inside that store, under a UUID name the server picks, with mode 0600; it keeps the newest eight files and caps each at 32 MiB.

See [render jobs](agent-render-jobs.md) for the snapshot workflow and storage limits.
Embedded texture decoding uses private browser blob URLs. Remote asset requests remain blocked.
The transport supplies a visual feedback loop, but visual quality still depends on the authored scene and image assessment.
MCP support does not establish Blender feature parity.

## Boundary tests

1. Run `node --test tests/mcp-tools.test.js`.

The tests use a real SDK client and linked in-memory transports.
They verify schemas, argument rejection, atomic revision errors, checkpoint behavior, and PNG content with structured metadata.
The adapter uses the real CPU recipe backend and a fixed PNG fixture.
These tests do not prove browser launch, GPU rendering, or final visual quality.

Run `node scripts/smoke-mcp.mjs gpu modern` for a native browser test through real stdio tools.
Run `node scripts/smoke-mcp.mjs cpu legacy` for the software backend and legacy protocol negotiation.
Each checks landscape and portrait PNGs, stale revision rejection, exact PNG restoration, session disposal, and process cleanup.
They build the scene from empty through tool calls, add and remove geometry, and restore the scene after all mesh resources were removed.
The scripts save images and metadata under `artifacts/`. They use one isolated browser and close it when finished.

Run `node scripts/smoke-agent-topology.mjs` to inspect native GPU allocations during a shared-geometry addition and restoration.
Its staging-budget failure must allocate no buffers and retain the previous rendered frame.
Use `node scripts/smoke-agent-topology.mjs cpu` for software rendering. Both modes also verify recovery through a smaller CPU preview under a 32 MiB budget.

Run `node scripts/smoke-agent-assets.mjs` for actual imported microscope and textured rig previews through CPU stdio tools.
The script checks content IDs, root edits, retained texture decoding, reverse animation sampling and exact checkpoint restoration.

Run `node scripts/smoke-agent-motion.mjs` for procedural motion through actual CPU MCP previews and jobs.
It checks shuffled PNG seeks, decoded MP4 frames, eight stills, active cancellation, source pose retention and checkpoint restoration.

Run `node scripts/smoke-agent-character.mjs` for a textured nine-joint astronaut through actual CPU previews and snapshot jobs.
