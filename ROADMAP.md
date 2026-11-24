# Crucible implementation roadmap

Crucible develops realtime web 3D and authoring tools for designers and AI agents, with browser Studio controls, deterministic animation and exported media.
This document separates shipping capabilities from work in progress. Performance claims require measurements on matching scenes and hardware.

The end goal is to be as capable as Blender, as light as three.js and as AI friendly as possible. `docs/goal.md` defines each part, and the GitHub milestones order the work. `docs/parity.md` in that repository records the coverage of each Blender feature.

## Available

- Instanced shared geometry, PBR lighting, shadows, MSAA, FXAA and ACES tone mapping.
- Object inspection, individual assembly explosion, environment controls and deterministic film sampling.
- GLB geometry export and streamed PNG/MP4 capture on hardware WebGL or CPU SwiftShader.
- Render memory estimates, capture guards, npm distribution and synchronized website release metadata.
- General keyframe animation with reusable transforms, material tracks and deterministic seeking.
- Optional HDR, bloom, color grading and reused render targets within the render budget.
- Orthographic front, right and top views, plus flat XY scenes with pan, zoom and capture.
- glTF/GLB mesh input, base-color textures, opaque vertex colors and rigid node animation.
- Landscape, portrait and square presets, time ranges and a generic capture interface for scenes and imported assets.
- Retained scene graphs, lathe and extrusion modeling, authored camera paths and deterministic clip mixing.
- Four-influence GPU skinning, relative morph targets and glTF morph weight animations.
- Material maps, local point lights and depth-clipped volumetric fog.
- Optional recorded Rapier physics with contacts, joint limits and bounded motors.
- Static sculpt brushes, clipped surface patches, shrinkwrap and bounded mesh contact and containment queries.

Version `0.5.0` includes agent scenes with stable IDs, atomic resource/node edits and checkpoints.
Version `0.6.0` adds persistent snapshot jobs with progress, cancellation and verified image/video outputs.
Version `0.7.0` adds recipe-owned procedural motion with deterministic node, material and camera sampling.
Version `0.8.0` adds source-node authoring on imported GLBs with retained rigs, morphs, textures and independent clip timing.

Version `0.9.0` adds isolated multi-angle and pose review with unchanged source revision and preview state.

