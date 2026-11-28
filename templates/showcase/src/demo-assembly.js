import { mat4 } from 'gl-matrix';

function createBoxGeometry(width, height, depth) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const halfDepth = depth / 2;
  const positions = new Float32Array([
    -halfWidth, -halfHeight, halfDepth, halfWidth, -halfHeight, halfDepth, halfWidth, halfHeight, halfDepth, -halfWidth, halfHeight, halfDepth,
    halfWidth, -halfHeight, -halfDepth, -halfWidth, -halfHeight, -halfDepth, -halfWidth, halfHeight, -halfDepth, halfWidth, halfHeight, -halfDepth,
    -halfWidth, halfHeight, halfDepth, halfWidth, halfHeight, halfDepth, halfWidth, halfHeight, -halfDepth, -halfWidth, halfHeight, -halfDepth,
    -halfWidth, -halfHeight, -halfDepth, halfWidth, -halfHeight, -halfDepth, halfWidth, -halfHeight, halfDepth, -halfWidth, -halfHeight, halfDepth,
    halfWidth, -halfHeight, halfDepth, halfWidth, -halfHeight, -halfDepth, halfWidth, halfHeight, -halfDepth, halfWidth, halfHeight, halfDepth,
    -halfWidth, -halfHeight, -halfDepth, -halfWidth, -halfHeight, halfDepth, -halfWidth, halfHeight, halfDepth, -halfWidth, halfHeight, -halfDepth,
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0,
    0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0,
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0,
    -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 5, 6, 4, 6, 7,
    8, 9, 10, 8, 10, 11,
    12, 13, 14, 12, 14, 15,
    16, 17, 18, 16, 18, 19,
    20, 21, 22, 20, 22, 23,
  ]);
  return { positions, normals, indices };
}

