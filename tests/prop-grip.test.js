import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { mat4, quat, vec3 } from 'gl-matrix';
import { createAnimationClip } from '../src/animation.js';
import { parseGltf } from '../src/gltf.js';
import { createAssetPose, createSkeletonPose } from '../src/skeleton-pose.js';
import {
  attachPropToGrip,
  createGripCurlSolver,
  createGripSocket,
  resolveGripAnchor,
  solveGripTransform,
} from '../src/prop-grip.js';

function rotationAbout(axis, degrees) {
  return Array.from(quat.setAxisAngle(new Float64Array(4), axis, degrees * Math.PI / 180));
}

function assertClose(actual, expected, tolerance = 1e-5, label = '') {
  for (let index = 0; index < expected.length; index++) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) <= tolerance,
      `${label}[${index}]: expected ${expected[index]}, got ${actual[index]}`,
    );
  }
}

function transformPoint(matrix, point) {
  const result = vec3.transformMat4(new Float64Array(3), point, matrix);
  return Array.from(result);
}

function transformDirection(matrix, direction) {
  const originWorld = vec3.transformMat4(new Float64Array(3), [0, 0, 0], matrix);
  const tipWorld = vec3.transformMat4(new Float64Array(3), direction, matrix);
  const delta = vec3.subtract(new Float64Array(3), tipWorld, originWorld);
  return Array.from(vec3.normalize(delta, delta));
}

/**
 * Humanoid test rig with articulated left and right hands (wrist, index, middle, ring, pinky, thumb).
 * At rest: arms extend forward (+Z) from shoulders; palms face inward (+X on right hand, -X on left hand);
 * fingers extend forward (+Z) and thumbs sit on the +Y (top) side.
 */
function createHandRig({ includeFingers = true } = {}) {
  const joints = [];
  const add = (name, parent, translation, rotation = [0, 0, 0, 1]) => {
    joints.push({ name, parent, translation, rotation, scale: [1, 1, 1] });
    return joints.length - 1;
  };
  const hips = add('mixamorig:Hips', -1, [0, 1, 0]);
  const spine = add('mixamorig:Spine', hips, [0, 0.3, 0]);
  add('mixamorig:Head', spine, [0, 0.5, 0]);
  for (const [sideName, sideSign] of [['Left', 1], ['Right', -1]]) {
    const upperArm = add(`mixamorig:${sideName}Arm`, spine, [sideSign * 0.2, 0.4, 0]);
    const lowerArm = add(`mixamorig:${sideName}ForeArm`, upperArm, [0, 0, 0.28]);
    const hand = add(`mixamorig:${sideName}Hand`, lowerArm, [0, 0, 0.25]);
    if (includeFingers) {
      const fingerOffsets = [
        ['Index', 0.032],
        ['Middle', 0.008],
        ['Ring', -0.015],
        ['Pinky', -0.036],
      ];
      for (const [fingerName, yOffset] of fingerOffsets) {
        const proximal = add(`mixamorig:${sideName}Hand${fingerName}1`, hand, [0, yOffset, 0.085]);
        const intermediate = add(`mixamorig:${sideName}Hand${fingerName}2`, proximal, [0, 0, 0.04]);
        add(`mixamorig:${sideName}Hand${fingerName}3`, intermediate, [0, 0, 0.03]);
      }
      const thumbProximal = add(`mixamorig:${sideName}HandThumb1`, hand, [-sideSign * 0.025, 0.035, 0.03]);
      const thumbIntermediate = add(`mixamorig:${sideName}HandThumb2`, thumbProximal, [0, 0.015, 0.03]);
      add(`mixamorig:${sideName}HandThumb3`, thumbIntermediate, [0, 0, 0.025]);
    }
    const upperLeg = add(`mixamorig:${sideName}UpLeg`, hips, [sideSign * 0.1, 0, 0]);
    const lowerLeg = add(`mixamorig:${sideName}Leg`, upperLeg, [0, -0.45, 0]);
    add(`mixamorig:${sideName}Foot`, lowerLeg, [0, -0.45, 0]);
  }
  return { joints };
}

