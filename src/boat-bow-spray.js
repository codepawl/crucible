// Deterministic camera-facing bow spray sprites driven by a boat hull's slam pulse (#3043).
// Every droplet is a closed-form function of its seeded launch at a fixed emission tick, so any seek
// repeats bit for bit without replaying earlier frames.
import { createGenerator, facingMatrix, normalized } from './particles.js';
import { slamPulse } from './ocean-wake.js';

const SPRAY_TEXTURE_SIZE = 64;
const SPRAY_EMIT_STEP = 1 / 30;
const SPRAY_DRAG = 1.8;
const SPRAY_GRAVITY = -9.81;
const MAX_LIFETIME_SCALE = 1.15;
const MINIMUM_LIFETIME_SCALE = 0.5;
const FADE_IN_FRACTION = 0.12;
const FADE_OUT_POWER = 1.5;
const QUAD_CORNERS = Object.freeze([
  [-0.5, -0.5, 0, 1],
  [0.5, -0.5, 1, 1],
  [0.5, 0.5, 1, 0],
  [-0.5, 0.5, 0, 0],
]);
const QUAD_INDICES = Object.freeze([0, 1, 2, 0, 2, 3]);

let cachedTextureDescriptor = null;

function createSprayPixels() {
  const size = SPRAY_TEXTURE_SIZE;
  const data = new Uint8ClampedArray(size * size * 4);
  const center = (size - 1) / 2;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const dx = (column - center) / center;
      const dy = (row - center) / center;
      const distance = Math.hypot(dx, dy);
      const offset = (row * size + column) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      if (distance >= 1) {
        data[offset + 3] = 0;
        continue;
      }
      const soft = 0.5 + 0.5 * Math.cos(Math.PI * distance);
      const grain = 0.85 + 0.15 * Math.sin(dx * 11 + dy * 7) * Math.cos(dx * 5 - dy * 13);
      data[offset + 3] = Math.round(255 * Math.min(1, Math.pow(soft, 1.05) * grain));
    }
  }
  return { data, width: size, height: size };
}

/** Shared soft-round RGBA texture descriptor for bow spray sprites. */
export function sprayTextureDescriptor() {
  if (cachedTextureDescriptor) return cachedTextureDescriptor;
  const pixels = createSprayPixels();
  const image = typeof ImageData === 'undefined' ? pixels : new ImageData(pixels.data, pixels.width, pixels.height);
  cachedTextureDescriptor = Object.freeze({
    image,
    colorSpace: 'srgb',
    wrapS: 33071,
    wrapT: 33071,
    minFilter: 9987,
    magFilter: 9729,
  });
  return cachedTextureDescriptor;
}

function rollAroundNormal(matrix, angle) {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  for (let row = 0; row < 3; row++) {
    const first = matrix[row * 3];
    const second = matrix[row * 3 + 1];
    matrix[row * 3] = first * cosine + second * sine;
    matrix[row * 3 + 1] = second * cosine - first * sine;
  }
}

function buildSprayGeometry(droplets, camera) {
  const count = droplets.length;
  const positions = new Float32Array(count * 12);
  const normals = new Float32Array(count * 12);
  const uvs = new Float32Array(count * 8);
  const colors = new Float32Array(count * 12);
  const vertexOpacity = new Float32Array(count * 4);
  const indices = new Uint32Array(count * 6);
  const matrix = new Float64Array(9);
  colors.fill(1);
  for (let index = 0; index < count; index++) {
    const droplet = droplets[index];
    facingMatrix(droplet.position, camera, matrix);
    rollAroundNormal(matrix, droplet.roll);
    const vertexBase = index * 4;
    const indexBase = index * 6;
    const normalX = matrix[2];
    const normalY = matrix[5];
    const normalZ = matrix[8];
    for (let corner = 0; corner < 4; corner++) {
      const [localX, localY, u, v] = QUAD_CORNERS[corner];
      const vertex = vertexBase + corner;
      const positionOffset = vertex * 3;
      const uvOffset = vertex * 2;
      positions[positionOffset] = droplet.position[0] + (matrix[0] * localX + matrix[1] * localY) * droplet.size;
      positions[positionOffset + 1] = droplet.position[1] + (matrix[3] * localX + matrix[4] * localY) * droplet.size;
      positions[positionOffset + 2] = droplet.position[2] + (matrix[6] * localX + matrix[7] * localY) * droplet.size;
      normals[positionOffset] = normalX;
      normals[positionOffset + 1] = normalY;
      normals[positionOffset + 2] = normalZ;
      uvs[uvOffset] = u;
      uvs[uvOffset + 1] = v;
      vertexOpacity[vertex] = droplet.alpha;
    }
    for (let corner = 0; corner < 6; corner++) {
      indices[indexBase + corner] = vertexBase + QUAD_INDICES[corner];
    }
  }
  return Object.freeze({ positions, normals, uvs, colors, vertexOpacity, indices });
}

function cameraCacheKey(camera) {
  if (!camera) return 'none';
  const eye = camera.eye;
  const up = camera.up ?? [0, 1, 0];
  return `${eye[0]},${eye[1]},${eye[2]}|${up[0]},${up[1]},${up[2]}`;
}

/**
 * Deterministic bow spray sprite emitter for a boat hull. Evaluates `closingSpeedAt` (`heave + pitch`) and
 * `forwardSpeedAt` at fixed emission ticks over the active decay window and builds one camera-facing blended
 * sprite part when droplets are active, or `null` when calm water or rest leaves none.
 */
