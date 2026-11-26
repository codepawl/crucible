# Hand grip sockets and prop attachment

`crucible/addons/prop-grip` places handheld props cleanly inside a character's palm tunnel and updates them on every pose evaluation, with optional automatic finger curl matched to the handle radius.

```js
import { loadGltf } from 'crucible/addons/gltf';
import { clipFromGltfAnimation, createAssetPose } from 'crucible/addons/skeleton-pose';
import { attachPropToGrip, createGripCurlSolver, createGripSocket } from 'crucible/addons/prop-grip';

const character = await loadGltf(characterUrl);
const tool = await loadGltf(toolUrl);

const socket = createGripSocket({
  gripOrigin: [0, -0.35, 0],
  gripAxis: [0, 1, 0],
  forwardUpHint: [0, 0, 1],
  gripRadius: 0.022,
});

const walk = clipFromGltfAnimation(character.animations[0], { loop: true });
const pose = createAssetPose(character, {
  layers: [{ clip: walk }],
  ik: [createGripCurlSolver('rightHand', socket)],
});

const attachment = attachPropToGrip(pose, tool, socket, 'rightHand');

pose.apply(seconds);
renderer.updateParts([...character.parts, ...tool.parts]);
```

## Grip sockets

`createGripSocket(descriptor)` validates and normalizes the prop's local handle frame:

| Field | Default | Contract |
| --- | --- | --- |
| `gripOrigin` | Required | `[x, y, z]` finite coordinates of the handle center in prop space |
| `gripAxis` | Required | Nonzero `[x, y, z]` handle direction (from pinky side toward index/thumb side) |
| `forwardUpHint` | Required | Nonzero `[x, y, z]` prop forward/up direction not parallel to `gripAxis` |
| `gripRadius` | `null` | Positive finite handle radius in world units, up to `100` |
| `rollOffset` | `0` | Finite twist in radians around `gripAxis` |

`gripAxis` and `forwardUpHint` build a rigid orthonormal right-handed frame with unit scale. Unknown fields or parallel `gripAxis` / `forwardUpHint` directions throw a `TypeError` or `RangeError`.

## Hand anchors

Pass `anchor` as `'rightHand'`, `'leftHand'`, a specific joint name (such as `'Palm2R'` or `'mixamorig:RightHand'`), or a descriptor object:

| Field | Default | Contract |
| --- | --- | --- |
| `handJoint` | Required unless `side` given | Joint name or canonical humanoid bone |
| `side` | Inferred from name | `'left'` or `'right'` |
| `joints` | Auto-discovered | Optional map of `hand`, `lowerArm`, `palm`, `index`, `middle`, `ring`, `pinky`, `thumb` (plus `*Intermediate`, `*Distal`) |
| `surfacePair` | `undefined` | Explicit local hand marks: `{ palm, fingers, axis?, forward? }` or `{ from, to, forward? }` |
| `palmOffset` | Auto-derived | Optional `[x, y, z]` palm tunnel center in `handJoint` local space |
| `gripAxis` | Auto-derived | Optional nonzero `[x, y, z]` grip axis in `handJoint` local space |
| `forwardAxis` | Auto-derived | Optional nonzero `[x, y, z]` forward direction in `handJoint` local space |
| `gripRadius` | `undefined` | Fallback positive finite grip radius when the socket omits `gripRadius` |

When `surfacePair` and `palmOffset` are omitted, `resolveGripAnchor(pose, anchor)` derives the grip axis from `pinky -> index` knuckles (falling back to adjacent fingers, thumb, or hand orientation), places `origin` in front of the palm pad by `gripRadius`, and aligns `forwardAxis` along the wrist-to-knuckle direction orthogonalized against `gripAxis`.

## Solving, attaching, and finger curl

- `solveGripTransform(pose, socket, anchor, options?)` computes `{ matrix, position, rotation, origin, gripAxis, forwardAxis, palmNormal, anchor }` from the pose's current applied state without mutating the prop. `options` accepts `{ rollOffset, gripRadius, scale, out }`.
- `attachPropToGrip(pose, prop, socket, anchor, options?)` attaches a single part `{ matrix }`, a compound `{ parts }`, or a part array. With `autoUpdate = true` (default), every `pose.apply(time)` updates the prop matrices automatically. Calling `attachment.detach()` removes the hook, and `attachment.update()` updates manually.
- `createGripCurlSolver(anchor, socket?, options?)` returns a `{ type: 'custom', create }` solver for the `ik` list of [createSkeletonPose](https://crucible.codepawl.com/skeleton-pose.md) or `createAssetPose`. It curls available finger and thumb chains around `gripRadius` in `fit` mode (default, curling only as needed from the current pose) or `additive` mode, with optional `weight`, `curlScale`, and `thumbWeight`.

## Limits

- Call `pose.apply(time)` before `solveGripTransform` or `attachment.update()`; an un-applied pose throws a `RangeError`.
- Rigid prop matrices keep uniform `scale` (default `1`) and never inherit shear from the hand hierarchy.
- See [skeleton pose](https://crucible.codepawl.com/skeleton-pose.md), [retargeting](https://crucible.codepawl.com/retarget.md), and [retained triangle attachments](https://crucible.codepawl.com/surface-attachment.md) for complementary rigging and surface attachment helpers.
