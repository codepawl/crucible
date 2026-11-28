# @codepawlhq/crucible-three-bridge

This functionality is now built into `@codepawlhq/crucible/addons/three-bridge`. Use that import directly (`npm install @codepawlhq/crucible three`); this package folder remains as a thin re-export wrapper for existing setups.

```js
import * as THREE from 'three';
import { exportGlb } from '@codepawlhq/crucible';
import { fromThreeObject, toThreeObject } from '@codepawlhq/crucible/addons/three-bridge';

const { parts, warnings } = fromThreeObject(group);   // three.js Object3D -> Crucible parts
const { object } = toThreeObject(parts, THREE);        // Crucible parts -> Group of Mesh
const glb = exportGlb(parts);                          // Crucible parts -> GLB
```

Anything it cannot map is listed in `warnings`. A `ShaderMaterial` and a `SkinnedMesh` without bones throw an error that names the object. The guide with the mapping table, limits and options is [docs/three-bridge.md](../../docs/three-bridge.md).