function createSwordSocket(overrides = {}) {
  return {
    gripOrigin: [0, -0.25, 0],
    gripAxis: [0, 1, 0],
    forwardUpHint: [0, 0, 1],
    gripRadius: 0.02,
    ...overrides,
  };
}

test('createGripSocket validates and normalizes socket descriptors with clear errors', () => {
  const socket = createGripSocket({
    gripOrigin: [0.1, -0.2, 0.3],
    gripAxis: [0, 4, 0],
    forwardUpHint: [0, 2, 2],
    gripRadius: 0.025,
    rollOffset: 0.25,
  });
  assertClose(socket.gripOrigin, [0.1, -0.2, 0.3]);
  assertClose(socket.gripAxis, [0, 1, 0]);
  assertClose(socket.forwardUpHint, [0, 0, 1]);
  assert.equal(socket.gripRadius, 0.025);
  assert.equal(socket.rollOffset, 0.25);

  assert.throws(() => createGripSocket(null), /descriptor must be an object/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), typoField: 1 }), /unsupported field "typoField"/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), gripOrigin: [0, Number.NaN, 0] }), /gripOrigin must be three finite/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), gripAxis: [0, 0, 0] }), /gripAxis must be a nonzero/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), forwardUpHint: [0, 2, 0] }), /forwardUpHint must not be parallel/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), gripRadius: 0 }), /gripRadius must be a positive/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), gripRadius: -0.1 }), /gripRadius must be a positive/);
  assert.throws(() => createGripSocket({ ...createSwordSocket(), rollOffset: Number.POSITIVE_INFINITY }), /rollOffset must be a finite/);
});

test('resolveGripAnchor auto-derives palm tunnel center and pinky-to-index grip axis for left and right hands', () => {
  const pose = createSkeletonPose({ rig: createHandRig() });
  assert.throws(() => resolveGripAnchor(pose, 'rightHand'), /Pose has not been applied/);

  pose.apply(0);
  const rightAnchor = resolveGripAnchor(pose, 'rightHand');
  const leftAnchor = resolveGripAnchor(pose, 'leftHand');

  assert.equal(rightAnchor.source, 'knuckles');
  assert.equal(rightAnchor.side, 'right');
  assert.equal(rightAnchor.handJoint, 'rightHand');
  assert.equal(rightAnchor.joints.index, 'rightIndexProximal');
  assert.equal(rightAnchor.joints.pinky, 'rightLittleProximal');

  assertClose(rightAnchor.gripAxis, [0, 1, 0], 1e-4, 'right gripAxis');
  assertClose(rightAnchor.forwardAxis, [0, 0, 1], 1e-4, 'right forwardAxis');
  assertClose(rightAnchor.palmNormal, [1, 0, 0], 1e-4, 'right palmNormal');

  assertClose(leftAnchor.gripAxis, [0, 1, 0], 1e-4, 'left gripAxis');
  assertClose(leftAnchor.forwardAxis, [0, 0, 1], 1e-4, 'left forwardAxis');
  assertClose(leftAnchor.palmNormal, [-1, 0, 0], 1e-4, 'left palmNormal');

  const rightHandPos = pose.jointWorld('rightHand').position;
  const leftHandPos = pose.jointWorld('leftHand').position;
  assert.ok(rightAnchor.origin[0] > rightHandPos[0], 'right palm tunnel sits on palmar (+X) side');
  assert.ok(leftAnchor.origin[0] < leftHandPos[0], 'left palm tunnel sits on palmar (-X) side');
});

