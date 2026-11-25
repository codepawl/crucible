# Feature map

Every surface a person or an agent can reach in Crucible, with the name the code uses, how to reach it and the file that owns it.
Use these ids instead of describing a feature by where it sits on the screen. Derived from `vite.config.js`, `site/`, `bench/`,
`bin/`, `scripts/mcp-server.mjs` and `package.json`. When you add a page or an MCP tool, add its block here.

Driver: `node scripts/drive.mjs <command>` ([scripts/drive.mjs](scripts/drive.mjs)). `list` prints this map, `shot <id>` saves a PNG
of a page, `console <id>` prints its console errors.

Block format, read by [scripts/drive-features.mjs](scripts/drive-features.mjs): a heading with the id in backticks, then `Name`,
`Surface`, `Reach` (a route in backticks that starts with `/` makes the feature a page the driver can open), `Source`, an
optional `Ready` expression the driver waits for, and `Drive`.

## Site pages

An id is the name in the `###` heading of its block, not a file name: `drive.mjs` takes the id as written there. The page the driver opens is the block's `Reach` route, and the files behind it are on its `Source` line. For a page under `site/` the id is usually the file name without `.html` (`site/recipes.html` is `recipes`; `site/recipe-dolly-zoom.html` is `recipe-dolly-zoom`), except `home`, which is `site/index.html`. A new page needs its own block before `list` or `shot` can find it.

### `home`
- Name: Home (pour-to-cast scroll story, install, showcase, agent and tier sections)
- Surface: Site
- Reach: `/`
- Source: `site/index.html`, `src/landing.js`, `src/landing-scene.js`, `src/landing-story.js`, `src/landing.css`
- Drive: `node scripts/drive.mjs shot home`

### `downloads`
- Name: Install (redirects to the home page downloads section)
- Surface: Site
- Reach: `/downloads.html`
- Source: `site/downloads.html`
- Drive: `node scripts/drive.mjs shot downloads`

