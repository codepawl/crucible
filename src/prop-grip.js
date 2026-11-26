import { mat3, mat4, quat, vec3 } from 'gl-matrix';

const NEAR_ZERO = 1e-9;
const COLLINEAR_THRESHOLD = 1e-5;
const MAX_SCALE = 1000;
const MAX_RADIUS = 100;
const DEFAULT_PALM_RADIUS_FRACTION = 0.22;
const DEFAULT_PALM_PAD_FRACTION = 0.14;
const DEFAULT_PALM_FORWARD_FRACTION = 0.15;
const DEFAULT_PALM_SPAN = 0.08;
const MAX_CURL_RADIANS = 1.9;
const MIN_CURL_RADIANS = 0.05;
const PROXIMAL_BASE_BEND_RADIANS = 0.2;

const SOCKET_FIELDS = new Set(['gripOrigin', 'gripAxis', 'forwardUpHint', 'gripRadius', 'rollOffset']);
const ANCHOR_FIELDS = new Set(['handJoint', 'side', 'joints', 'surfacePair', 'palmOffset', 'gripAxis', 'forwardAxis', 'gripRadius']);
const ANCHOR_JOINT_KEYS = new Set([
  'hand', 'palm', 'lowerArm',
  'index', 'middle', 'ring', 'pinky', 'thumb',
  'indexIntermediate', 'middleIntermediate', 'ringIntermediate', 'pinkyIntermediate', 'thumbIntermediate',
  'indexDistal', 'middleDistal', 'ringDistal', 'pinkyDistal', 'thumbDistal',
]);
const SOLVE_OPTION_FIELDS = new Set(['rollOffset', 'gripRadius', 'scale', 'out']);
const ATTACH_OPTION_FIELDS = new Set(['rollOffset', 'gripRadius', 'scale', 'out', 'autoUpdate']);
const CURL_OPTION_FIELDS = new Set(['weight', 'gripRadius', 'curlMode', 'curlScale', 'thumbWeight']);
const FINGER_NAMES = ['index', 'middle', 'ring', 'pinky'];
const FINGER_STAGES = ['Proximal', 'Intermediate', 'Distal'];

const poseAnchorDiscoveryCache = new WeakMap();
const poseApplyHookState = new WeakMap();
const validatedSockets = new WeakSet();

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(objectValue, allowedFields, label) {
  for (const field of Object.keys(objectValue)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`${label} has unsupported field "${field}". Supported fields: ${[...allowedFields].join(', ')}.`);
    }
  }
}

function readVector3(value, label) {
  if ((!Array.isArray(value) && !ArrayBuffer.isView(value)) || value.length !== 3) {
    throw new RangeError(`${label} must be three finite numbers [x, y, z].`);
  }
  const vector = new Float64Array(3);
  for (let axis = 0; axis < 3; axis++) {
    const component = value[axis];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new RangeError(`${label} must be three finite numbers [x, y, z].`);
    }
    vector[axis] = component;
  }
  return vector;
}

function readUnitVector3(value, label, example = '[0, 1, 0]') {
  const vector = readVector3(value, label);
  const length = vec3.length(vector);
  if (!(length > NEAR_ZERO)) {
    throw new RangeError(`${label} must be a nonzero vector of three finite numbers, such as ${example}.`);
  }
  return vec3.scale(vector, vector, 1 / length);
}

function readPositiveNumber(value, maximum, label, example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} must be a positive finite number up to ${maximum}, such as ${example}.`);
  }
  return value;
}

function readFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number.`);
  }
  return value;
}

function perpendicularDirection(unitAxis) {
  const reference = Math.abs(unitAxis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), unitAxis, reference));
}

function orthogonalizeUnit(vector, axis) {
  const projected = vec3.scaleAndAdd(new Float64Array(3), vector, axis, -vec3.dot(vector, axis));
  const length = vec3.length(projected);
  if (!(length > COLLINEAR_THRESHOLD)) return null;
  return vec3.scale(projected, projected, 1 / length);
}

function inferSideFromName(jointName) {
  if (typeof jointName !== 'string') return null;
  if (/^(?:left|Left)|(?:Left|_l|\.L|L)$/.test(jointName) || /(?:^|[^a-zA-Z])left(?:[^a-zA-Z]|$)/i.test(jointName)) {
    return 'left';
  }
  if (/^(?:right|Right)|(?:Right|_r|\.R|R)$/.test(jointName) || /(?:^|[^a-zA-Z])right(?:[^a-zA-Z]|$)/i.test(jointName)) {
    return 'right';
  }
  return null;
}

function capitalized(word) {
  return word[0].toUpperCase() + word.slice(1);
}

function fingerCandidateNames(side, finger, stageIndex) {
  const canonicalFinger = finger === 'pinky' ? 'little' : finger;
  const stageName = FINGER_STAGES[stageIndex];
  const stageNumber = stageIndex + 1;
  const fingerCap = capitalized(finger);
  const candidates = [];
  if (side) {
    const sideCap = capitalized(side);
    const shortSide = side === 'right' ? 'R' : 'L';
    const lowerSide = side === 'right' ? 'r' : 'l';
    candidates.push(`${side}${capitalized(canonicalFinger)}${stageName}`);
    if (stageIndex === 0) {
      candidates.push(`${fingerCap}${shortSide}`);
    }
    candidates.push(
      `${fingerCap}${stageNumber}${shortSide}`,
      `${fingerCap}${stageNumber}.${shortSide}`,
      `${sideCap}${fingerCap}${stageNumber}`,
      `${sideCap}Hand${fingerCap}${stageNumber}`,
      `${finger}_0${stageNumber}_${lowerSide}`,
    );
    if (finger === 'pinky') {
      candidates.push(
        `Little${stageNumber}${shortSide}`,
        `${sideCap}Little${stageNumber}`,
        `${sideCap}HandLittle${stageNumber}`,
      );
    }
  } else {
    candidates.push(`${fingerCap}${stageNumber}`);
  }
  return candidates;
}

function handCandidateNames(side) {
  if (!side) return [];
  const sideCap = capitalized(side);
  const shortSide = side === 'right' ? 'R' : 'L';
  const lowerSide = side === 'right' ? 'r' : 'l';
  return [
    `${side}Hand`,
    `${sideCap}Hand`,
    `hand_${lowerSide}`,
    `Hand.${shortSide}`,
    `Palm2${shortSide}`,
    `Palm1${shortSide}`,
    `Palm3${shortSide}`,
  ];
}

