# Meshlet and cluster culling benchmark

Measures drawn triangles, frame time, and pixel difference (`RMSE`) on a dense single-primitive mesh (`259,200` triangles) with and without per-cluster frustum and backface-cone culling (`@codepawlhq/crucible/addons/meshlets`), plus a below-threshold control mesh (`1,280` triangles):

```sh
node bench/meshlets/bench.mjs
```