### `getting-started`
- Name: Getting started (redirects to docs.html#install)
- Surface: Site
- Reach: `/getting-started.html`
- Source: `site/getting-started.html`
- Drive: `node scripts/drive.mjs shot getting-started`

### `docs`
- Name: Documentation (guides from docs/ and docs/learn/ rendered with live examples)
- Surface: Site
- Reach: `/docs.html`
- Source: `site/docs.html`, `src/documentation.js`
- Drive: `node scripts/drive.mjs shot docs`

### `changelog`
- Name: Changelog
- Surface: Site
- Reach: `/changelog.html`
- Source: `site/changelog.html`, `src/changelog.js`
- Drive: `node scripts/drive.mjs shot changelog`

### `showcase`
- Name: Showcase (scene picker; open one with ?scene=<name>)
- Surface: Site
- Reach: `/showcase.html`
- Source: `site/showcase.html`, `src/showcase.js`
- Drive: `node scripts/drive.mjs shot showcase`

### `marketplace`
- Name: Marketplace
- Surface: Site
- Reach: `/marketplace.html`
- Source: `site/marketplace.html`, `src/marketplace.js`
- Drive: `node scripts/drive.mjs shot marketplace`

### `recipes`
- Name: Recipes
- Surface: Site
- Reach: `/recipes.html`
- Source: `site/recipes.html`, `site/recipe-*.html`, `public/recipes/`, `scripts/recipe-catalog.mjs`, `scripts/make-recipe-pages.mjs`, `src/recipes.js`
- Drive: `node scripts/drive.mjs shot recipes`

### `tiers`
- Name: Render tiers (draft, realtime, final: time, card memory and error beside Blender, from the tier matrix)
- Surface: Site
- Reach: `/tiers.html`
- Source: `site/tiers.html`, `src/tiers.js`, `src/tiers-model.js`, `src/tiers.css`, `bench/tiers/results/tier-page-lit-interior.json`, `bench/tiers/make-tier-page-data.mjs`
- Drive: `node scripts/drive.mjs shot tiers`

### `recipe-dolly-zoom`
- Name: Recipe page, dolly zoom
- Surface: Site
- Reach: `/recipe-dolly-zoom.html`
- Source: `site/recipe-dolly-zoom.html`, `public/recipes/dolly-zoom.json`
- Drive: `node scripts/drive.mjs shot recipe-dolly-zoom`

### `object`
- Name: Object studio
- Surface: Site
- Reach: `/object.html`
- Source: `site/object.html`, `src/main.js`
- Ready: `window.__studio?.renderer`
- Drive: `node scripts/drive.mjs shot object`

### `motion`
- Name: Clockwork orbit (motion player)
- Surface: Site
- Reach: `/motion.html`
- Source: `site/motion.html`, `src/motion-player.js`
- Ready: `window.__motion?.renderer`
- Drive: `node scripts/drive.mjs shot motion`

### `nature`
- Name: Silverwater valley (nature viewer)
- Surface: Site
- Reach: `/nature.html`
- Source: `site/nature.html`, `src/nature-viewer.js`
- Ready: `window.__nature?.renderer`
- Drive: `node scripts/drive.mjs shot nature`

### `assets`
- Name: Asset viewer
- Surface: Site
- Reach: `/assets.html`
- Source: `site/assets.html`, `src/asset-viewer.js`
- Ready: `window.__assetViewer?.renderer`
- Drive: `node scripts/drive.mjs shot assets`

### `film`
- Name: OPPENHEIMER, a Crucible trailer study (film player)
- Surface: Site
- Reach: `/film.html`
- Source: `site/film.html`, `src/film-player.js`
- Ready: `window.__filmReady`
- Drive: `node scripts/drive.mjs shot film`

### `modeling`
- Name: Modeling (redirects to docs.html#procedural-modeling)
- Surface: Site
- Reach: `/modeling.html`
- Source: `site/modeling.html`
- Drive: `node scripts/drive.mjs shot modeling`

### `view2d`
- Name: 2D and orthographic views
- Surface: Site
- Reach: `/view2d.html`
- Source: `site/view2d.html`, `src/view2d.js`
- Drive: `node scripts/drive.mjs shot view2d`

### `file`
- Name: Scene file render (headless twin of the showcase, opened by scripts/render-media.mjs --scene file; it needs /__file/config.json, so the driver does not shoot it)
- Surface: Site
- Reach: page `site/file.html`
- Source: `site/file.html`, `src/file-scene.js`
- Drive: none: start it through `npm run render -- --scene file`

## Bench and sample pages

### `studio`
- Name: Scene studio (development page; Studio is not published on the site)
- Surface: Bench
- Reach: `/bench/studio/index.html?setup=off`
- Source: `bench/studio/index.html`, `bench/studio/main.js`, `src/studio.js`, `src/studio-setup.js`
- Ready: `Boolean(window.__studioPage?.renderer) && !document.getElementById("studio-loading")`
- Drive: `node scripts/drive.mjs shot studio`
- Check: `node scripts/studio-layout-audit.mjs` measures the spacing of this page, its menus and the setup dialog (`docs/studio.md`, "Spacing")

### `bench-agent-modeling-look-harness`
- Name: agent-modeling look-harness
- Surface: Bench
- Reach: `/bench/agent-modeling/look-harness.html`
- Source: `bench/agent-modeling/look-harness.html`, `bench/agent-modeling/look-harness.js`
- Drive: `node scripts/drive.mjs shot bench-agent-modeling-look-harness`

### `bench-animation-graph-index`
- Name: Animation graph sample
- Surface: Bench
- Reach: `/bench/animation-graph/index.html`
- Source: `bench/animation-graph/index.html`, `bench/animation-graph/main.js`
- Drive: `node scripts/drive.mjs shot bench-animation-graph-index`

### `bench-animation-graph-npc`
- Name: NPC path sample
- Surface: Bench
- Reach: `/bench/animation-graph/npc.html`
- Source: `bench/animation-graph/npc.html`, `bench/animation-graph/npc.js`
- Drive: `node scripts/drive.mjs shot bench-animation-graph-npc`

### `bench-crowd-harness`
- Name: crowd harness
- Surface: Bench
- Reach: `/bench/crowd/harness.html`
- Source: `bench/crowd/harness.html`, `bench/crowd/harness.js`
- Drive: `node scripts/drive.mjs shot bench-crowd-harness`

### `bench-flicker-index`
- Name: Crucible flicker viewer
- Surface: Bench
- Reach: `/bench/flicker/index.html`
- Source: `bench/flicker/index.html`, `bench/flicker/viewer.js`
- Drive: `node scripts/drive.mjs shot bench-flicker-index`

### `bench-gaussian-splats-harness`
- Name: Crucible Gaussian splat benchmark
- Surface: Bench
- Reach: `/bench/gaussian-splats/harness.html`
- Source: `bench/gaussian-splats/harness.html`, `bench/gaussian-splats/harness.js`
- Drive: `node scripts/drive.mjs shot bench-gaussian-splats-harness`

### `bench-gaussian-splats-three`
- Name: three.js Gaussian splat benchmark
- Surface: Bench
- Reach: `/bench/gaussian-splats/three.html`
- Source: `bench/gaussian-splats/three.html`, `bench/gaussian-splats/three-harness.js`
- Drive: `node scripts/drive.mjs shot bench-gaussian-splats-three`

### `bench-glaze-passes-harness`
- Name: Glaze pass timing
- Surface: Bench
- Reach: `/bench/glaze-passes/harness.html`
- Source: `bench/glaze-passes/harness.html`, `bench/glaze-passes/harness.js`
- Drive: `node scripts/drive.mjs shot bench-glaze-passes-harness`

### `bench-lighting-harness`
- Name: lighting harness
- Surface: Bench
- Reach: `/bench/lighting/harness.html`
- Source: `bench/lighting/harness.html`, `bench/lighting/harness.js`
- Drive: `node scripts/drive.mjs shot bench-lighting-harness`

### `bench-lighting-soft-lights`
- Name: lighting soft-lights
- Surface: Bench
- Reach: `/bench/lighting/soft-lights.html`
- Source: `bench/lighting/soft-lights.html`, `bench/lighting/soft-lights.js`
- Drive: `node scripts/drive.mjs shot bench-lighting-soft-lights`

### `bench-post-air-distortion`
- Name: post air-distortion
- Surface: Bench
- Reach: `/bench/post/air-distortion.html`
- Source: `bench/post/air-distortion.html`, `bench/post/air-distortion.js`
- Drive: `node scripts/drive.mjs shot bench-post-air-distortion`

### `bench-post-post-steps`
- Name: post post-steps
- Surface: Bench
- Reach: `/bench/post/post-steps.html`
- Source: `bench/post/post-steps.html`, `bench/post/post-steps.js`
- Drive: `node scripts/drive.mjs shot bench-post-post-steps`

### `bench-reference-default-look`
- Name: reference default-look
- Surface: Bench
- Reach: `/bench/reference/default-look.html`
- Source: `bench/reference/default-look.html`, `bench/reference/default-look.js`
- Drive: `node scripts/drive.mjs shot bench-reference-default-look`

### `bench-reference-depth-precision`
- Name: reference depth-precision
- Surface: Bench
- Reach: `/bench/reference/depth-precision.html`
- Source: `bench/reference/depth-precision.html`, `bench/reference/depth-precision.js`
- Drive: `node scripts/drive.mjs shot bench-reference-depth-precision`

### `bench-reference-harness`
- Name: reference harness
- Surface: Bench
- Reach: `/bench/reference/harness.html`
- Source: `bench/reference/harness.html`, `bench/reference/harness.js`
- Drive: `node scripts/drive.mjs shot bench-reference-harness`

### `bench-reference-line-art-harness`
- Name: reference line-art-harness
- Surface: Bench
- Reach: `/bench/reference/line-art-harness.html`
- Source: `bench/reference/line-art-harness.html`
- Drive: `node scripts/drive.mjs shot bench-reference-line-art-harness`

### `bench-reference-mesh-blend-harness`
- Name: reference mesh-blend-harness
- Surface: Bench
- Reach: `/bench/reference/mesh-blend-harness.html`
- Source: `bench/reference/mesh-blend-harness.html`
- Drive: `node scripts/drive.mjs shot bench-reference-mesh-blend-harness`

### `bench-runtime-harness`
- Name: runtime harness
- Surface: Bench
- Reach: `/bench/runtime/harness.html`
- Source: `bench/runtime/harness.html`, `bench/runtime/harness.js`
- Drive: `node scripts/drive.mjs shot bench-runtime-harness`

### `bench-runtime-loop-index`
- Name: Runtime loop sample
- Surface: Bench
- Reach: `/bench/runtime-loop/index.html`
- Source: `bench/runtime-loop/index.html`, `bench/runtime-loop/main.js`
- Drive: `node scripts/drive.mjs shot bench-runtime-loop-index`

### `bench-streaming-crossing-harness`
- Name: streaming-crossing harness
- Surface: Bench
- Reach: `/bench/streaming-crossing/harness.html`
- Source: `bench/streaming-crossing/harness.html`, `bench/streaming-crossing/harness.js`
- Drive: `node scripts/drive.mjs shot bench-streaming-crossing-harness`

### `bench-webgpu-tracer-harness`
- Name: webgpu-tracer harness
- Surface: Bench
- Reach: `/bench/webgpu-tracer/harness.html`
- Source: `bench/webgpu-tracer/harness.html`, `bench/webgpu-tracer/harness.js`
- Drive: `node scripts/drive.mjs shot bench-webgpu-tracer-harness`

## MCP server tools (bin/crucible-mcp.mjs, package crucible-mcp)

### `scene_capabilities`
- Name: Index of supported recipe features and runtime budgets; pass topic for the detail of one
- Surface: MCP
- Reach: MCP tool `scene_capabilities`
- Source: `scripts/mcp-server.mjs:952`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_create`
- Name: Create a render scene from a JSON recipe; the result has its sessionId
- Surface: MCP
- Reach: MCP tool `scene_create`
- Source: `scripts/mcp-server.mjs:960`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_asset_catalog`
- Name: List content-bound GLB, image, HDRI and look IDs from the asset directory and installed packs
- Surface: MCP
- Reach: MCP tool `scene_asset_catalog`
- Source: `scripts/mcp-server.mjs:961`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_create_asset`
- Name: Create the active scene from a catalog GLB and editable asset recipe
- Surface: MCP
- Reach: MCP tool `scene_create_asset`
- Source: `scripts/mcp-server.mjs:962`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_inspect`
- Name: Read revision, counts and selected nodes
- Surface: MCP
- Reach: MCP tool `scene_inspect`
- Source: `scripts/mcp-server.mjs:963`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_walkmap`
- Name: Walkable map on a grid: rows of 
- Surface: MCP
- Reach: MCP tool `scene_walkmap`
- Source: `scripts/mcp-server.mjs:964`
- Drive: none: needs an MCP client (`npm run mcp`)

### `mesh_inspect`
- Name: Check recipe geometries as polygon meshes: vertex, edge and face counts, triangles/quads/n-gons, connected and closed parts, face tags (top, bottom, side, left, right, front, back), bounds, and lint problems (non-manifold, inconsistent winding, inverted, degenerate, open, loose) with a suggested fix each
- Surface: MCP
- Reach: MCP tool `mesh_inspect`
- Source: `scripts/mcp-server.mjs:965`
- Drive: none: needs an MCP client (`npm run mcp`)

### `mesh_edit`
- Name: Append edits to a recipe mesh geometry or an imported asset part such as mesh-0 (or replace its edit log), atomically like scene_apply: extrude, inset, delete, flip, translate with falloff, tag, loop cut, bevel, mirror, array, solidify, UV unwrap, set_position and displace with field expressions (math, noise, attributes), booleans with a primitive cutter, sculpt brush strokes and shrinkwrap onto a primitive
- Surface: MCP
- Reach: MCP tool `mesh_edit`
- Source: `scripts/mcp-server.mjs:966`
- Drive: none: needs an MCP client (`npm run mcp`)

### `mesh_stack`
- Name: Set the non-destructive modifier stack of a recipe mesh geometry (ops and fields: scene_capabilities meshModifiers), evaluated after its edits, each prefix cached
- Surface: MCP
- Reach: MCP tool `mesh_stack`
- Source: `scripts/mcp-server.mjs:967`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_apply`
- Name: Atomically edit transforms, look, camera or materials
- Surface: MCP
- Reach: MCP tool `scene_apply`
- Source: `scripts/mcp-server.mjs:968`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_look`
- Name: Render the active scene as a bounded PNG, optionally with part labels
- Surface: MCP
- Reach: MCP tool `scene_look`
- Source: `scripts/mcp-server.mjs:969`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_ask_user`
- Name: Open the view in the browser so the person pins points with notes; waits for Send
- Surface: MCP
- Reach: MCP tool `scene_ask_user`
- Source: `scripts/mcp-server.mjs:976`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_fit_look`
- Name: Fit look parameters to reference colours by bounded least squares over OKLab region means
- Surface: MCP
- Reach: MCP tool `scene_fit_look`
- Source: `scripts/mcp-server.mjs:1211`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_review`
- Name: Compare one to four independent camera or motion samples in one labeled PNG grid
- Surface: MCP
- Reach: MCP tool `scene_review`
- Source: `scripts/mcp-server.mjs:980`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_checkpoint`
- Name: Save a private recipe snapshot
- Surface: MCP
- Reach: MCP tool `scene_checkpoint`
- Source: `scripts/mcp-server.mjs:999`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_restore`
- Name: Restore a checkpoint atomically using the current revision
- Surface: MCP
- Reach: MCP tool `scene_restore`
- Source: `scripts/mcp-server.mjs:1000`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_release_checkpoint`
- Name: Release one checkpoint slot
- Surface: MCP
- Reach: MCP tool `scene_release_checkpoint`
- Source: `scripts/mcp-server.mjs:1001`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_export_recipe`
- Name: Read a detached canonical JSON recipe for reproduction
- Surface: MCP
- Reach: MCP tool `scene_export_recipe`
- Source: `scripts/mcp-server.mjs:1002`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_export_glb`
- Name: Write the active scene as a GLB file in the configured jobs folder, under a server-chosen name (the result has the path, byte count and SHA-256)
- Surface: MCP
- Reach: MCP tool `scene_export_glb`
- Source: `scripts/mcp-server.mjs:1003`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_export_web`
- Name: Write the scene with its game as a static web build in the jobs folder: index.html, game.json and engine/, which any static host serves with no server code
- Surface: MCP
- Reach: MCP tool `scene_export_web`
- Source: `scripts/mcp-server.mjs:1004`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_dispose`
- Name: Dispose the active scene and its checkpoints, releasing renderer resources
- Surface: MCP
- Reach: MCP tool `scene_dispose`
- Source: `scripts/mcp-server.mjs:1005`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_render_submit`
- Name: Start one asynchronous snapshot job in the configured private job store
- Surface: MCP
- Reach: MCP tool `scene_render_submit`
- Source: `scripts/mcp-server.mjs:1006`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_render_status`
- Name: Read render job state and durable frame progress
- Surface: MCP
- Reach: MCP tool `scene_render_status`
- Source: `scripts/mcp-server.mjs:1007`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_render_cancel`
- Name: Request cancellation of one job
- Surface: MCP
- Reach: MCP tool `scene_render_cancel`
- Source: `scripts/mcp-server.mjs:1011`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_render_result`
- Name: Read completed local output paths, MIME types, byte counts, SHA-256 digests and measured render metrics
- Surface: MCP
- Reach: MCP tool `scene_render_result`
- Source: `scripts/mcp-server.mjs:1012`
- Drive: none: needs an MCP client (`npm run mcp`)

### `scene_render_release`
- Name: Delete the owned files and record for a terminal job, freeing store quota
- Surface: MCP
- Reach: MCP tool `scene_render_release`
- Source: `scripts/mcp-server.mjs:1016`
- Drive: none: needs an MCP client (`npm run mcp`)

## Command line

### `crucible-mcp`
- Name: MCP server over stdio; flags listed by `crucible-mcp --help` (bin/crucible-mcp-flags.mjs)
- Surface: CLI
- Reach: command `npx crucible-mcp`
- Source: `bin/crucible-mcp.mjs`
- Drive: none: not a page

### `crucible-pack`
- Name: Compiles a recipe into a runtime-only web bundle with a `<crucible-scene>` element (docs/pack.md)
- Surface: CLI
- Reach: command `npx crucible pack <scene.json> --out <dir>`
- Source: `bin/crucible.mjs`, `src/scene-pack.js`, `src/crucible-scene.js`
- Drive: none: not a page

### `crucible-packs`
- Name: Installs, lists and removes pinned data-only packs in the default pack folder that crucible-mcp reads (docs/packs.md)
- Surface: CLI
- Reach: command `npx crucible packs add <name>`, `npx crucible packs list`, `npx crucible packs remove <name>`
- Source: `bin/crucible-packs.mjs`, `bin/crucible-zip-reader.mjs`, `bin/crucible-pack-folder.mjs`, `bin/pack-pins.json`
- Drive: none: not a page

### `crucible-addon-check`
- Name: Checks an addon folder against the addon contract (docs/addons.md)
- Surface: CLI
- Reach: command `npx crucible-addon-check`
- Source: `bin/crucible-addon-check.mjs`
- Drive: none: not a page

### `npm-dev`
- Name: Vite dev server on 127.0.0.1:5173 that serves every page above
- Surface: CLI
- Reach: command `npm run dev`
- Source: `package.json`
- Drive: none: not a page

### `npm-build`
- Name: Release prepare, pack index and the production site build into dist/
- Surface: CLI
- Reach: command `npm run build`
- Source: `package.json`
- Drive: none: not a page

### `npm-preview`
- Name: Serves the built dist/ with the same cross-origin headers
- Surface: CLI
- Reach: command `npm run preview`
- Source: `package.json`
- Drive: none: not a page

### `npm-render`
- Name: Renders the film or a scene file to MP4 or stills (scripts/render-media.mjs)
- Surface: CLI
- Reach: command `npm run render`
- Source: `package.json`
- Drive: none: not a page

### `npm-docs-media`
- Name: Renders the documentation posters and loops from their live examples
- Surface: CLI
- Reach: command `npm run docs:media`
- Source: `package.json`
- Drive: none: not a page

### `npm-export-model`
- Name: Writes the built-in model as GLB into public/
- Surface: CLI
- Reach: command `npm run export:model`
- Source: `package.json`
- Drive: none: not a page

### `npm-smoke`
- Name: Browser smoke test of the core pages
- Surface: CLI
- Reach: command `npm run smoke`
- Source: `package.json`
- Drive: none: not a page

### `npm-smoke-mcp`
- Name: Smoke test of the MCP server
- Surface: CLI
- Reach: command `npm run smoke:mcp`
- Source: `package.json`
- Drive: none: not a page

### `npm-preflight`
- Name: Runs the pull request gates locally
- Surface: CLI
- Reach: command `npm run preflight`
- Source: `package.json`
- Drive: none: not a page

### `npm-test-affected`
- Name: Runs every test file that mentions the files you changed, or a module that re-exports them
- Surface: CLI
- Reach: command `npm run test:affected`
- Source: `scripts/test-affected.mjs`
- Drive: none: not a page

### `npm-test-fast`
- Name: Runs a deterministic 10 percent of the test files, seeded by the branch name
- Surface: CLI
- Reach: command `npm run test:fast`
- Source: `scripts/test-fast.mjs`
- Drive: none: not a page

### `npm-test-mutation-check`
- Name: Reverts your src, bin, packages and scripts changes, runs a test file and fails when it still passes
- Surface: CLI
- Reach: command `npm run test:mutation-check`
- Source: `scripts/test-mutation-check.mjs`
- Drive: none: not a page

### `npm-smoke-line-art-nodes`
- Name: Smoke test of per-node line art settings and the objectId node map, on a GPU
- Surface: CLI
- Reach: command `npm run smoke:line-art-nodes`
- Source: `scripts/smoke-line-art-nodes.mjs`
- Drive: none: not a page

### `npm-smoke-agent-texture-sequence-streamed`
- Name: Smoke test of a material map.sequence of more than 64 frames that streams frame by frame
- Surface: CLI
- Reach: command `npm run smoke:agent-texture-sequence-streamed`
- Source: `scripts/smoke-agent-texture-sequence-streamed.mjs`
- Drive: none: not a page

### `open-pr`
- Name: Opens a pull request that passes the PR metadata check, pushing evidence pictures for the new number
- Surface: CLI
- Reach: command `node scripts/open-pr.mjs`
- Source: `scripts/open-pr.mjs`
- Drive: none: not a page

### `push-evidence`
- Name: Pushes pictures and clips to the single evidence branch (pr-<number>/ folders; old evidence-pr-* branches stay) without touching the working tree
- Surface: CLI
- Reach: command `node scripts/push-evidence.mjs`
- Source: `scripts/push-evidence.mjs`
- Drive: none: not a page