function lowerArmCandidateNames(side) {
  if (!side) return [];
  const sideCap = capitalized(side);
  const shortSide = side === 'right' ? 'R' : 'L';
  const lowerSide = side === 'right' ? 'r' : 'l';
  return [`${side}LowerArm`, `${sideCap}LowerArm`, `LowerArm${shortSide}`, `lowerarm_${lowerSide}`];
}

function probeJoint(pose, name) {
  try {
    return pose.jointWorld(name);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

function findFirstPoseJoint(pose, candidates) {
  for (const name of candidates) {
    if (probeJoint(pose, name) !== null) return name;
  }
  return null;
}

function validateSocketInput(descriptor) {
  if (validatedSockets.has(descriptor)) return descriptor;
  if (!isPlainObject(descriptor)) {
    throw new TypeError('Grip socket descriptor must be an object with gripOrigin, gripAxis, and forwardUpHint.');
  }
  rejectUnknownFields(descriptor, SOCKET_FIELDS, 'Grip socket');
  const gripOrigin = readVector3(descriptor.gripOrigin, 'Grip socket gripOrigin');
  const gripAxis = readUnitVector3(descriptor.gripAxis, 'Grip socket gripAxis', '[0, 1, 0]');
  const hintUnit = readUnitVector3(descriptor.forwardUpHint, 'Grip socket forwardUpHint', '[0, 0, 1]');
  const forwardBasis = orthogonalizeUnit(hintUnit, gripAxis);
  if (!forwardBasis) {
    throw new RangeError('Grip socket forwardUpHint must not be parallel to gripAxis. Pass a perpendicular hint such as [0, 0, 1].');
  }
  const sideBasis = vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), gripAxis, forwardBasis));
  const gripRadius = descriptor.gripRadius === undefined
    ? null
    : readPositiveNumber(descriptor.gripRadius, MAX_RADIUS, 'Grip socket gripRadius', '0.02');
  const rollOffset = descriptor.rollOffset === undefined
    ? 0
    : readFiniteNumber(descriptor.rollOffset, 'Grip socket rollOffset');
  const socket = Object.freeze({
    gripOrigin: Object.freeze(Array.from(gripOrigin)),
    gripAxis: Object.freeze(Array.from(gripAxis)),
    forwardUpHint: Object.freeze(Array.from(forwardBasis)),
    gripRadius,
    rollOffset,
    basis: Object.freeze({
      axis: Object.freeze(Array.from(gripAxis)),
      forward: Object.freeze(Array.from(forwardBasis)),
      side: Object.freeze(Array.from(sideBasis)),
    }),
  });
  validatedSockets.add(socket);
  return socket;
}

/**
 * Validate and normalize a prop grip socket descriptor `{ gripOrigin, gripAxis, forwardUpHint, gripRadius?, rollOffset? }`.
 * Local directions are normalized into an orthonormal right-handed frame `[axis, forward, side]`.
 */
export function createGripSocket(descriptor) {
  return validateSocketInput(descriptor);
}

function validateSurfacePair(surfacePair) {
  if (!isPlainObject(surfacePair)) {
    throw new TypeError('Grip anchor surfacePair must be an object with { palm, fingers } or { from, to }.');
  }
  const hasPalmFingers = surfacePair.palm !== undefined || surfacePair.fingers !== undefined;
  const hasFromTo = surfacePair.from !== undefined || surfacePair.to !== undefined;
  if (!hasPalmFingers && !hasFromTo) {
    throw new TypeError('Grip anchor surfacePair needs { palm, fingers } or { from, to } local 3D marks.');
  }
  if (hasPalmFingers && hasFromTo) {
    throw new TypeError('Grip anchor surfacePair takes either { palm, fingers } or { from, to }, not both.');
  }
  if (hasPalmFingers) {
    rejectUnknownFields(surfacePair, new Set(['palm', 'fingers', 'axis', 'forward']), 'Grip anchor surfacePair');
    const palm = readVector3(surfacePair.palm, 'Grip anchor surfacePair.palm');
    const fingers = readVector3(surfacePair.fingers, 'Grip anchor surfacePair.fingers');
    if (!(vec3.distance(palm, fingers) > NEAR_ZERO)) {
      throw new RangeError('Grip anchor surfacePair palm and fingers must be distinct points.');
    }
    return {
      mode: 'palm-fingers',
      palm,
      fingers,
      axis: surfacePair.axis === undefined ? null : readUnitVector3(surfacePair.axis, 'Grip anchor surfacePair.axis'),
      forward: surfacePair.forward === undefined ? null : readUnitVector3(surfacePair.forward, 'Grip anchor surfacePair.forward'),
    };
  }
  rejectUnknownFields(surfacePair, new Set(['from', 'to', 'forward']), 'Grip anchor surfacePair');
  const from = readVector3(surfacePair.from, 'Grip anchor surfacePair.from');
  const to = readVector3(surfacePair.to, 'Grip anchor surfacePair.to');
  if (!(vec3.distance(from, to) > NEAR_ZERO)) {
    throw new RangeError('Grip anchor surfacePair from and to must be distinct points.');
  }
  return {
    mode: 'axis-pair',
    from,
    to,
    forward: surfacePair.forward === undefined ? null : readUnitVector3(surfacePair.forward, 'Grip anchor surfacePair.forward'),
  };
}

