# Meshlets and per-cluster culling

Dense scans and high-triangle single meshes can skip off-screen and back-facing triangle clusters inside one mesh without changing the image.

`meshlets` ships as `@codepawlhq/crucible/addons/meshlets` so scenes without dense geometry pay zero bytes in the core bundle. Building clusters uses the optional peer dependency `meshoptimizer`.

## Usage

```js
import { CrucibleRenderer } from '@codepawlhq/crucible';
import { addMeshletsToDenseParts, installClusterCulling } from '@codepawlhq/crucible/addons/meshlets';

const partsWithMeshlets = await addMeshletsToDenseParts(parts);
const renderer = new CrucibleRenderer(canvas, partsWithMeshlets, options);
const clusterCulling = installClusterCulling(renderer);

renderer.render(camera);
console.log(clusterCulling.getStats());
```

## API

- `buildGeometryMeshlets(geometry, options)`: splits a geometry of at least `minimumTriangles` (`4096` by default) into clusters of at most `maxVertices` (`64`) and `maxTriangles` (`124`), storing per-cluster bounding spheres and normal cones (`coneWeight`, default `0.5`). Returns `null` below `minimumTriangles` and caches by geometry.
- `addMeshletsToDenseParts(parts, options)`: attaches `meshlets` to eligible rigid parts above `minimumTriangles`, reusing one build per shared geometry. Returns `parts` unchanged when no mesh reaches the threshold.
- `cullMeshlets(meshlets, options)`: tests every cluster bounding sphere against the six normalized inward frustum planes and tests back-facing cones when uniform positive scale, single-sided rendering, and non-mirrored winding hold, coalescing consecutive visible clusters into merged draw ranges.
- `createWebGpuMeshletCuller(device, meshlets)`: creates the `MESHLET_CULL_WGSL` `@compute` pipeline and `DrawIndexedIndirect` buffer for WebGPU renderers.
- `installClusterCulling(renderer, options)`: hooks cluster culling onto a `CrucibleRenderer` (`WEBGL_multi_draw` when available, indexed draw fallback otherwise) and returns `{ getStats, setEnabled, isEnabled, dispose }`.

## Limits

- Only single-instance rigid parts without skinning, morphing, crowds, or flush coplanar ranking use cluster draws.
- Scenes whose meshes all fall below `minimumTriangles` skip cluster building and draw unchanged.
