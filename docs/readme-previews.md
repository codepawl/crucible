# Rebuild the README pictures

Seven of the eight pictures at the top of the README (`public/previews/*.webp`) come from one command, so they can be refreshed whenever the look changes.

```sh
node scripts/render-readme-previews.mjs                       # all seven, written to public/previews
node scripts/render-readme-previews.mjs showcase-port cook-monk   # only these
node scripts/render-readme-previews.mjs --preview artifacts/readme-previews --pairs artifacts/readme-pairs
```

`--preview <folder>` writes small, low-quality renders there instead of `public/previews`. `--pairs <folder>` also writes `readme-<name>-pair.png` for a still, or `.mp4` for a clip, with the published picture on the left and the new one on the right. `--help` lists the rest.

What each picture is built from (the table is `scripts/readme-previews-plan.mjs`):

| Picture | Source | Tool |
|---|---|---|
| `showcase-airport`, `showcase-port` | `public/showcase/<name>/scene.json` | `scripts/render-media.mjs` |
| `feature-clockwork` | the motion page | `scripts/render-media.mjs`, then FFmpeg to an animated WebP |
| `feature-flicker-fixed` | `scripts/readme-previews/flicker-fixed.recipe.mjs` | MCP render job, then FFmpeg |
| `feature-cook-dof` | `scripts/readme-previews/cook-dof.recipe.mjs` | MCP render job on Cook, then FFmpeg |
| `hero-classroom`, `cook-monk` | Blender demo files | `scripts/blender-demo-to-glb.py`, then `scripts/render-file-native.mjs` on Cook |

- A rasterized still is drawn twice as wide and tall as it is published and shrunk with a Lanczos filter (`STILL_SUPERSAMPLE`). It measured sharper than drawing at the published size: on the airport still the Laplacian variance of the 1280 wide result went from 248 to 374, and the strongest edges from 121 to 144. The Cook stills are traced at their published size, with enough samples that the denoiser has little noise left to remove.
- A clip keeps the frame count of the file it replaces and stays under that file's size: the encoder lowers the WebP quality until it fits, and stops with an error when even the lowest quality is too big.
- The three Cook pictures need the Cook native addon (`npm run cook:build`, or `node node_modules/@codepawlhq/cook/fetch-addon.mjs` for a prebuilt one) and a GPU with Vulkan ray queries. `--skip-cook` leaves them out.
- The two Blender demo scenes are downloaded on first use into `~/.cache/crucible-readme-previews` (change it with `--cache`), never into the repository, and converted with Blender 5.3 (`BLENDER=<path>`, or `blender` on the PATH). Classroom is by Christophe Seux (CC0); Lone Monk is by Carlo Bergonzini (CC-BY). The cameras are in the plan table: Classroom uses the Blender camera, Lone Monk the Blender camera moved 2 m forward.
- The MCP render needs `npm run build` and `node scripts/build-mcp.mjs` first.
- Run it when no other job holds the GPU: `node scripts/render-readme-previews.mjs ...`.

A Blender demo whose world is an analytic sky (the Lone Monk has no lamps, only a Nishita Sky Texture) is lit by that sky: the export renders it to `sky.hdr` with its sun at full strength and writes `world.json` with the scene's view transform and exposure. The scene file then names that HDRI at intensity 1, Crucible takes the sun out of it as the shadowed key light, and `exposure` is two to the power of Blender's exposure in stops (Filmic at -2 is 0.25; the tone map stays Crucible's ACES). Demos without a Sky Texture keep the airport sky.

The glTF exporter writes only an image texture wired straight into a Principled input, read through the first UV layer. A colour, roughness or normal built any other way (a Mapping node with linked values, Box projection, Object or Generated coordinates, a mix of two mappings) is baked by `scripts/blender-demo-to-glb.py` with Cycles, one material at a time, onto a new UV layer at about 160 texels per metre (at most `DEMO_BAKE_MAX_SIZE`, 2048 by default), and the Principled BSDF is rewired to the baked images. The log has one `MATERIAL` line per material (`kept`, `approximated`, `graded` or `baked`, with the images and sizes for a bake). `DEMO_BAKE_ONLY="roof,brick"` bakes only the named materials for a quick check. Particle instances (the Lone Monk lawn and bushes) are read from the dependency graph and written one mesh per source mesh with numpy (`scripts/blender_demo_copies.py`).