function validateAnchorInput(anchor) {
  if (typeof anchor === 'string') {
    const trimmed = anchor.trim();
    if (!trimmed) {
      throw new RangeError('Grip anchor string must be a joint name or humanoid bone such as "rightHand" or "leftHand".');
    }
    return {
      handJoint: trimmed,
      isCanonicalHandShorthand: trimmed === 'rightHand' || trimmed === 'leftHand',
      side: trimmed === 'rightHand' ? 'right' : trimmed === 'leftHand' ? 'left' : inferSideFromName(trimmed),
      joints: null,
      surfacePair: null,
      palmOffset: null,
      gripAxis: null,
      forwardAxis: null,
      gripRadius: null,
    };
  }
  if (!isPlainObject(anchor)) {
    throw new TypeError('Grip anchor must be a joint name string ("rightHand", "leftHand") or an anchor descriptor object.');
  }
  rejectUnknownFields(anchor, ANCHOR_FIELDS, 'Grip anchor');
  if (anchor.handJoint !== undefined && (typeof anchor.handJoint !== 'string' || !anchor.handJoint.trim())) {
    throw new TypeError('Grip anchor handJoint must be a non-empty joint name string.');
  }
  if (anchor.side !== undefined && anchor.side !== 'left' && anchor.side !== 'right') {
    throw new RangeError('Grip anchor side must be "left" or "right".');
  }
  let joints = null;
  if (anchor.joints !== undefined) {
    if (!isPlainObject(anchor.joints)) {
      throw new TypeError('Grip anchor joints must be an object mapping roles such as index, middle, pinky, and thumb to joint names.');
    }
    rejectUnknownFields(anchor.joints, ANCHOR_JOINT_KEYS, 'Grip anchor joints');
    joints = {};
    for (const [role, name] of Object.entries(anchor.joints)) {
      if (typeof name !== 'string' || !name.trim()) {
        throw new TypeError(`Grip anchor joints.${role} must be a non-empty joint name string.`);
      }
      joints[role] = name;
    }
  }
  const handJoint = anchor.handJoint ?? joints?.hand ?? (anchor.side ? `${anchor.side}Hand` : undefined);
  if (!handJoint) {
    throw new TypeError('Grip anchor needs handJoint or side ("left" or "right").');
  }
  const side = anchor.side ?? (handJoint === 'rightHand' ? 'right' : handJoint === 'leftHand' ? 'left' : inferSideFromName(handJoint));
  return {
    handJoint,
    isCanonicalHandShorthand: handJoint === 'rightHand' || handJoint === 'leftHand',
    side,
    joints,
    surfacePair: anchor.surfacePair === undefined ? null : validateSurfacePair(anchor.surfacePair),
    palmOffset: anchor.palmOffset === undefined ? null : readVector3(anchor.palmOffset, 'Grip anchor palmOffset'),
    gripAxis: anchor.gripAxis === undefined ? null : readUnitVector3(anchor.gripAxis, 'Grip anchor gripAxis'),
    forwardAxis: anchor.forwardAxis === undefined ? null : readUnitVector3(anchor.forwardAxis, 'Grip anchor forwardAxis'),
    gripRadius: anchor.gripRadius === undefined ? null : readPositiveNumber(anchor.gripRadius, MAX_RADIUS, 'Grip anchor gripRadius', '0.02'),
  };
}

function discoverPoseAnchorJoints(pose, normalizedAnchor) {
  let byKey = poseAnchorDiscoveryCache.get(pose);
  if (!byKey) {
    byKey = new Map();
    poseAnchorDiscoveryCache.set(pose, byKey);
  }
  const cacheKey = JSON.stringify([normalizedAnchor.handJoint, normalizedAnchor.side, normalizedAnchor.joints]);
  if (byKey.has(cacheKey)) return byKey.get(cacheKey);

  const explicitHand = normalizedAnchor.joints?.hand ?? normalizedAnchor.handJoint;
  let handJointName = probeJoint(pose, explicitHand) !== null ? explicitHand : null;
  if (!handJointName && normalizedAnchor.isCanonicalHandShorthand) {
    handJointName = findFirstPoseJoint(pose, handCandidateNames(normalizedAnchor.side));
  }
  if (!handJointName) {
    throw new RangeError(`Grip anchor handJoint "${explicitHand}" was not found in the pose. Pass a valid joint name or humanoid bone such as "rightHand" or "leftHand".`);
  }

  const resolveOptional = (explicitName, candidates) => {
    if (explicitName !== undefined) {
      if (probeJoint(pose, explicitName) === null) {
        throw new RangeError(`Grip anchor joint "${explicitName}" was not found in the pose.`);
      }
      return explicitName;
    }
    return findFirstPoseJoint(pose, candidates);
  };

  const side = normalizedAnchor.side;
  const fingerChains = {};
  for (const finger of [...FINGER_NAMES, 'thumb']) {
    const proximalExplicit = normalizedAnchor.joints?.[finger];
    const intermediateExplicit = normalizedAnchor.joints?.[`${finger}Intermediate`];
    const distalExplicit = normalizedAnchor.joints?.[`${finger}Distal`];
    const proximal = resolveOptional(proximalExplicit, fingerCandidateNames(side, finger, 0));
    const intermediate = resolveOptional(intermediateExplicit, fingerCandidateNames(side, finger, 1));
    const distal = resolveOptional(distalExplicit, fingerCandidateNames(side, finger, 2));
    fingerChains[finger] = { proximal, intermediate, distal };
  }

  const lowerArmName = resolveOptional(normalizedAnchor.joints?.lowerArm, lowerArmCandidateNames(side));
  const palmName = resolveOptional(normalizedAnchor.joints?.palm, side ? [`Palm2${side === 'right' ? 'R' : 'L'}`, `Palm1${side === 'right' ? 'R' : 'L'}`] : []);

  const resolved = { handJointName, lowerArmName, palmName, fingerChains };
  byKey.set(cacheKey, resolved);
  return resolved;
}

function readAppliedJointWorld(pose, jointName) {
  const world = pose.jointWorld(jointName);
  const rotationLength = Math.hypot(world.rotation[0], world.rotation[1], world.rotation[2], world.rotation[3]);
  if (!Number.isFinite(rotationLength) || rotationLength <= NEAR_ZERO) {
    throw new RangeError('Pose has not been applied yet. Call pose.apply(time) before solving grip transforms.');
  }
  return {
    position: Float64Array.from(world.position),
    rotation: quat.normalize(new Float64Array(4), world.rotation),
  };
}

function transformLocalOffset(handWorld, localOffset) {
  const rotated = vec3.transformQuat(new Float64Array(3), localOffset, handWorld.rotation);
  return vec3.add(rotated, handWorld.position, rotated);
}

function readKnucklePositions(pose, fingerChains) {
  const positions = {};
  for (const finger of [...FINGER_NAMES, 'thumb']) {
    const chain = fingerChains[finger];
    if (chain.proximal) positions[finger] = readAppliedJointWorld(pose, chain.proximal).position;
    if (chain.intermediate) positions[`${finger}Intermediate`] = readAppliedJointWorld(pose, chain.intermediate).position;
  }
  return positions;
}

function meanVector(vectors) {
  const sum = new Float64Array(3);
  for (const vector of vectors) vec3.add(sum, sum, vector);
  return vec3.scale(sum, sum, 1 / vectors.length);
}

