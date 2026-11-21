# Replacement candidates for `/modeling.html`

The page is a procedural-modeling showcase: one scene built in code from `lathe`, `extrude`, `tube` and `curve`, with materials, the shared scene graph, orbit controls and an Animate toggle. Each candidate is built the same way, so it drops into `src/modeling-scene.js` with the same shape (`name`, `parts`, `graph`, `sample(time, aspect)`) and shows modelled detail, not a prop made of primitives.

Every picture is the real `/modeling.html` (vite on a free port, Chrome on the GPU, paused at t = 2.5 s). The page heading still reads "Aster lantern" in them because site text is not part of the candidate; the removal PR changes it. The candidates are not on main: they live in `candidates/src/` of this branch.

Pictures: `<name>-desktop.png` (1440x900) and `<name>-mobile.png` (390x844).

| | Candidate | Tools it shows | Motion | Parts, triangles |
| --- | --- | --- | --- | --- |
| A | `chess`: turned chess set | five `lathe` profiles (king, queen, bishop, rook, pawn) with Catmull-Rom smoothed silhouettes, `extrude` for the rook battlements and the king's cross, bevelled board tiles | the whole set turns slowly on the scene-graph root | 51, 141k |
| B | `teapot`: porcelain teapot on a saucer | `lathe` for body, lid, saucer and pedestal, `curve` with taper for a swept spout and handle, `tube` for a brass inlay | the root swings the pot gently left and right | 9, 84k |
| C | `gears`: brass gear train | `extrude` of toothed contours with holes (lightening holes plus bore), five gears meshed by computed tooth phase, `tube` tie rod | the gears turn at true ratios (24:16:32, 12:30), teeth stay interlocked | 24, 29k |

Which reads at once: A and B are objects anyone names in a glance. C reads as "machine" and is the only one whose motion is the point (the Animate button matters); it is closest to the old page's clockwork spirit without being a lantern. A is the richest in modelled detail per part. B is the cheapest to load and the cleanest silhouette, and is the only one needing a new ground read (pale horizon behind it, same as before).

## What a pick changes beyond the scene file

- `src/modeling-player.js`: candidates carry a `view` ({ yaw, pitch, distance, portraitScale }) and a `target`, because the old player hard-codes the lantern's height (target y 1.35, distance 6.87, portrait factor 1.15). The small player patch (use `frame.target` and `scene.view`) is in `candidates/src/modeling-player.js`; it is JS only, no layout or CSS.
- `site/modeling.html` text, `scripts/smoke-modeling.mjs` root name, `FEATURES.md`, `docs/modeling.md`, `docs/learn/procedural-modeling.md`: see INVENTORY.md.
- Smoke assertions (moved root changes pixels, animation changes pixels) hold for all three, since each animates through the graph.

## Source

`candidates/src/cand/{kit,chess,teapot,gears}.js`, `candidates/src/modeling-player.js` (the patched player, `?scene=chess|teapot|gears`), `candidates/shot-2822.mjs` (the capture script).
