# Questions people ask

Short answers to the questions that came up most after the launch. Each answer links to the page with the detail.

## Does Crucible replace three.js?

No. You can use them side by side. three.js is a general 3D library that you program in JavaScript. Crucible is a smaller renderer with a scene format that an AI agent can edit through MCP tools, without writing engine code. Crucible uses the three.js Draco, meshopt and KTX2 decoders when you pass them in ([import and export](#import-and-export-models)).

## Is there a visual editor?

Yes. Studio (`@codepawlhq/crucible/addons/studio`) is an optional addon that an app mounts with `createStudio` to edit the same scene recipe as the MCP tools. It is not a page of the public site; in a local checkout, run `npm run dev` and open `/bench/studio/index.html`. The [Studio guide](/studio.md) says how to use it.

## Is it faster or smaller than three.js?

It is smaller. A lit box is 64,940 bytes gzip in Crucible and 133,797 bytes in three.js 0.187.0. A box loaded from a GLB is 100,370 against 156,445 bytes. Both come from the 0.22.0 baseline ([baseline.json](https://github.com/codepawl/crucible/blob/main/bench/size/baseline.json), [size bench](https://github.com/codepawl/crucible/blob/main/bench/size/README.md)).

It is not faster in general. On 2026-11-04, three.js drew the faster full frame in most runtime bench scenes. Crucible was faster on two of them: many copies of one object, and moving shadows. The [performance page](#performance-and-memory/where-three-js-still-wins) has the numbers.

## Why JavaScript, and why not Vulkan or DirectX?

Crucible draws in the browser, so Glaze uses WebGL2, which every current desktop and phone browser has. A page or an agent can show a scene with no install. For offline stills, the Cook path tracer runs on CPU, WebGL2, opt-in WebGPU, and natively on Vulkan ray queries through the optional `@codepawlhq/cook` package ([path tracer guide](/path-tracer.md)).

## What is the benefit over asking an agent to "make it in three.js"?

With three.js, the agent writes a program and runs it to find out if it works. With Crucible, the scene is data: parts, geometry, matrices and materials. The agent changes it with tool calls, and each call checks its input and says what to fix.

On six modeling tasks with the same model ([agent bench](https://github.com/codepawl/crucible/blob/main/bench/agent-modeling/README.md), 2026-11-07, one run each):

| System | Passed | Tool calls | Tokens (in and out) | Wall time |
| --- | --- | --- | --- | --- |
| Crucible MCP | 6 of 6 | 3.2 | 375k | 24 s |
| three.js by code | 5 of 6 | 8.8 | 269k | 359 s |
| Blender MCP (official server) | 6 of 6 | 3.8 | 177k | 517 s |

The tasks were made for the Crucible bench, so they favour it. The Blender times include a slow render inside an emulated container, so do not compare them directly.

## Does it use a lot of tokens?

Yes, more input tokens than the other two systems in the table above. The agent client reads every tool schema on every call. The Crucible tool schemas are about 19,000 tokens (`node scripts/measure-tool-cost.mjs`, measured 2026-11-10). Crucible uses fewer calls and much less time, but each call carries more context. A size check on every pull request stops the schemas from growing without a reason ([optimize for agents](#optimize-for-agents)).

## What does the agent see after each call?

Each edit returns the new revision, the result of each operation and a diff of what changed. The agent can then:

- Read the scene state with `scene_inspect`.
- Get a picture with `scene_look`.
- Compare several camera shots or branches in one labelled image with `scene_review`.

The agent asks for a picture only when it needs one, so most calls cost no image. See [agent workflows](#agent-workflows).

## Can an agent undo an edit?

Yes. `scene_restore` with `revision` goes back to any of the last 4 revisions in one call, with no checkpoint made first. For an experiment that may take longer, call `scene_checkpoint` first, and `scene_restore` goes back to it exactly, geometry and textures included. `scene_apply` with a `branch` name tries an edit on a copy and leaves the scene as it is. The [MCP guide](/mcp.md) has the limits.

## Can I check that an edit did not change the rest of the scene?

Yes. Every `scene_apply` result has a diff with the IDs of the nodes, materials and geometries that the edit added, removed or changed. Nodes keep the IDs that the recipe gives them, so you can also run `scene_inspect` before and after the edit and compare the two records.

## Which tools do agents use most?

This is not measured yet. Issue #746 adds an opt-in local log of tool calls, and we will post the table on that issue.

## How do I help?

Read the [contributing guide](https://github.com/codepawl/crucible/blob/main/CONTRIBUTING.md) and pick an issue labeled `good first issue`. For mesh export, GLB ships in core and OBJ and STL export ship in `@codepawlhq/crucible/addons/export-mesh` ([export guide](/export-glb.md#obj-and-stl)).