function deriveHandFrameFromKnuckles(pose, handWorld, resolved, normalizedAnchor) {
  const positions = readKnucklePositions(pose, resolved.fingerChains);
  const knuckleList = FINGER_NAMES.map(name => positions[name]).filter(Boolean);
  const knuckleCenter = knuckleList.length ? meanVector(knuckleList) : null;

  let handForward = null;
  let palmSpan = DEFAULT_PALM_SPAN;
  if (knuckleCenter) {
    const toKnuckles = vec3.subtract(new Float64Array(3), knuckleCenter, handWorld.position);
    const distance = vec3.length(toKnuckles);
    if (distance > NEAR_ZERO) {
      handForward = vec3.scale(toKnuckles, toKnuckles, 1 / distance);
      palmSpan = distance;
    }
  }
  if (!handForward && resolved.lowerArmName) {
    const lowerArmWorld = readAppliedJointWorld(pose, resolved.lowerArmName);
    const fromForearm = vec3.subtract(new Float64Array(3), handWorld.position, lowerArmWorld.position);
    const forearmLength = vec3.length(fromForearm);
    if (forearmLength > NEAR_ZERO) {
      handForward = vec3.scale(fromForearm, fromForearm, 1 / forearmLength);
      palmSpan = forearmLength * 0.3;
    }
  }
  if (!handForward) {
    handForward = vec3.normalize(new Float64Array(3), vec3.transformQuat(new Float64Array(3), [0, 1, 0], handWorld.rotation));
  }

  let anchorAxis = null;
  let source = knuckleList.length ? 'knuckles' : 'hand-joint';
  if (normalizedAnchor.gripAxis) {
    anchorAxis = vec3.transformQuat(new Float64Array(3), normalizedAnchor.gripAxis, handWorld.rotation);
    vec3.normalize(anchorAxis, anchorAxis);
  } else {
    const axisPairs = [
      [positions.pinky, positions.index],
      [positions.ring, positions.index],
      [positions.pinky, positions.middle],
      [positions.middle, positions.index],
    ];
    for (const [fromPoint, toPoint] of axisPairs) {
      if (!fromPoint || !toPoint) continue;
      const span = vec3.subtract(new Float64Array(3), toPoint, fromPoint);
      if (vec3.length(span) > NEAR_ZERO) {
        anchorAxis = vec3.normalize(span, span);
        break;
      }
    }
    if (!anchorAxis && positions.thumb && knuckleCenter) {
      const towardThumb = vec3.subtract(new Float64Array(3), positions.thumb, knuckleCenter);
      anchorAxis = orthogonalizeUnit(towardThumb, handForward);
    }
    if (!anchorAxis) {
      const localLateral = normalizedAnchor.side === 'left' ? [-1, 0, 0] : [1, 0, 0];
      const lateralWorld = vec3.transformQuat(new Float64Array(3), localLateral, handWorld.rotation);
      anchorAxis = orthogonalizeUnit(lateralWorld, handForward) ?? perpendicularDirection(handForward);
    }
  }

  // Right hand: Pinky->Index crossed with Wrist->Knuckles points into the palm; left hand is mirrored.
  let palmNormal = normalizedAnchor.side === 'left'
    ? vec3.cross(new Float64Array(3), handForward, anchorAxis)
    : vec3.cross(new Float64Array(3), anchorAxis, handForward);
  if (vec3.length(palmNormal) > COLLINEAR_THRESHOLD) {
    vec3.normalize(palmNormal, palmNormal);
  } else {
    palmNormal = perpendicularDirection(anchorAxis);
  }

  // If side was not specified, orient palmNormal toward curled fingers or thumb when available.
  if (!normalizedAnchor.side) {
    const curlReference = (positions.middleIntermediate && positions.middle)
      ? vec3.subtract(new Float64Array(3), positions.middleIntermediate, positions.middle)
      : (positions.indexIntermediate && positions.index)
        ? vec3.subtract(new Float64Array(3), positions.indexIntermediate, positions.index)
        : (positions.thumb && knuckleCenter)
          ? vec3.subtract(new Float64Array(3), positions.thumb, knuckleCenter)
          : null;
    if (curlReference && vec3.dot(curlReference, palmNormal) < -NEAR_ZERO) {
      vec3.negate(palmNormal, palmNormal);
    }
  }

  let anchorForward = normalizedAnchor.forwardAxis
    ? vec3.transformQuat(new Float64Array(3), normalizedAnchor.forwardAxis, handWorld.rotation)
    : handForward;
  anchorForward = orthogonalizeUnit(anchorForward, anchorAxis) ?? perpendicularDirection(anchorAxis);

  return { knuckleCenter, palmSpan, handForward, anchorAxis, anchorForward, palmNormal, source };
}

