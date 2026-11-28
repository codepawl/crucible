# Scene audit (`scene-audit`)

`@codepawlhq/crucible/addons/scene-audit` checks a `CrucibleRenderer` parts list (including `instanceMatrices` batches and shared `geometry` templates) for four common structural defects without truncating at 600k triangles:

- `coplanar`: same-facing coplanar face overlaps that cause z-fighting
- `intersection`: 15-axis OBB penetration beyond `clearanceTolerance`
- `floating`: parts above ground/supports with nothing underneath
- `inverted-shell`: inward-wound shells or negative-determinant mirrored transforms

## Usage

```js
import { auditScene } from '@codepawlhq/crucible/addons/scene-audit';

const report = auditScene(parts, {
  coplanarTolerance: 1e-3,
  minOverlapArea: 1e-4,
  clearanceTolerance: 5e-3,
  supportTolerance: 0.02,
  maxFindings: 64,
});
```

Returns `{ ok, stats: { partCount, instanceCount, uniqueGeometries, totalTriangles, uniqueTriangles, elapsedMs }, counts, findings }`, where each finding includes `{ kind, severity, target, message, fix }`.