test('resolveGripAnchor supports surfacePair marks, local overrides, and clear validation errors', () => {
  const pose = createSkeletonPose({ rig: createHandRig({ includeFingers: false }) });
  pose.apply(0);

  const axisPair = resolveGripAnchor(pose, {
    handJoint: 'rightHand',
    surfacePair: { from: [0.02, -0.04, 0.08], to: [0.02, 0.04, 0.08], forward: [0, 0, 1] },
  });
  assert.equal(axisPair.source, 'surface-pair');
  assertClose(axisPair.gripAxis, [0, 1, 0]);
  assertClose(axisPair.forwardAxis, [0, 0, 1]);
  const handWorld = pose.jointWorld('rightHand').position;
  assertClose(axisPair.origin, [handWorld[0] + 0.02, handWorld[1], handWorld[2] + 0.08]);

  const palmFingersPair = resolveGripAnchor(pose, {
    handJoint: 'rightHand',
    surfacePair: { palm: [0.01, 0, 0.08], fingers: [0.05, 0, 0.08], axis: [0, 1, 0] },
  });
  assert.equal(palmFingersPair.source, 'surface-pair');
  assertClose(palmFingersPair.palmNormal, [1, 0, 0]);
  assertClose(palmFingersPair.origin, [handWorld[0] + 0.03, handWorld[1], handWorld[2] + 0.08]);

  const offsetAnchor = resolveGripAnchor(pose, {
    handJoint: 'rightHand',
    palmOffset: [0.03, 0.01, 0.07],
    gripAxis: [0, 1, 0],
    forwardAxis: [0, 0, 1],
  });
  assertClose(offsetAnchor.origin, [handWorld[0] + 0.03, handWorld[1] + 0.01, handWorld[2] + 0.07]);

  assert.throws(() => resolveGripAnchor(null, 'rightHand'), /needs a pose/);
  assert.throws(() => resolveGripAnchor(pose, ''), /must be a joint name/);
  assert.throws(() => resolveGripAnchor(pose, { handJoint: 'missingJoint' }), /was not found/);
  assert.throws(() => resolveGripAnchor(pose, { side: 'center' }), /must be "left" or "right"/);
  assert.throws(() => resolveGripAnchor(pose, { handJoint: 'rightHand', unknownKey: 1 }), /unsupported field/);
  assert.throws(() => resolveGripAnchor(pose, { handJoint: 'rightHand', surfacePair: { palm: [0, 0, 0], fingers: [0, 0, 0] } }), /distinct points/);
  assert.throws(() => resolveGripAnchor(pose, { handJoint: 'rightHand', surfacePair: { palm: [0, 0, 0], fingers: [1, 0, 0], from: [0, 0, 0], to: [0, 1, 0] } }), /not both/);
});

test('solveGripTransform aligns socket origin, axis, forward hint, rollOffset, and gripRadius across animated arm poses', () => {
  const swingClip = createAnimationClip({
    duration: 1,
    tracks: [
      {
        target: 'mixamorig:RightArm',
        property: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 1, value: rotationAbout([1, 0, 0], -60) },
        ],
      },
      {
        target: 'mixamorig:RightForeArm',
        property: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 1, value: rotationAbout([0, 1, 0], 45) },
        ],
      },
    ],
  });
  const pose = createSkeletonPose({ rig: createHandRig(), layers: [{ clip: swingClip }] });
  const socket = createSwordSocket({ gripRadius: 0.02 });
  const outMatrix = new Float32Array(16);

  for (const time of [0, 0.5, 1]) {
    pose.apply(time);
    const solved = solveGripTransform(pose, socket, 'rightHand', { out: outMatrix });
    assert.equal(solved.matrix, outMatrix);
    assertClose(transformPoint(solved.matrix, socket.gripOrigin), solved.origin, 1e-4, `origin at ${time}`);
    assertClose(transformDirection(solved.matrix, socket.gripAxis), solved.gripAxis, 1e-4, `axis at ${time}`);
    assertClose(transformDirection(solved.matrix, socket.forwardUpHint), solved.forwardAxis, 1e-4, `forward at ${time}`);
  }

  // rollOffset rotates forwardUpHint around the grip axis without moving gripOrigin.
  pose.apply(0.5);
  const baseSolved = solveGripTransform(pose, socket, 'rightHand');
  const rolledSolved = solveGripTransform(pose, socket, 'rightHand', { rollOffset: Math.PI / 2 });
  assertClose(transformPoint(rolledSolved.matrix, socket.gripOrigin), baseSolved.origin, 1e-4);
  const rolledForward = transformDirection(rolledSolved.matrix, socket.forwardUpHint);
  assert.ok(Math.abs(vec3.dot(rolledForward, baseSolved.forwardAxis)) < 1e-4, '90 deg roll makes forward perpendicular');
  assert.ok(Math.abs(vec3.dot(rolledForward, baseSolved.gripAxis)) < 1e-4, 'roll preserves orthogonality to gripAxis');

  // Larger gripRadius shifts the palm tunnel center outward along palmNormal.
  const thin = solveGripTransform(pose, createSwordSocket({ gripRadius: 0.01 }), 'rightHand');
  const thick = solveGripTransform(pose, createSwordSocket({ gripRadius: 0.06 }), 'rightHand');
  const radialShift = vec3.dot(vec3.subtract(new Float64Array(3), thick.origin, thin.origin), thin.palmNormal);
  assertClose([radialShift], [0.05], 1e-4, 'gripRadius clearance shift');

  assert.throws(() => solveGripTransform(pose, socket, 'rightHand', { out: new Float32Array(4) }), /Float32Array of length 16/);
  assert.throws(() => solveGripTransform(pose, socket, 'rightHand', { scale: -1 }), /scale must be a positive/);
});