function resolveAnchorGeometry(pose, anchor, radiusOverride = null) {
  if (typeof pose?.jointWorld !== 'function') {
    throw new TypeError('solveGripTransform needs a pose from createSkeletonPose or createAssetPose with jointWorld(name).');
  }
  const normalizedAnchor = validateAnchorInput(anchor);
  const discovered = discoverPoseAnchorJoints(pose, normalizedAnchor);
  const handWorld = readAppliedJointWorld(pose, discovered.handJointName);
  const derived = deriveHandFrameFromKnuckles(pose, handWorld, discovered, normalizedAnchor);
  const effectiveRadius = radiusOverride ?? normalizedAnchor.gripRadius;

  let origin;
  let gripAxis = derived.anchorAxis;
  let forwardAxis = derived.anchorForward;
  let palmNormal = derived.palmNormal;
  let source = derived.source;

  if (normalizedAnchor.surfacePair) {
    source = 'surface-pair';
    const pair = normalizedAnchor.surfacePair;
    if (pair.mode === 'axis-pair') {
      const worldFrom = transformLocalOffset(handWorld, pair.from);
      const worldTo = transformLocalOffset(handWorld, pair.to);
      origin = vec3.scale(new Float64Array(3), vec3.add(new Float64Array(3), worldFrom, worldTo), 0.5);
      gripAxis = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), worldTo, worldFrom));
      const worldForwardHint = pair.forward
        ? vec3.transformQuat(new Float64Array(3), pair.forward, handWorld.rotation)
        : derived.anchorForward;
      forwardAxis = orthogonalizeUnit(worldForwardHint, gripAxis) ?? perpendicularDirection(gripAxis);
    } else {
      const worldPalm = transformLocalOffset(handWorld, pair.palm);
      const worldFingers = transformLocalOffset(handWorld, pair.fingers);
      origin = vec3.scale(new Float64Array(3), vec3.add(new Float64Array(3), worldPalm, worldFingers), 0.5);
      palmNormal = vec3.normalize(new Float64Array(3), vec3.subtract(new Float64Array(3), worldFingers, worldPalm));
      if (pair.axis) {
        gripAxis = vec3.normalize(new Float64Array(3), vec3.transformQuat(new Float64Array(3), pair.axis, handWorld.rotation));
      } else {
        gripAxis = orthogonalizeUnit(derived.anchorAxis, palmNormal) ?? perpendicularDirection(palmNormal);
      }
      const worldForwardHint = pair.forward
        ? vec3.transformQuat(new Float64Array(3), pair.forward, handWorld.rotation)
        : derived.anchorForward;
      forwardAxis = orthogonalizeUnit(worldForwardHint, gripAxis) ?? perpendicularDirection(gripAxis);
    }
  } else if (normalizedAnchor.palmOffset) {
    origin = transformLocalOffset(handWorld, normalizedAnchor.palmOffset);
  } else {
    const clearance = (effectiveRadius ?? derived.palmSpan * DEFAULT_PALM_RADIUS_FRACTION)
      + derived.palmSpan * DEFAULT_PALM_PAD_FRACTION;
    if (derived.knuckleCenter) {
      origin = vec3.scaleAndAdd(new Float64Array(3), derived.knuckleCenter, palmNormal, clearance);
      vec3.scaleAndAdd(origin, origin, forwardAxis, derived.palmSpan * DEFAULT_PALM_FORWARD_FRACTION);
    } else {
      origin = vec3.scaleAndAdd(new Float64Array(3), handWorld.position, derived.handForward, derived.palmSpan * 0.75);
      vec3.scaleAndAdd(origin, origin, palmNormal, clearance);
    }
  }

  return {
    origin: Array.from(origin),
    gripAxis: Array.from(gripAxis),
    forwardAxis: Array.from(forwardAxis),
    palmNormal: Array.from(palmNormal),
    handJoint: discovered.handJointName,
    side: normalizedAnchor.side,
    source,
    joints: Object.freeze({
      hand: discovered.handJointName,
      lowerArm: discovered.lowerArmName,
      index: discovered.fingerChains.index.proximal,
      middle: discovered.fingerChains.middle.proximal,
      ring: discovered.fingerChains.ring.proximal,
      pinky: discovered.fingerChains.pinky.proximal,
      thumb: discovered.fingerChains.thumb.proximal,
    }),
  };
}

/**
 * Resolve the world-space palm tunnel center and orientation axes for a character's hand anchor in its current applied pose.
 * Supports humanoid shorthands (`'rightHand'`, `'leftHand'`), explicit joint names, knuckle/thumb auto-derivation, or `surfacePair` marks.
 */
export function resolveGripAnchor(pose, anchor) {
  return resolveAnchorGeometry(pose, anchor);
}

function validateSolveOptions(options) {
  if (options === undefined) return { rollOffset: 0, gripRadius: null, scale: 1, out: null };
  if (!isPlainObject(options)) throw new TypeError('solveGripTransform options must be a plain object.');
  rejectUnknownFields(options, SOLVE_OPTION_FIELDS, 'solveGripTransform options');
  if (options.out !== undefined && (!(options.out instanceof Float32Array) || options.out.length !== 16)) {
    throw new TypeError('solveGripTransform options.out must be a Float32Array of length 16.');
  }
  return {
    rollOffset: options.rollOffset === undefined ? 0 : readFiniteNumber(options.rollOffset, 'solveGripTransform rollOffset'),
    gripRadius: options.gripRadius === undefined ? null : readPositiveNumber(options.gripRadius, MAX_RADIUS, 'solveGripTransform gripRadius', '0.02'),
    scale: options.scale === undefined ? 1 : readPositiveNumber(options.scale, MAX_SCALE, 'solveGripTransform scale', '1'),
    out: options.out ?? null,
  };
}

function writeRigidTransform(resolvedAnchor, validatedSocket, rollOffset, scale, targetMatrix) {
  const socketAxis = validatedSocket.basis.axis;
  const socketForwardBase = validatedSocket.basis.forward;
  const socketSideBase = validatedSocket.basis.side;
  const totalRoll = validatedSocket.rollOffset + rollOffset;
  const cosine = Math.cos(totalRoll);
  const sine = Math.sin(totalRoll);
  const socketForward = [
    socketForwardBase[0] * cosine + socketSideBase[0] * sine,
    socketForwardBase[1] * cosine + socketSideBase[1] * sine,
    socketForwardBase[2] * cosine + socketSideBase[2] * sine,
  ];
  const socketSide = vec3.cross(new Float64Array(3), socketAxis, socketForward);

  const anchorAxis = resolvedAnchor.gripAxis;
  const anchorForward = resolvedAnchor.forwardAxis;
  const anchorSide = vec3.normalize(new Float64Array(3), vec3.cross(new Float64Array(3), anchorAxis, anchorForward));

  const rotationMatrix = new Float64Array(9);
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) {
      rotationMatrix[column * 3 + row] = anchorAxis[row] * socketAxis[column]
        + anchorForward[row] * socketForward[column]
        + anchorSide[row] * socketSide[column];
    }
  }
  const rotation = quat.normalize(new Float64Array(4), quat.fromMat3(new Float64Array(4), rotationMatrix));

  const gripOrigin = validatedSocket.gripOrigin;
  const rotatedOriginX = (rotationMatrix[0] * gripOrigin[0] + rotationMatrix[3] * gripOrigin[1] + rotationMatrix[6] * gripOrigin[2]) * scale;
  const rotatedOriginY = (rotationMatrix[1] * gripOrigin[0] + rotationMatrix[4] * gripOrigin[1] + rotationMatrix[7] * gripOrigin[2]) * scale;
  const rotatedOriginZ = (rotationMatrix[2] * gripOrigin[0] + rotationMatrix[5] * gripOrigin[1] + rotationMatrix[8] * gripOrigin[2]) * scale;
  const position = [
    resolvedAnchor.origin[0] - rotatedOriginX,
    resolvedAnchor.origin[1] - rotatedOriginY,
    resolvedAnchor.origin[2] - rotatedOriginZ,
  ];

  const matrix = targetMatrix ?? new Float32Array(16);
  for (let column = 0; column < 3; column++) {
    matrix[column * 4] = rotationMatrix[column * 3] * scale;
    matrix[column * 4 + 1] = rotationMatrix[column * 3 + 1] * scale;
    matrix[column * 4 + 2] = rotationMatrix[column * 3 + 2] * scale;
    matrix[column * 4 + 3] = 0;
  }
  matrix[12] = position[0];
  matrix[13] = position[1];
  matrix[14] = position[2];
  matrix[15] = 1;

  return {
    matrix,
    position,
    rotation: Array.from(rotation),
    origin: resolvedAnchor.origin,
    gripAxis: resolvedAnchor.gripAxis,
    forwardAxis: resolvedAnchor.forwardAxis,
    palmNormal: resolvedAnchor.palmNormal,
    anchor: resolvedAnchor,
  };
}