export function createBoatBowSpray({ bodyNode, duration, halfBeam, halfLength, bowAt, closingSpeedAt, forwardSpeedAt, wake }) {
  const spray = wake.bowSpray;
  if (!spray) return null;
  const baseLifetime = spray.lifetime ?? wake.slamDecay;
  const maxLifetime = baseLifetime * MAX_LIFETIME_SCALE;
  const perTick = Math.max(2, Math.min(16, Math.ceil(spray.count / 12)));
  const tickPulseCache = new Map();
  const material = Object.freeze({
    id: `${bodyNode}-bow-spray`,
    tag: 'unlit',
    color: [...spray.color],
    metallic: 0,
    roughness: 1,
    emission: 0,
    opacity: 1,
    alphaMode: 'blend',
    doubleSided: true,
    depthTest: true,
    map: sprayTextureDescriptor(),
  });
  const identityMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  let lastResult = null;

  function pulseAtTick(tick) {
    if (tickPulseCache.has(tick)) return tickPulseCache.get(tick);
    const tickTime = tick * SPRAY_EMIT_STEP;
    const pulse = slamPulse({
      closingSpeed: closingSpeedAt(tickTime),
      forwardSpeed: forwardSpeedAt(tickTime),
      fullSpeed: wake.slamSpeed,
      fullForward: wake.slamForward,
    });
    tickPulseCache.set(tick, pulse);
    return pulse;
  }

  function evaluateDroplets(time) {
    if (!(time >= 0)) return [];
    const maxEmitTime = Math.min(time, duration);
    const earliestEmitTime = Math.max(0, time - maxLifetime);
    const lastTick = Math.floor(maxEmitTime / SPRAY_EMIT_STEP);
    const firstTick = Math.max(0, Math.floor(earliestEmitTime / SPRAY_EMIT_STEP));
    const droplets = [];
    const settledY = SPRAY_GRAVITY / SPRAY_DRAG;
    for (let tick = lastTick; tick >= firstTick && droplets.length < spray.count; tick--) {
      const pulse = pulseAtTick(tick);
      if (pulse <= 0) continue;
      const tickTime = tick * SPRAY_EMIT_STEP;
      for (let slot = 0; slot < perTick && droplets.length < spray.count; slot++) {
        if (slot / perTick >= pulse) break;
        const random = createGenerator(spray.seed, tick * perTick + slot);
        const birth = tickTime + random() * SPRAY_EMIT_STEP;
        const life = baseLifetime * (MINIMUM_LIFETIME_SCALE + (MAX_LIFETIME_SCALE - MINIMUM_LIFETIME_SCALE) * random());
        const age = time - birth;
        if (birth > duration || age < 0 || age >= life) continue;
        const { bow, forward, right, seaLevel, hullSpeed } = bowAt(birth);
        const sideSign = slot % 2 === 0 ? 1 : -1;
        const sideOffset = sideSign * (0.15 + 0.45 * random()) * halfBeam;
        const aftOffset = -(0.05 + 0.4 * random()) * Math.min(halfLength * 0.45, 0.9);
        const originX = bow[0] + right[0] * sideOffset + forward[0] * aftOffset;
        const originZ = bow[2] + right[2] * sideOffset + forward[2] * aftOffset;
        const originY = Math.max(seaLevel, bow[1] - 0.12) + 0.04 + 0.08 * random();
        const launchDirection = normalized([
          right[0] * sideSign * (0.65 + 0.75 * random()) + forward[0] * (0.1 + 0.4 * random()),
          0.45 + 0.5 * random(),
          right[2] * sideSign * (0.65 + 0.75 * random()) + forward[2] * (0.1 + 0.4 * random()),
        ]);
        const launchSpeed = spray.speed * (0.35 + 0.75 * pulse) * (0.65 + 0.7 * random());
        const forwardCarry = 0.35 * hullSpeed;
        const velocityX = launchDirection[0] * launchSpeed + forward[0] * forwardCarry;
        const velocityY = launchDirection[1] * launchSpeed;
        const velocityZ = launchDirection[2] * launchSpeed + forward[2] * forwardCarry;
        const dragFactor = (1 - Math.exp(-SPRAY_DRAG * age)) / SPRAY_DRAG;
        const lifeFraction = age / life;
        const fadeIn = Math.min(1, lifeFraction / FADE_IN_FRACTION);
        const fadeOut = Math.pow(1 - lifeFraction, FADE_OUT_POWER);
        droplets.push({
          position: [
            originX + velocityX * dragFactor,
            originY + settledY * age + (velocityY - settledY) * dragFactor,
            originZ + velocityZ * dragFactor,
          ],
          size: spray.size * (0.5 + 0.85 * random()) * (0.55 + 0.65 * pulse) * (0.55 + 0.9 * lifeFraction),
          alpha: spray.opacity * (0.35 + 0.65 * pulse) * fadeIn * fadeOut,
          roll: (random() - 0.5) * Math.PI * 2 + (random() - 0.5) * 3 * age,
          pulse,
          age,
          life,
        });
      }
    }
    return droplets;
  }

  function part(time, camera) {
    const key = `${time}|${cameraCacheKey(camera)}`;
    if (lastResult?.key === key) return lastResult.part;
    const droplets = evaluateDroplets(time);
    const built = droplets.length === 0 ? null : Object.freeze({
      name: `${bodyNode}-bow-spray`,
      geometry: buildSprayGeometry(droplets, camera),
      material,
      matrix: identityMatrix,
      castShadow: false,
      receiveShadow: false,
    });
    lastResult = { key, part: built };
    return built;
  }

  return Object.freeze({ evaluateDroplets, part });
}