Version `0.10.0` adds terrain, texture sets, vegetation, liquid playback, vehicles, retargeting, image-based lighting, alpha materials and compressed glTF input.
Version `0.11.0` adds `addons/mesh` for polygon editing, with booleans, bevel, loop cuts, UV unwrapping and a modifier stack. It adds the `mesh_edit`, `mesh_stack` and `mesh_inspect` tools, plus grass, clutter and moss.
Version `0.12.0` adds seeded procedural material patterns.
Version `0.13.0` adds `addons/skeleton-pose` with clip layers, masks and IK, and `0.13.1` and `0.14.0` make it work on real imported characters, including through MCP.
[CHANGELOG.md](https://github.com/codepawl/crucible/blob/main/CHANGELOG.md) lists every change, including work on `main` that is not released yet.

The stdio MCP server supplies twenty-two schema-backed tools and persistent CPU/GPU image previews.
Recipes retain lighting, volumetric fog, grading and directional shadow coverage with atomic edits and undo.
Imported asset sessions retain supported textures, rigs, morphs and clips from a configured local GLB catalog.

The npm package includes the prebuilt `crucible-mcp` command with lazy browser startup and bundled dependency licenses.

## Next

The work is ordered in six GitHub milestones. Each milestone lists its own issues.

1. Measure: benchmarks, size budgets and reference-scene scores that make each goal checkable.
2. Lighter: compile runtime-only web packs (#2178), sleep when idle and use compact HDR targets (#2179).
3. Modeling: close the mesh, rigging and procedural gaps against Blender.
4. Look: close the material, lighting and rendering gaps against Blender.
5. Motion and simulation: close the animation, physics and timeline gaps against Blender.
6. Agent surface: add a shared web Studio (#2177) for designers and lower agent tool cost.

## Longer term

Evaluate WebGPU after collecting WebGL2 bottleneck measurements.
Extend deformation with surface bindings, remeshing and authored humanoid rigs.
Improve character assets and cinematic environments through measured rendering and inspected reference frames.
Blender is the visual quality reference for authored scenes. Rendering parity and universal speed advantages remain goals that need evidence.

## Ideas (not scheduled)

Ideas that nobody is working on live here instead of as open issues, so the issue list holds only work to do. To take one up, open an issue that links its old number and says why it matters now.

### Agent surface

- Rain-night wet streets: long vertical streak reflections of lights on soaked roads (from #2874)
- Recipe performance budget with warnings and fixes (#2882)
- scene_compare: compare a render with a reference photo (#2880)
- Turntable preset for scene_review (#2878)
- Show the scene annotate view inline in chat apps through MCP Apps (#923)
- MCP: open a saved recipe file and change one post-pass uniform (#2285)
- Post passes: camera uniform, more than 64 motion keys, and scene_apply deleting a field (#2288)
- Studio: lock user-edited nodes or properties so an agent cannot overwrite them, with accept/revert review for each agent pass
- Studio: compare scene_apply branches directly in the 3D viewport (A/B or split view) and merge the chosen variant
- Project style lock: pin reference assets and rules (bevel scale, palette, texel density, detail budget) so agent-built assets match one art direction
- Spatial blockout to detail: place rough proxy boxes or guides in Studio for an agent to replace with fitted geometry
- Studio: expose recipe geometry parameters and mesh_stack modifiers as live controls in Properties
- Billboard `keepInView`: keep a label inside the frame given the output viewport; needs the viewport (width, height, aspect) passed through each render path to the billboard sampler (from #3237)

### Games

- Multiplayer: state sync with pluggable transport and authority (#778)

### Lighter

- Move GLB export out of the core entry into an addon (#2386)
- Cook: retire the WebGL2 backend once the WebGPU kernel is the default (#899)
- Path tracer: optional native package with hardware ray queries (Rust, wgpu) (#626)

### Look

- A packed web page draws a lit surface a little darker than the MCP render of the same scene (seen in #3003)
- An image map on a dented or fragment box: those boxes still have no UVs (seen in #3003)
- Path tracer: trace box, sphere and mesh local volumes natively, and mesh volumes on WebGPU (#2004)
- Material graph: vertexGroup node (design first) (#1957)
- Cook: cheaper filter for texture mip levels above 0 (#1810)
- Gaussian splats: pixel-art output and surface-to-splat baking for code-built splat dioramas (#1744)
- Apply the local volume surface shadow in the main shader so glowing surfaces keep their emission (#1360)
- Cook: camera near clip, so geometry in front of the clip start is not drawn (#1159)
- Showcase: one scene in every tier, and Cook beside Cycles (#906)
- Viewport: Glaze while moving, Cook refines at rest (#903)
- Glaze: the realtime-high tier (GPU-driven geometry, cached global illumination, temporal upscaling) (#902)
- Cook: Blender add-on that renders a scene through the v2 scene pack (#900)
- Look: bounced sun and beam-local multiple scattering in sunlit fog rooms (#643)
- Path tracer: real-time hybrid view with raster primary hits, radiance cache and temporal denoise (#624)
- KTX2 texture sets for recipes and terrain (#2884)
- Material snippets that change normal and roughness; image node for height and normal (#2883)
- Materials: anti-tiling for large surfaces (#2862)
- Materials: parallax occlusion mapping from the graph height (#2860)
- Sun shafts through volume fog or as a post pass (#2831)
- Toon vegetation: toonColors on recipe vegetation, scatter without terrain ground (#2840)
- Water: ripples and glint alias into pixels at a distance (#853)

### Modeling

- Proposal: OpenUSD and MaterialX (#2887)
- Blender add-on: carry terrain and texture sets into Crucible (#2886)
- Outdoor starter recipes and a terrain-and-ground skill reference (#2885)
- Terrain: thermal and hydraulic erosion (#2864)
- Export lathe geometry and a hide path from the standalone bundle (#2751)
- Weld duplicate glTF vertices on load, remapping attributes, morph targets and skins (from #2981)
- Recipe: node pivot (object origin) field so gizmos, hinges and animations rotate around the authored origin
- Named snap sockets on recipe parts so both Studio gizmos and agents seat props and joints without gaps or interpenetration
- Quad-flow retopology and external AI-mesh cleanup (auto-split parts, bottom or joint pivot, clean LODs) for imported GLBs
- Single-node Blender round-trip: open a recipe node in Blender for sculpting or manual retopo and reload it in place without losing transforms, lighting or tracks

### Motion and simulation

- Audio markers: key animation to beats and sound cues (#2892)
- Vehicles: dents, detachable parts and broken glass on impact (#983)
- Ocean: spray from breaking crests and bows (#2040)

### Other

- GTAO in place of depth-only SSAO (#2800)
- Measure moving dev tooling and CI from npm and Node to Bun (#2746)
- Voxel helper for meshes and trained splats (sprite stacks) (#2745)
- Studio: export a video of the timeline (#2853)
- Studio: a list of undo steps to jump back to
- Studio: snap to vertices, edges and the grid while transforming
- Studio: choose the pivot point and a global or local transform orientation
- Studio edit mode: knife, edge slide, vertex slide and recalculate normals
- Studio: a ruler, hide unselected and lasso select

## Package size

Large features that carry data or a heavy dependency should ship as separate optional packages (for example `@codepawlhq/crucible-film`), not as more entries of the main archive. Lazy loading alone does not help here: a lazy chunk still sits in the same npm archive, so it saves page weight but not the 1 MiB archive budget. A separate package does both, and users who never import it never download it. The cost is a second version to release and a peer range to keep in step, so small code-only addons (a few tens of KB gzip) stay in the main package. The film demo left the main archive for this reason.