/**
 * Compute the world-space rigid transform placing a prop's `socket` inside the hand `anchor` of an applied `pose`.
 * Returns `{ matrix, position, rotation, origin, gripAxis, forwardAxis, palmNormal, anchor }`.
 */
export function solveGripTransform(pose, socket, anchor, options) {
  const validatedSocket = validateSocketInput(socket);
  const solvedOptions = validateSolveOptions(options);
  const resolvedAnchor = resolveAnchorGeometry(pose, anchor, solvedOptions.gripRadius ?? validatedSocket.gripRadius);
  return writeRigidTransform(resolvedAnchor, validatedSocket, solvedOptions.rollOffset, solvedOptions.scale, solvedOptions.out);
}

function preparePropTargets(prop) {
  const isPartWithMatrix = value => isPlainObject(value) && (value.matrix === undefined || (value.matrix instanceof Float32Array && value.matrix.length === 16));
  if (Array.isArray(prop)) {
    if (!prop.length || !prop.every(part => isPlainObject(part) && part.matrix instanceof Float32Array && part.matrix.length === 16)) {
      throw new TypeError('Prop part array must be non-empty with a Float32Array(16) matrix on each part.');
    }
    return prop.map(part => ({ part, localMatrix: Float32Array.from(part.matrix) }));
  }
  if (!isPlainObject(prop)) {
    throw new TypeError('Prop must be a part { matrix }, a compound prop { parts }, or a non-empty array of parts.');
  }
  if (Array.isArray(prop.parts)) {
    if (!prop.parts.length || !prop.parts.every(part => isPlainObject(part) && part.matrix instanceof Float32Array && part.matrix.length === 16)) {
      throw new TypeError('Prop.parts must be a non-empty array of parts, each with a Float32Array(16) matrix.');
    }
    return prop.parts.map(part => ({ part, localMatrix: Float32Array.from(part.matrix) }));
  }
  if (Object.hasOwn(prop, 'matrix') || isPartWithMatrix(prop)) {
    if (prop.matrix === undefined) prop.matrix = mat4.identity(new Float32Array(16));
    if (!(prop.matrix instanceof Float32Array) || prop.matrix.length !== 16) {
      throw new TypeError('Prop.matrix must be a Float32Array of length 16.');
    }
    return [{ part: prop, localMatrix: null }];
  }
  throw new TypeError('Prop must have a Float32Array(16) matrix or a non-empty parts array.');
}

function registerApplyHook(pose, entry) {
  let state = poseApplyHookState.get(pose);
  if (!state) {
    const originalApply = pose.apply;
    const entries = new Set();
    state = { originalApply, entries };
    poseApplyHookState.set(pose, state);
    pose.apply = function applyWithGrips(...argumentsList) {
      const result = originalApply.apply(pose, argumentsList);
      for (const attached of entries) attached.update();
      return result;
    };
  }
  state.entries.add(entry);
}

function unregisterApplyHook(pose, entry) {
  const state = poseApplyHookState.get(pose);
  if (!state) return;
  state.entries.delete(entry);
  if (state.entries.size === 0) {
    pose.apply = state.originalApply;
    poseApplyHookState.delete(pose);
  }
}

function hasAppliedPose(pose, handJointName) {
  const world = probeJoint(pose, handJointName);
  if (!world) return false;
  return Math.hypot(world.rotation[0], world.rotation[1], world.rotation[2], world.rotation[3]) > NEAR_ZERO;
}

/**
 * Attach a prop part (or `{ parts }` / array of parts) to a character's grip socket.
 * Automatically updates prop matrices at the end of every `pose.apply(time)` until `detach()` is called.
 */
export function attachPropToGrip(pose, prop, socket, anchor, options = {}) {
  if (typeof pose?.apply !== 'function' || typeof pose?.jointWorld !== 'function') {
    throw new TypeError('attachPropToGrip needs a pose from createSkeletonPose or createAssetPose with apply() and jointWorld().');
  }
  if (!isPlainObject(options)) {
    throw new TypeError('attachPropToGrip options must be a plain object.');
  }
  rejectUnknownFields(options, ATTACH_OPTION_FIELDS, 'attachPropToGrip options');
  const autoUpdate = options.autoUpdate ?? true;
  if (typeof autoUpdate !== 'boolean') {
    throw new TypeError('attachPropToGrip options.autoUpdate must be a boolean.');
  }
  const validatedSocket = validateSocketInput(socket);
  const normalizedAnchor = validateAnchorInput(anchor);
  const discovered = discoverPoseAnchorJoints(pose, normalizedAnchor);
  const solveOptions = validateSolveOptions({
    rollOffset: options.rollOffset,
    gripRadius: options.gripRadius,
    scale: options.scale,
    out: options.out,
  });
  const targets = preparePropTargets(prop);
  const matrix = solveOptions.out ?? new Float32Array(16);
  const scratchMatrix = new Float32Array(16);

  function update() {
    const resolvedAnchor = resolveAnchorGeometry(pose, anchor, solveOptions.gripRadius ?? validatedSocket.gripRadius);
    writeRigidTransform(resolvedAnchor, validatedSocket, solveOptions.rollOffset, solveOptions.scale, matrix);
    for (const target of targets) {
      if (target.localMatrix === null) {
        target.part.matrix.set(matrix);
      } else {
        mat4.multiply(scratchMatrix, matrix, target.localMatrix);
        target.part.matrix.set(scratchMatrix);
      }
    }
    return matrix;
  }

  const hookEntry = { update };
  if (autoUpdate) registerApplyHook(pose, hookEntry);
  if (hasAppliedPose(pose, discovered.handJointName)) update();

  return Object.freeze({
    matrix,
    socket: validatedSocket,
    anchor: normalizedAnchor,
    update,
    detach() {
      unregisterApplyHook(pose, hookEntry);
    },
  });
}