test('attachPropToGrip updates single and multi-part props on pose.apply() and supports detach()', () => {
  const clip = createAnimationClip({
    duration: 1,
    tracks: [
      {
        target: 'mixamorig:LeftArm',
        property: 'rotation',
        keyframes: [
          { time: 0, value: [0, 0, 0, 1] },
          { time: 1, value: rotationAbout([0, 0, 1], 45) },
        ],
      },
    ],
  });
  const pose = createSkeletonPose({ rig: createHandRig(), layers: [{ clip }] });
  const sword = { matrix: mat4.identity(new Float32Array(16)) };
  const socket = createSwordSocket();

  // Attached before first pose.apply(): stays safe until applied, then updates automatically.
  const attachment = attachPropToGrip(pose, sword, socket, 'leftHand');
  pose.apply(0);
  const expectedAtZero = solveGripTransform(pose, socket, 'leftHand');
  assertClose(sword.matrix, expectedAtZero.matrix, 1e-5);

  pose.apply(1);
  const expectedAtOne = solveGripTransform(pose, socket, 'leftHand');
  assertClose(sword.matrix, expectedAtOne.matrix, 1e-5);

  // Compound prop preserves each child part's local offset relative to prop space.
  const bladeLocal = mat4.fromTranslation(new Float32Array(16), [0, 0.4, 0]);
  const guardLocal = mat4.fromTranslation(new Float32Array(16), [0, -0.1, 0]);
  const compoundProp = { parts: [{ matrix: bladeLocal }, { matrix: guardLocal }] };
  const compoundAttachment = attachPropToGrip(pose, compoundProp, socket, 'leftHand');
  assertClose(transformPoint(compoundProp.parts[0].matrix, [0, 0, 0]), transformPoint(expectedAtOne.matrix, [0, 0.4, 0]), 1e-5);
  assertClose(transformPoint(compoundProp.parts[1].matrix, [0, 0, 0]), transformPoint(expectedAtOne.matrix, [0, -0.1, 0]), 1e-5);

  // Detach stops automatic updates on pose.apply().
  const frozenBlade = Float32Array.from(compoundProp.parts[0].matrix);
  attachment.detach();
  compoundAttachment.detach();
  compoundAttachment.detach();
  pose.apply(0);
  assertClose(sword.matrix, expectedAtOne.matrix, 1e-5);
  assertClose(compoundProp.parts[0].matrix, frozenBlade, 1e-5);

  assert.throws(() => attachPropToGrip({}, sword, socket, 'leftHand'), /needs a pose/);
  assert.throws(() => attachPropToGrip(pose, { parts: [] }, socket, 'leftHand'), /non-empty array/);
  assert.throws(() => attachPropToGrip(pose, sword, socket, 'leftHand', { autoUpdate: 'yes' }), /autoUpdate must be a boolean/);
});

