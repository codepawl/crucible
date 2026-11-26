# Resources

## Examples

Each example is a Crucible scene with its source in the repository.

```cards
Showcase | /showcase.html | An airport, a data center and a port. | /previews/showcase-port.webp
Chip fab | #effects-and-lighting | A cleanroom bay with ambient occlusion and bloom. | /previews/showcase-chipfab.webp
Warehouse | #hdr-environment-lighting | Racks and a forklift lit by a warehouse sky. | /previews/showcase-warehouse.webp
Dark store | #local-lights-and-volume-fog | Shelves lit by point lights in thin fog. | /previews/showcase-darkstore.webp
Ocean and boat wake | #ocean-and-boat-wake | Seeded waves with foam veins, buoyancy and a steered boat wake. | /previews/ocean-boat-wake.webp
Explosions and volumes | #explosions-and-volumes | Gas-simulated fire, smoke plumes, debris and flying sparks. | /previews/explosion-volumes.webp
Baked light | #bake-light | Indirect bounce light baked into lightmaps over procedural shapes. | /previews/baked-light-room.webp
Path tracer | #cook-path-tracer | Stills traced by Cook with real bounce light. | /previews/cook-pabellon.webp
```

## Guides for AI agents

An agent can build scenes through the MCP server, without writing engine code. These files are plain text for agents and for people.

- [MCP server](/mcp.md): install, client setup, the tools and their limits.
- [Scene recipes](/agent-scene.md): the JSON format that the tools accept.
- [Look](/agent-look.md), [fit look](/agent-fit-look.md), [motion](/agent-motion.md), [character motion](/agent-character-motion.md) and [assets](/agent-asset.md): the parts of a recipe.
- [Render jobs](/agent-render-jobs.md) and [visual review](/agent-review.md): images, sequences, video and review grids.
- [The plain-text guide](/guide.md): all of this documentation in one Markdown file.

## Contracts

A contract is the exact rule set of one module: inputs, limits, memory and errors. The topic pages link to the matching contract.

- Modeling: [procedural modeling](/modeling.md), [mesh editing](/mesh.md), [primitives](/primitives.md), [sculpt](/sculpt.md), [surface patches](/surface.md), [shrinkwrap](/shrinkwrap.md), [mesh queries](/mesh-query.md), [meshlets](/meshlets.md), [scene graph](/scene-graph.md).
- Look: [lines and toon light](/line-art.md), [material maps](/material-maps.md), [post passes](/user-passes.md), [kinetic text](/kinetic-text.md), [mesh blend](/mesh-blend.md), [lighting](/lighting.md), [volume fog](/volumetric.md), [path tracer](/path-tracer.md), [WebGPU path tracer decision](/webgpu-decision.md), [light bake](/light-bake.md), [clip planes](/clip-planes.md), [Gaussian splats](/gaussian-splats.md).
- Worlds: [terrain](/terrain.md), [vegetation](/vegetation.md), [grass](/grass.md), [clutter](/clutter.md), [vehicles](/vehicle.md), [Spume liquid](/spume.md).
- Motion: [animation curves](/animation-curves.md), [mixer](/animation-mixer.md), [skinning](/skinning.md), [morph targets](/morph-targets.md), [retargeting](/retarget.md), [skeleton pose](/skeleton-pose.md), [prop grip](/prop-grip.md), [camera paths](/camera-path.md), [physics](/physics.md), [film physics](/film-physics.md).
- Files: [glTF import](/gltf.md), [glTF morphs](/gltf-morph.md), [GLB export](/export-glb.md), [floor plan to walls](/floor-plan.md), [three.js bridge](https://github.com/codepawl/crucible/blob/main/docs/three-bridge.md), [Roblox scene import](/roblox-import.md), [data-only packs](/packs.md).
- Games: [a playable scene from a recipe](/game.md), [game rules](/game-rules.md), [live game loop](/runtime.md), [player and camera rigs](/player.md), [input](/input.md), [audio](/audio.md), [scene queries](/scene-query.md), [live physics](/physics-runtime.md), [animation graph](/animation-graph.md), [streaming](/streaming.md), [culling and levels of detail](https://github.com/codepawl/crucible/blob/main/docs/culling-lod.md), [netcode](/netcode.md).
- Web delivery and tools: [web bundle](/pack.md), [render engines](/render-engines.md), [Cook in Blender](https://github.com/codepawl/crucible/blob/main/docs/blender-addon.md), [Studio](/studio.md), [addons from other people](/addons.md).

## Project

- [Changelog](/changelog.html): every release and the unreleased changes. Agents can read [changelog.json](/changelog.json).
- [npm package](https://www.npmjs.com/package/@codepawlhq/crucible): `@codepawlhq/crucible`.
- [Source on GitHub](https://github.com/codepawl/crucible): issues, pull requests and the contributing guide.
- [Release metadata](/release.json): the published version, the browser module URL and the archive checksum.