function curlWeightFunction(value, label) {
  if (value === undefined) return () => 1;
  if (typeof value === 'function') return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be from 0 to 1, or a function of time.`);
  }
  return () => value;
}

function resolveSolverJointIndex(prepared, resolveJoint, candidates, explicitName, label) {
  if (explicitName !== undefined) return resolveJoint(explicitName, label);
  for (const candidate of candidates) {
    try {
      return resolveJoint(candidate, label);
    } catch {
      // Probe next candidate bone name.
    }
  }
  return -1;
}

function segmentLengthOfJoint(prepared, jointIndex, fallbackLength) {
  const childIndex = prepared.joints.findIndex(joint => joint.parent === jointIndex);
  if (childIndex < 0) return fallbackLength;
  const length = vec3.length(prepared.restTranslations[childIndex]);
  return length > NEAR_ZERO ? length : fallbackLength;
}

function fingerSegmentDirection(state, prepared, jointIndex, childIndex, fallbackDirection) {
  if (childIndex >= 0) {
    const span = vec3.subtract(new Float64Array(3), state.positions[childIndex], state.positions[jointIndex]);
    const length = vec3.length(span);
    if (length > NEAR_ZERO) return vec3.scale(span, span, 1 / length);
  }
  return vec3.normalize(new Float64Array(3), vec3.transformQuat(new Float64Array(3), fallbackDirection, state.rotations[jointIndex]));
}

function signedBendAngle(direction, reference, palmNormal) {
  const forwardComponent = vec3.dot(direction, reference);
  const palmComponent = vec3.dot(direction, palmNormal);
  return Math.atan2(palmComponent, forwardComponent);
}

/**
 * Custom IK solver entry `{ type: 'custom', create }` for `createSkeletonPose` or `createAssetPose` that curls a hand's
 * fingers and thumb to wrap cleanly around a handle of `gripRadius`.
 */
export function createGripCurlSolver(anchor, socket, options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createGripCurlSolver options must be a plain object.');
  }
  rejectUnknownFields(options, CURL_OPTION_FIELDS, 'createGripCurlSolver options');
  const validatedSocket = socket === undefined ? null : validateSocketInput(socket);
  const normalizedAnchor = validateAnchorInput(anchor);
  const curlMode = options.curlMode ?? 'fit';
  if (curlMode !== 'fit' && curlMode !== 'additive') {
    throw new RangeError('createGripCurlSolver curlMode must be "fit" or "additive".');
  }
  const curlScale = options.curlScale === undefined
    ? 1
    : readPositiveNumber(options.curlScale, 2, 'createGripCurlSolver curlScale', '1');
  const thumbWeight = options.thumbWeight === undefined
    ? 0.85
    : readFiniteNumber(options.thumbWeight, 'createGripCurlSolver thumbWeight');
  if (thumbWeight < 0 || thumbWeight > 1) {
    throw new RangeError('createGripCurlSolver thumbWeight must be from 0 to 1.');
  }
  const explicitRadius = options.gripRadius === undefined
    ? null
    : readPositiveNumber(options.gripRadius, MAX_RADIUS, 'createGripCurlSolver gripRadius', '0.02');
  const weightEvaluator = curlWeightFunction(options.weight, 'createGripCurlSolver weight');

  return {
    type: 'custom',
    weight: weightEvaluator,
    create(prepared, resolveJoint, label) {
      const explicitHand = normalizedAnchor.joints?.hand ?? normalizedAnchor.handJoint;
      let handIndex = resolveSolverJointIndex(prepared, resolveJoint, [explicitHand], undefined, label);
      if (handIndex < 0 && normalizedAnchor.isCanonicalHandShorthand) {
        handIndex = resolveSolverJointIndex(prepared, resolveJoint, handCandidateNames(normalizedAnchor.side), undefined, label);
      }
      if (handIndex < 0) {
        throw new RangeError(`${label}: handJoint "${explicitHand}" is not in the rig.`);
      }
      const lowerArmIndex = resolveSolverJointIndex(
        prepared,
        resolveJoint,
        lowerArmCandidateNames(normalizedAnchor.side),
        normalizedAnchor.joints?.lowerArm,
        label,
      );

      const chains = [];
      for (const finger of [...FINGER_NAMES, 'thumb']) {
        const stageJoints = [];
        for (let stage = 0; stage < 3; stage++) {
          const explicitRole = stage === 0 ? finger : `${finger}${FINGER_STAGES[stage]}`;
          const index = resolveSolverJointIndex(
            prepared,
            resolveJoint,
            fingerCandidateNames(normalizedAnchor.side, finger, stage),
            normalizedAnchor.joints?.[explicitRole],
            label,
          );
          if (index >= 0) stageJoints.push(index);
        }
        if (!stageJoints.length) continue;
        const childIndices = stageJoints.map((jointIndex, slot) => {
          if (slot + 1 < stageJoints.length) return stageJoints[slot + 1];
          return prepared.joints.findIndex(joint => joint.parent === jointIndex);
        });
        const restLengths = stageJoints.map((jointIndex, slot) => segmentLengthOfJoint(prepared, jointIndex, 0.025 * (0.8 ** slot)));
        const localDirs = stageJoints.map((jointIndex, slot) => {
          const child = childIndices[slot];
          if (child >= 0) {
            const offset = prepared.restTranslations[child];
            if (vec3.length(offset) > NEAR_ZERO) return vec3.normalize(new Float64Array(3), offset);
          }
          const parentOffset = prepared.restTranslations[jointIndex];
          if (vec3.length(parentOffset) > NEAR_ZERO) {
            const inParent = vec3.normalize(new Float64Array(3), parentOffset);
            return vec3.transformQuat(new Float64Array(3), inParent, quat.invert(new Float64Array(4), prepared.restRotations[jointIndex]));
          }
          return new Float64Array([0, 1, 0]);
        });
        chains.push({
          finger,
          isThumb: finger === 'thumb',
          joints: stageJoints,
          childIndices,
          restLengths,
          localDirs,
        });
      }

      const joints = chains.flatMap(chain => chain.joints);
      const scratchTurn = new Float64Array(4);
      const scratchWorld = new Float64Array(4);

      function solve(_time, context, solverWeight) {
        if (!chains.length || !(solverWeight > 0)) {
          return { reached: true, error: 0, warnings: [], limited: [] };
        }
        const { state } = context;
        const fingerChains = chains.filter(chain => !chain.isThumb);
        const knucklePositions = fingerChains.map(chain => state.positions[chain.joints[0]]);
        const knuckleCenter = knucklePositions.length ? meanVector(knucklePositions) : null;

        let handForward;
        let palmSpan = DEFAULT_PALM_SPAN;
        if (knuckleCenter && vec3.distance(knuckleCenter, state.positions[handIndex]) > NEAR_ZERO) {
          handForward = vec3.subtract(new Float64Array(3), knuckleCenter, state.positions[handIndex]);
          palmSpan = vec3.length(handForward);
          vec3.scale(handForward, handForward, 1 / palmSpan);
        } else if (lowerArmIndex >= 0 && vec3.distance(state.positions[handIndex], state.positions[lowerArmIndex]) > NEAR_ZERO) {
          handForward = vec3.subtract(new Float64Array(3), state.positions[handIndex], state.positions[lowerArmIndex]);
          palmSpan = vec3.length(handForward) * 0.3;
          vec3.normalize(handForward, handForward);
        } else {
          handForward = vec3.normalize(new Float64Array(3), vec3.transformQuat(new Float64Array(3), [0, 1, 0], state.rotations[handIndex]));
        }

        const indexChain = fingerChains.find(chain => chain.finger === 'index');
        const middleChain = fingerChains.find(chain => chain.finger === 'middle');
        const ringChain = fingerChains.find(chain => chain.finger === 'ring');
        const pinkyChain = fingerChains.find(chain => chain.finger === 'pinky');
        let gripAxis = null;
        const axisCandidates = [
          [pinkyChain, indexChain],
          [ringChain, indexChain],
          [pinkyChain, middleChain],
          [middleChain, indexChain],
        ];
        for (const [fromChain, toChain] of axisCandidates) {
          if (!fromChain || !toChain) continue;
          const span = vec3.subtract(new Float64Array(3), state.positions[toChain.joints[0]], state.positions[fromChain.joints[0]]);
          if (vec3.length(span) > NEAR_ZERO) {
            gripAxis = vec3.normalize(span, span);
            break;
          }
        }
        if (!gripAxis) {
          const localLateral = normalizedAnchor.side === 'left' ? [-1, 0, 0] : [1, 0, 0];
          const lateral = vec3.transformQuat(new Float64Array(3), localLateral, state.rotations[handIndex]);
          gripAxis = orthogonalizeUnit(lateral, handForward) ?? perpendicularDirection(handForward);
        }

        let palmNormal = normalizedAnchor.side === 'left'
          ? vec3.cross(new Float64Array(3), handForward, gripAxis)
          : vec3.cross(new Float64Array(3), gripAxis, handForward);
        if (vec3.length(palmNormal) > COLLINEAR_THRESHOLD) {
          vec3.normalize(palmNormal, palmNormal);
        } else {
          palmNormal = perpendicularDirection(gripAxis);
        }

        const radius = explicitRadius ?? normalizedAnchor.gripRadius ?? validatedSocket?.gripRadius ?? (palmSpan * DEFAULT_PALM_RADIUS_FRACTION);
        const worldScale = state.scales[handIndex] > NEAR_ZERO ? state.scales[handIndex] : 1;
        const effectiveRadius = radius + palmSpan * 0.1;

        for (const chain of chains) {
          const targetNormal = chain.isThumb
            ? vec3.normalize(new Float64Array(3), vec3.scaleAndAdd(new Float64Array(3), vec3.scale(new Float64Array(3), palmNormal, 0.72), gripAxis, -0.68))
            : palmNormal;
          let previousWorldDir = handForward;
          for (let stage = 0; stage < chain.joints.length; stage++) {
            const jointIndex = chain.joints[stage];
            const jointScale = state.scales[jointIndex] > NEAR_ZERO ? state.scales[jointIndex] : worldScale;
            const segmentLength = chain.restLengths[stage] * jointScale;
            const prevLength = stage > 0 ? chain.restLengths[stage - 1] * jointScale : segmentLength;
            const stageTargetAngle = stage === 0
              ? Math.atan2(segmentLength * 0.5, effectiveRadius) + PROXIMAL_BASE_BEND_RADIANS
              : Math.atan2(prevLength * 0.5, effectiveRadius) + Math.atan2(segmentLength * 0.5, effectiveRadius);
            const scaledTarget = Math.min(MAX_CURL_RADIANS, Math.max(MIN_CURL_RADIANS, stageTargetAngle * curlScale));
            const currentDir = fingerSegmentDirection(state, prepared, jointIndex, chain.childIndices[stage], chain.localDirs[stage]);
            const curlAxis = vec3.cross(new Float64Array(3), currentDir, targetNormal);
            if (vec3.length(curlAxis) <= COLLINEAR_THRESHOLD) {
              previousWorldDir = currentDir;
              continue;
            }
            vec3.normalize(curlAxis, curlAxis);
            const currentBend = signedBendAngle(currentDir, previousWorldDir, targetNormal);
            const deltaAngle = curlMode === 'additive'
              ? scaledTarget
              : Math.min(MAX_CURL_RADIANS, Math.max(0, scaledTarget - Math.max(-0.5, currentBend)));
            const stageWeight = chain.isThumb ? solverWeight * thumbWeight : solverWeight;
            if (deltaAngle > NEAR_ZERO && stageWeight > 0) {
              quat.setAxisAngle(scratchTurn, curlAxis, deltaAngle * stageWeight);
              quat.multiply(scratchWorld, scratchTurn, state.rotations[jointIndex]);
              quat.normalize(scratchWorld, scratchWorld);
              context.setWorldRotation(jointIndex, scratchWorld, 1);
            }
            previousWorldDir = fingerSegmentDirection(state, prepared, jointIndex, chain.childIndices[stage], chain.localDirs[stage]);
          }
        }
        return { reached: true, error: 0, warnings: [], limited: [] };
      }

      return { joints, solve };
    },
  };
}