test('createGripCurlSolver curls fingers inward toward the palm scaled by gripRadius and seeks deterministically', () => {
  const socketThin = createSwordSocket({ gripRadius: 0.01 });
  const socketThick = createSwordSocket({ gripRadius: 0.06 });

  const openPose = createSkeletonPose({ rig: createHandRig() });
  openPose.apply(0);

  const thinPose = createSkeletonPose({
    rig: createHandRig(),
    ik: [
      createGripCurlSolver('rightHand', socketThin),
      createGripCurlSolver('leftHand', socketThin),
    ],
  });
  const thickPose = createSkeletonPose({
    rig: createHandRig(),
    ik: [createGripCurlSolver('rightHand', socketThick)],
  });

  thinPose.apply(0);
  thickPose.apply(0);

  const openMiddleTip = openPose.jointWorld('mixamorig:RightHandMiddle3').position;
  const thinMiddleTip = thinPose.jointWorld('mixamorig:RightHandMiddle3').position;
  const thickMiddleTip = thickPose.jointWorld('mixamorig:RightHandMiddle3').position;
  const rightHandPos = thinPose.jointWorld('rightHand').position;
  const leftHandPos = thinPose.jointWorld('leftHand').position;

  // Both right and left fingers curl INWARD toward their respective palms (+X on right, -X on left).
  assert.ok(thinMiddleTip[0] > openMiddleTip[0] + 0.03, `right middle tip curled inward: ${thinMiddleTip[0]} vs ${openMiddleTip[0]}`);
  assert.ok(thinPose.jointWorld('mixamorig:LeftHandMiddle3').position[0] < leftHandPos[0] - 0.03, 'left middle tip curled inward');
  assert.ok(thinMiddleTip[0] > thickMiddleTip[0], `smaller gripRadius curls tighter (${thinMiddleTip[0]}) than larger (${thickMiddleTip[0]})`);
  assert.ok(thinPose.jointWorld('mixamorig:RightHandThumb3').position[0] > rightHandPos[0] - 0.01, 'thumb curls toward palm');

  // Time-varying weight and backward seek determinism.
  const fadingPose = createSkeletonPose({
    rig: createHandRig(),
    ik: [createGripCurlSolver('rightHand', socketThin, { weight: time => Math.min(1, Math.max(0, time)) })],
  });
  fadingPose.apply(0);
  assertClose(fadingPose.jointWorld('mixamorig:RightHandMiddle3').position, openMiddleTip, 1e-5);
  fadingPose.apply(1);
  const fullCurlTip = fadingPose.jointWorld('mixamorig:RightHandMiddle3').position;
  assertClose(fullCurlTip, thinMiddleTip, 1e-5);
  fadingPose.apply(0);
  assertClose(fadingPose.jointWorld('mixamorig:RightHandMiddle3').position, openMiddleTip, 1e-5);

  assert.throws(() => createGripCurlSolver('rightHand', socketThin, { curlMode: 'invalid' }), /curlMode must be/);
  assert.throws(() => createGripCurlSolver('rightHand', socketThin, { weight: 2 }), /weight must be/);
  assert.throws(() => createGripCurlSolver('rightHand', socketThin, { thumbWeight: -0.1 }), /thumbWeight must be/);
});

test('prop-grip works on real RobotExpressive GLB with createAssetPose, finger curl, and attached prop parts', async () => {
  const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const socket = createGripSocket({
    gripOrigin: [0, -0.35, 0],
    gripAxis: [0, 1, 0],
    forwardUpHint: [0, 0, 1],
    gripRadius: 0.08,
  });

  const restPose = createAssetPose(asset);
  restPose.apply(0);
  const restTip = restPose.jointWorld('Middle2R').position;

  const grippedAsset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const grippedPose = createAssetPose(grippedAsset, {
    ik: [
      { type: 'two-bone', root: 'UpperArmR', middle: 'LowerArmR', end: 'Palm2R', target: [-1.1, 2.2, 1.1], keepEndRotation: true },
      createGripCurlSolver('rightHand', socket),
    ],
  });
  const propPart = { matrix: mat4.identity(new Float32Array(16)) };
  const attachment = attachPropToGrip(grippedPose, propPart, socket, 'rightHand');

  grippedPose.apply(0);
  const solved = solveGripTransform(grippedPose, socket, 'rightHand');
  assertClose(propPart.matrix, solved.matrix, 1e-5);
  assertClose(transformPoint(propPart.matrix, socket.gripOrigin), solved.origin, 1e-4);
  assertClose(transformDirection(propPart.matrix, socket.gripAxis), solved.gripAxis, 1e-4);

  const curledTip = grippedPose.jointWorld('Middle2R').position;
  assert.ok(vec3.distance(restTip, curledTip) > 0.1, 'arm IK and finger curl moved the robot middle finger');
  attachment.detach();
});