function createCylinderGeometry(radius, height, radialSegments = 24) {
  const positions = [];
  const normals = [];
  const indices = [];
  const halfHeight = height / 2;

  for (let segment = 0; segment <= radialSegments; segment++) {
    const angle = (segment / radialSegments) * Math.PI * 2;
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    positions.push(x * radius, -halfHeight, z * radius, x * radius, halfHeight, z * radius);
    normals.push(x, 0, z, x, 0, z);
  }
  for (let segment = 0; segment < radialSegments; segment++) {
    const base = segment * 2;
    indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
  }

  const topCenter = positions.length / 3;
  positions.push(0, halfHeight, 0);
  normals.push(0, 1, 0);
  const topRingStart = positions.length / 3;
  for (let segment = 0; segment <= radialSegments; segment++) {
    const angle = (segment / radialSegments) * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, halfHeight, Math.sin(angle) * radius);
    normals.push(0, 1, 0);
  }
  for (let segment = 0; segment < radialSegments; segment++) {
    indices.push(topCenter, topRingStart + segment + 1, topRingStart + segment);
  }

  const bottomCenter = positions.length / 3;
  positions.push(0, -halfHeight, 0);
  normals.push(0, -1, 0);
  const bottomRingStart = positions.length / 3;
  for (let segment = 0; segment <= radialSegments; segment++) {
    const angle = (segment / radialSegments) * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, -halfHeight, Math.sin(angle) * radius);
    normals.push(0, -1, 0);
  }
  for (let segment = 0; segment < radialSegments; segment++) {
    indices.push(bottomCenter, bottomRingStart + segment, bottomRingStart + segment + 1);
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

function makePart(name, geometry, basePosition, material, offsets) {
  const matrix = mat4.create();
  mat4.translate(matrix, matrix, basePosition);
  return {
    part: {
      name,
      geometry,
      matrix,
      material: { emission: 0, tag: 'standard', ...material },
    },
    basePosition,
    explodeOffset: offsets.explode ?? [0, 0, 0],
    pullOutOffset: offsets.pullOut ?? [0, 0, 0],
  };
}

export function createFieldSynthAssembly() {
  const anodizedDark = { color: [0.06, 0.065, 0.075], metallic: 0.7, roughness: 0.4 };
  const brushedAluminum = { color: [0.68, 0.67, 0.64], metallic: 0.88, roughness: 0.28 };
  const moltenAccent = { color: [0.85, 0.24, 0.06], metallic: 0.12, roughness: 0.42 };
  const siliconeFoot = { color: [0.03, 0.03, 0.035], metallic: 0.0, roughness: 0.88 };
  const oledDisplay = { color: [0.015, 0.018, 0.025], metallic: 0.05, roughness: 0.14 };
  const amberMeter = { color: [0.99, 0.52, 0.12], metallic: 0.0, roughness: 0.3, emission: 1.5 };

  const entries = [
    makePart('Chassis frame', createBoxGeometry(1.6, 0.28, 1.1), [0, 0.18, 0], brushedAluminum, { explode: [0, 0, 0] }),
    makePart('Internal logic board', createBoxGeometry(1.36, 0.04, 0.84), [0, 0.19, -0.02], anodizedDark, { explode: [0, 0.24, 0] }),
    makePart('Top face plate', createBoxGeometry(1.56, 0.06, 1.06), [0, 0.35, 0], anodizedDark, { explode: [0, 0.46, 0] }),
    makePart('OLED screen glass', createBoxGeometry(0.62, 0.02, 0.34), [-0.34, 0.388, -0.14], oledDisplay, { explode: [0, 0.56, 0] }),
    makePart('Waveform bar', createBoxGeometry(0.46, 0.015, 0.05), [-0.34, 0.398, -0.14], amberMeter, { explode: [0, 0.60, 0] }),
    makePart('Pull-out keybed tray', createBoxGeometry(1.36, 0.12, 0.74), [0, 0.11, 0.16], brushedAluminum, { explode: [0, -0.10, 0.34], pullOut: [0, 0, 0.5] }),
    makePart('Tray grip rail', createBoxGeometry(0.44, 0.05, 0.06), [0, 0.11, 0.55], moltenAccent, { explode: [0, -0.10, 0.42], pullOut: [0, 0, 0.5] }),
  ];

  const keyGeometry = createBoxGeometry(0.11, 0.05, 0.36);
  for (let keyIndex = 0; keyIndex < 9; keyIndex++) {
    const x = -0.52 + keyIndex * 0.13;
    const keyMaterial = keyIndex === 0 ? moltenAccent : { color: [0.92, 0.90, 0.85], metallic: 0.04, roughness: 0.44 };
    entries.push(
      makePart(`Pad ${keyIndex + 1}`, keyGeometry, [x, 0.185, 0.28], keyMaterial, { explode: [0, -0.04, 0.38], pullOut: [0, 0, 0.5] }),
    );
  }

  const knobGeometry = createCylinderGeometry(0.085, 0.09, 28);
  const encoderConfigs = [
    { name: 'Gain encoder', x: 0.24, z: -0.16, material: moltenAccent },
    { name: 'Filter encoder', x: 0.48, z: -0.16, material: brushedAluminum },
    { name: 'Drive encoder', x: 0.24, z: 0.12, material: brushedAluminum },
    { name: 'Mix encoder', x: 0.48, z: 0.12, material: brushedAluminum },
  ];
  for (const encoder of encoderConfigs) {
    entries.push(
      makePart(encoder.name, knobGeometry, [encoder.x, 0.425, encoder.z], encoder.material, { explode: [0, 0.72, 0] }),
    );
  }

  const footGeometry = createCylinderGeometry(0.08, 0.04, 20);
  const footCorners = [
    [-0.68, -0.44],
    [0.68, -0.44],
    [-0.68, 0.44],
    [0.68, 0.44],
  ];
  for (const [index, [x, z]] of footCorners.entries()) {
    entries.push(
      makePart(`Foot ${index + 1}`, footGeometry, [x, 0.02, z], siliconeFoot, { explode: [x * 0.12, -0.22, z * 0.12] }),
    );
  }

  let currentPullOut = 0;
  let currentExplode = 0;
  let targetPullOut = 0;
  let targetExplode = 0;

  function applyPose() {
    for (const entry of entries) {
      mat4.identity(entry.part.matrix);
      mat4.translate(entry.part.matrix, entry.part.matrix, [
        entry.basePosition[0] + entry.explodeOffset[0] * currentExplode + entry.pullOutOffset[0] * currentPullOut,
        entry.basePosition[1] + entry.explodeOffset[1] * currentExplode + entry.pullOutOffset[1] * currentPullOut,
        entry.basePosition[2] + entry.explodeOffset[2] * currentExplode + entry.pullOutOffset[2] * currentPullOut,
      ]);
    }
  }

  function step(deltaSeconds = 0.016, reducedMotion = false) {
    if (reducedMotion) {
      const changed = currentPullOut !== targetPullOut || currentExplode !== targetExplode;
      currentPullOut = targetPullOut;
      currentExplode = targetExplode;
      if (changed) applyPose();
      return { changed, active: false };
    }
    const previousPullOut = currentPullOut;
    const previousExplode = currentExplode;
    const factor = 1 - Math.exp(-10 * Math.min(0.05, Math.max(0.001, deltaSeconds)));
    currentPullOut += (targetPullOut - currentPullOut) * factor;
    currentExplode += (targetExplode - currentExplode) * factor;
    const pullRemaining = Math.abs(targetPullOut - currentPullOut);
    const explodeRemaining = Math.abs(targetExplode - currentExplode);
    if (pullRemaining < 1e-3) currentPullOut = targetPullOut;
    if (explodeRemaining < 1e-3) currentExplode = targetExplode;
    const changed = currentPullOut !== previousPullOut || currentExplode !== previousExplode;
    if (changed) applyPose();
    return { changed, active: pullRemaining >= 1e-3 || explodeRemaining >= 1e-3 };
  }

  return {
    parts: entries.map(entry => entry.part),
    setTargets({ pullOut, explode }) {
      if (pullOut !== undefined) targetPullOut = pullOut;
      if (explode !== undefined) targetExplode = explode;
    },
    step,
  };
}
