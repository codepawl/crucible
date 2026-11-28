import { mat4 } from 'gl-matrix';
import { CrucibleRenderer } from './renderer.js';
import { fitPerspectiveDistance } from './camera.js';
import { createOrbitController, attachOrbitControls } from './orbit-controller.js';
import { loadViewTransformForRendererOptions } from './view-transform-loading.js';
import { createLightingSetupMap } from './lighting-setups.js';
import { loadGltf } from './gltf.js';
import { createAgentScene } from './agent-scene.js';
import { loadAllAgentSceneModules } from './agent-scene-modules.js';
import { agentEnvironmentMap } from './agent-look.js';
import { CRUCIBLE_MARK_LAYERS, CRUCIBLE_MARK_VIEW_BOX } from './studio-brand-mark.js';

export const SHOWCASE_THEMES = Object.freeze({
  prototype: Object.freeze({
    id: 'prototype',
    label: 'Prototype',
    background: '#f8f7f1',
    backgroundGradient: 'radial-gradient(circle at 50% 42%, #fcfbf7 0%, #efede4 100%)',
    surface: 'rgba(255, 255, 255, 0.88)',
    surfaceHover: '#f4f2ea',
    border: 'rgba(42, 40, 45, 0.14)',
    text: '#2a282d',
    muted: '#5f5d64',
    accent: '#df5829',
    accentText: '#ffffff',
    gridMajor: [42, 40, 45, 58],
    gridMinor: [42, 40, 45, 22],
    gridAxis: [223, 88, 41, 118],
    skyTop: [0.92, 0.91, 0.87],
    skyBottom: [0.88, 0.87, 0.82],
    keyColor: [2.75, 2.6, 2.45],
    environmentIntensity: 0.85,
    exposure: 0.96,
  }),
  studio: Object.freeze({
    id: 'studio',
    label: 'Studio',
    background: '#17161a',
    backgroundGradient: 'radial-gradient(circle at 50% 42%, #24222b 0%, #17161a 100%)',
    surface: 'rgba(32, 31, 36, 0.88)',
    surfaceHover: '#2c2a32',
    border: 'rgba(241, 240, 236, 0.14)',
    text: '#f1f0ec',
    muted: '#a09ea6',
    accent: '#fc9132',
    accentText: '#17161a',
    gridMajor: [241, 240, 236, 48],
    gridMinor: [241, 240, 236, 18],
    gridAxis: [252, 145, 50, 115],
    skyTop: [0.025, 0.024, 0.032],
    skyBottom: [0.018, 0.017, 0.022],
    keyColor: [2.6, 2.52, 2.45],
    environmentIntensity: 0.92,
    exposure: 1.0,
  }),
});

const CLAMP_TO_EDGE = 33071;
const LINEAR_MIPMAP_LINEAR = 9987;
const LINEAR_FILTER = 9729;
const MARK_LAYER_COLORS = Object.freeze({
  body: '#393842',
  shadow: '#2a282d',
  'molten-deep': '#df5829',
  molten: '#fc9132',
  'face-shadow': '#c8c7ce',
  face: '#fefefd',
  eye: '#111114',
});

function resolveTheme(themeName) {
  return SHOWCASE_THEMES[themeName] ?? SHOWCASE_THEMES.prototype;
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
  const scaled = clampUnit((value - edge0) / (edge1 - edge0));
  return scaled * scaled * (3 - 2 * scaled);
}

function blendRgbaPixel(pixels, offset, color, coverage) {
  const sourceAlpha = (color[3] / 255) * coverage;
  if (sourceAlpha <= 0) return;
  const currentAlpha = pixels[offset + 3] / 255;
  const outputAlpha = sourceAlpha + currentAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) return;
  for (let channel = 0; channel < 3; channel++) {
    const currentChannel = pixels[offset + channel];
    const sourceChannel = color[channel];
    const blended = (sourceChannel * sourceAlpha + currentChannel * currentAlpha * (1 - sourceAlpha)) / outputAlpha;
    pixels[offset + channel] = Math.round(blended);
  }
  pixels[offset + 3] = Math.round(outputAlpha * 255);
}

function gridLineCoverage(coordinate, lineHalfWidth) {
  const distanceToLine = Math.abs(coordinate - Math.round(coordinate));
  if (distanceToLine >= lineHalfWidth) return 0;
  return 1 - smoothstep(lineHalfWidth * 0.25, lineHalfWidth, distanceToLine);
}

export function createCadGridFloor(options = {}) {
  const {
    radius = 6,
    height = 0,
    theme: themeName = 'prototype',
    majorStep = 1,
    subdivisions = 4,
    textureSize = 512,
  } = options;
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Grid radius must be a positive finite number.');
  if (!Number.isInteger(textureSize) || textureSize < 64) throw new RangeError('Grid textureSize must be an integer >= 64.');

  const theme = resolveTheme(themeName);
  const pixels = new Uint8ClampedArray(textureSize * textureSize * 4);
  const cellSpan = majorStep / Math.max(1, subdivisions);
  const majorWidth = 0.032;
  const minorWidth = 0.045;
  const axisWidth = 0.042;

  for (let row = 0; row < textureSize; row++) {
    const normalizedZ = (row + 0.5) / textureSize * 2 - 1;
    const worldZ = normalizedZ * radius;
    for (let column = 0; column < textureSize; column++) {
      const normalizedX = (column + 0.5) / textureSize * 2 - 1;
      const worldX = normalizedX * radius;
      const radialDistance = Math.hypot(normalizedX, normalizedZ);
      const radialFade = 1 - smoothstep(0.55, 0.96, radialDistance);
      if (radialFade <= 0) continue;

      const offset = (row * textureSize + column) * 4;
      const minorCoverage = Math.max(
        gridLineCoverage(worldX / cellSpan, minorWidth),
        gridLineCoverage(worldZ / cellSpan, minorWidth),
      );
      if (minorCoverage > 0) blendRgbaPixel(pixels, offset, theme.gridMinor, minorCoverage);

      const majorCoverage = Math.max(
        gridLineCoverage(worldX / majorStep, majorWidth),
        gridLineCoverage(worldZ / majorStep, majorWidth),
      );
      if (majorCoverage > 0) blendRgbaPixel(pixels, offset, theme.gridMajor, majorCoverage);

      const centerAxisCoverage = Math.max(
        gridLineCoverage(worldX, axisWidth) * Number(Math.abs(worldX) < 0.15),
        gridLineCoverage(worldZ, axisWidth) * Number(Math.abs(worldZ) < 0.15),
      );
      if (centerAxisCoverage > 0) blendRgbaPixel(pixels, offset, theme.gridAxis, centerAxisCoverage);

      pixels[offset + 3] = Math.round(pixels[offset + 3] * radialFade);
    }
  }

  const image = typeof ImageData === 'function'
    ? new ImageData(pixels, textureSize, textureSize)
    : { width: textureSize, height: textureSize, data: pixels };

  return {
    name: 'Showcase CAD grid',
    geometry: {
      positions: new Float32Array([-radius, height, -radius, -radius, height, radius, radius, height, radius, radius, height, -radius]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    matrix: mat4.create(),
    material: {
      color: [1, 1, 1],
      metallic: 0,
      roughness: 0.95,
      emission: 0,
      tag: 'standard',
      alphaMode: 'blend',
      doubleSided: false,
      map: {
        image,
        colorSpace: 'srgb',
        wrapS: CLAMP_TO_EDGE,
        wrapT: CLAMP_TO_EDGE,
        minFilter: LINEAR_MIPMAP_LINEAR,
        magFilter: LINEAR_FILTER,
      },
    },
  };
}

export function createShowcaseLighting(options = {}) {
  const {
    theme: themeName = 'prototype',
    intensity,
    rotation = 0.35,
    lightDirection = [-3.2, 6.2, 4.4],
    exposure,
  } = options;
  const theme = resolveTheme(themeName);
  const environmentIntensity = intensity ?? theme.environmentIntensity;
  const map = createLightingSetupMap('studio', {
    intensity: environmentIntensity,
    rotation,
    showBackground: false,
  });

  return {
    map,
    exposure: exposure ?? theme.exposure,
    environment: {
      lightDirection: [...lightDirection],
      keyColor: [...theme.keyColor],
      keyIntensity: 1,
      fillIntensity: 0,
      ambientIntensity: 0.45,
      skyTop: [...theme.skyTop],
      skyBottom: [...theme.skyBottom],
      fogDensity: 0,
      environmentIntensity,
      map,
    },
    effects: {
      viewTransform: 'agx',
      saturation: 1.02,
      contrast: 1.03,
      bloom: { strength: 0.08, threshold: 1.25, radius: 0.9 },
      ambientOcclusion: 0.55,
    },
  };
}

export function measurePartsBounds(parts) {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const positions = part?.geometry?.positions;
    const matrix = part?.matrix;
    if (!positions || !matrix) continue;
    const count = positions.length / 3;
    const stride = Math.max(1, Math.floor(count / 2000));
    for (let index = 0; index < count; index += stride) {
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z = positions[index * 3 + 2];
      for (let axis = 0; axis < 3; axis++) {
        const value = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];
        minimum[axis] = Math.min(minimum[axis], value);
        maximum[axis] = Math.max(maximum[axis], value);
      }
    }
  }
  if (!minimum.every(Number.isFinite)) {
    return { minimum: [-0.5, 0, -0.5], maximum: [0.5, 1, 0.5] };
  }
  return { minimum, maximum };
}

export function buildShowcaseViews(bounds, overrides = {}, { aspect = 1.35 } = {}) {
  const target = [0, 1, 2].map(axis => (bounds.minimum[axis] + bounds.maximum[axis]) / 2);
  const size = [0, 1, 2].map(axis => Math.max(0.05, bounds.maximum[axis] - bounds.minimum[axis]));
  const radius = Math.max(0.1, Math.hypot(...size) * 0.5);
  const seedDistance = radius * 2.5;
  const heroView = {
    eye: [
      target[0] + Math.sin(0.62) * Math.cos(0.42) * seedDistance,
      target[1] + Math.sin(0.42) * seedDistance,
      target[2] + Math.cos(0.62) * Math.cos(0.42) * seedDistance,
    ],
    target,
    fov: 45,
    near: Math.max(0.01, radius * 0.01),
    far: Math.max(20, radius * 40),
  };
  const fitAspect = Math.max(0.42, Math.min(1.35, aspect));
  const distance = Math.max(radius * 2.5, fitPerspectiveDistance(bounds, heroView, fitAspect, 1.58));
  const presets = {
    hero: { label: 'Hero', yaw: 0.62, pitch: 0.42, distance, target: [...target] },
    front: { label: 'Front', yaw: 0, pitch: 0.14, distance: distance * 0.98, target: [...target] },
    side: { label: 'Side', yaw: Math.PI / 2, pitch: 0.14, distance: distance * 0.98, target: [...target] },
    top: { label: 'Top', yaw: 0.01, pitch: 1.48, distance: distance * 1.05, target: [...target] },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (presets[key]) presets[key] = { ...presets[key], ...value };
    else presets[key] = value;
  }
  return { presets, target, radius, distance };
}

export function buildCrucibleMarkSvg(size = 16) {
  const paths = CRUCIBLE_MARK_LAYERS
    .map(([layer, definition]) => `<path fill="${MARK_LAYER_COLORS[layer] ?? '#2a282d'}" d="${definition}"/>`)
    .join('');
  return `<svg width="${size}" height="${size}" viewBox="${CRUCIBLE_MARK_VIEW_BOX}" aria-hidden="true">${paths}</svg>`;
}

const VIEW_ICONS = Object.freeze({
  hero: '<path d="M12 3 4 7.5 12 12l8-4.5L12 3Zm-8 9 8 4.5 8-4.5M4 16.5 12 21l8-4.5"/>',
  front: '<rect x="5" y="5" width="14" height="14" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  side: '<path d="M5 6h9l5 6-5 6H5V6Z"/>',
  top: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  reset: '<path d="M4 11a8 8 0 1 1 2.3 5.7M4 6v5h5"/>',
  theme: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M3 12h2M19 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  action: '<path d="M6 12h12M13 7l5 5-5 5"/>',
});

function actionIconSvg(iconName = 'action') {
  const body = VIEW_ICONS[iconName] ?? VIEW_ICONS.action;
  return `<svg class="cs-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const SHOWCASE_STYLE_ID = 'crucible-showcase-viewer-style';
const SHOWCASE_STYLES = `
.cs-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
  overflow: hidden;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  color: var(--cs-text);
  background: var(--cs-bg-gradient);
}
.cs-canvas {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
  touch-action: none;
}
.cs-chrome {
  user-select: none;
  -webkit-user-select: none;
}
.cs-top-left,
.cs-top-right,
.cs-dock,
.cs-attribution {
  position: absolute;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cs-top-left {
  top: 16px;
  left: 16px;
  flex-wrap: wrap;
  max-width: calc(100% - 340px);
}
.cs-top-right {
  top: 16px;
  right: 16px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.cs-dock {
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid var(--cs-border);
  background: var(--cs-surface);
  backdrop-filter: blur(12px);
  max-width: calc(100% - 32px);
  flex-wrap: wrap;
  justify-content: center;
}
.cs-attribution {
  right: 16px;
  bottom: 18px;
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--cs-border);
  background: var(--cs-surface);
  backdrop-filter: blur(12px);
  color: var(--cs-text);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
}
.cs-attribution:hover {
  background: var(--cs-surface-hover);
}
.cs-title {
  margin: 0;
  padding: 7px 13px;
  border-radius: 999px;
  border: 1px solid var(--cs-border);
  background: var(--cs-surface);
  backdrop-filter: blur(12px);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}
.cs-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--cs-border);
  background: var(--cs-surface);
  backdrop-filter: blur(12px);
  color: var(--cs-text);
  font: 500 12.5px/1 Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
  cursor: pointer;
  white-space: nowrap;
}
.cs-btn:hover {
  background: var(--cs-surface-hover);
}
.cs-btn[aria-pressed="true"] {
  background: var(--cs-accent);
  border-color: var(--cs-accent);
  color: var(--cs-accent-text);
}
.cs-btn:focus-visible,
.cs-attribution:focus-visible,
.cs-range:focus-visible,
.cs-canvas:focus-visible {
  outline: 2px solid var(--cs-accent);
  outline-offset: 2px;
}
.cs-slider-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: 12.5px;
  font-weight: 500;
}
.cs-range {
  width: 108px;
  accent-color: var(--cs-accent);
  cursor: pointer;
}
.cs-value {
  min-width: 34px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--cs-muted);
}
.cs-status {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 10px 16px;
  border-radius: 12px;
  border: 1px solid var(--cs-border);
  background: var(--cs-surface);
  font-size: 13px;
  z-index: 3;
}
@media (max-width: 720px) {
  .cs-top-left {
    top: 12px;
    left: 12px;
    max-width: calc(100% - 24px);
  }
  .cs-top-right {
    top: 54px;
    left: 12px;
    right: 12px;
    justify-content: flex-start;
  }
  .cs-dock {
    bottom: 56px;
    border-radius: 16px;
    padding: 8px 12px;
  }
  .cs-attribution {
    right: 12px;
    bottom: 12px;
  }
}
`;

function ensureShowcaseStyles(doc) {
  if (!doc || doc.getElementById(SHOWCASE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = SHOWCASE_STYLE_ID;
  style.textContent = SHOWCASE_STYLES;
  doc.head?.append(style);
}

function applyThemeTokens(shell, theme) {
  shell.dataset.theme = theme.id;
  shell.style.setProperty('--cs-bg', theme.background);
  shell.style.setProperty('--cs-bg-gradient', theme.backgroundGradient);
  shell.style.setProperty('--cs-surface', theme.surface);
  shell.style.setProperty('--cs-surface-hover', theme.surfaceHover);
  shell.style.setProperty('--cs-border', theme.border);
  shell.style.setProperty('--cs-text', theme.text);
  shell.style.setProperty('--cs-muted', theme.muted);
  shell.style.setProperty('--cs-accent', theme.accent);
  shell.style.setProperty('--cs-accent-text', theme.accentText);
}

async function resolveShowcaseInput(options) {
  if (Array.isArray(options.parts)) {
    return {
      parts: options.parts,
      environment: options.environment ?? null,
      dispose: () => {},
    };
  }
  if (options.modelUrl) {
    const asset = await loadGltf(options.modelUrl, {
      maxBytes: 64 * 1024 * 1024,
      maxTexturePixels: 16_777_216,
      ...(options.gltfOptions ?? {}),
    });
    return {
      parts: asset.parts,
      environment: asset.lights ?? null,
      dispose: () => asset.dispose(),
    };
  }
  if (options.recipe) {
    await loadAllAgentSceneModules();
    const handle = createAgentScene(options.recipe);
    const frame = handle.frame();
    const map = frame.environment ? agentEnvironmentMap(frame.environment) : null;
    return {
      parts: handle.parts(),
      environment: frame.environment ? { ...frame.environment, map } : null,
      dispose: () => handle.dispose?.(),
    };
  }
  throw new Error('createShowcaseViewer requires parts, modelUrl, or recipe.');
}

export async function createShowcaseViewer(options = {}) {
  const {
    container,
    title = 'Product showcase',
    initialView = 'hero',
    views: viewOverrides = {},
    theme: initialTheme = 'prototype',
    actions = [],
    onFrame = null,
    onThemeChange = null,
    showGrid = true,
    gridRadius,
    floorHeight,
    pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2),
    samples = 4,
  } = options;

  if (!container) throw new TypeError('createShowcaseViewer requires a DOM container element.');
  const doc = container.ownerDocument;
  ensureShowcaseStyles(doc);

  let currentTheme = resolveTheme(initialTheme);
  let activeView = initialView;
  let renderer = null;
  let scheduledFrame = 0;
  let lastTimestamp = 0;
  let renderingFrame = false;
  let disposed = false;

  const shell = doc.createElement('section');
  shell.className = 'cs-shell';
  shell.setAttribute('aria-label', `${title} 3D showcase`);
  applyThemeTokens(shell, currentTheme);

  const canvas = doc.createElement('canvas');
  canvas.className = 'cs-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', `${title} interactive 3D viewport`);

  const status = doc.createElement('div');
  status.className = 'cs-chrome cs-status';
  status.textContent = 'Loading model…';

  const topLeft = doc.createElement('div');
  topLeft.className = 'cs-chrome cs-top-left';
  const heading = doc.createElement('h1');
  heading.className = 'cs-title';
  heading.textContent = title;
  const themeButton = doc.createElement('button');
  themeButton.type = 'button';
  themeButton.className = 'cs-btn';
  themeButton.innerHTML = `${actionIconSvg('theme')}<span class="cs-theme-label">${currentTheme.label}</span>`;
  topLeft.append(heading, themeButton);

  const topRight = doc.createElement('div');
  topRight.className = 'cs-chrome cs-top-right';

  const dock = doc.createElement('div');
  dock.className = 'cs-chrome cs-dock';
  dock.hidden = actions.length === 0;

  const attribution = doc.createElement('a');
  attribution.className = 'cs-chrome cs-attribution';
  attribution.href = 'https://crucible.codepawl.com';
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  attribution.innerHTML = `${buildCrucibleMarkSvg(15)}<span>Built with Crucible</span>`;

  shell.append(canvas, status, topLeft, topRight, dock, attribution);
  container.replaceChildren(shell);

  let loaded = null;
  let subjectParts = [];
  let bounds = null;
  let floorRadius = gridRadius ?? 6;
  let baseHeight = floorHeight ?? 0;
  let lighting = null;
  let floorPart = null;

  try {
    loaded = await resolveShowcaseInput(options);
    subjectParts = loaded.parts;
    bounds = measurePartsBounds(subjectParts);
    const canvasAspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1.35;
    let viewSetup = buildShowcaseViews(bounds, viewOverrides, { aspect: canvasAspect });
    const { presets, radius, target } = viewSetup;
    floorRadius = gridRadius ?? Math.max(4, radius * 5.2);
    baseHeight = floorHeight ?? bounds.minimum[1] - 0.002;
    const homePreset = presets[initialView] ?? presets.hero;

    const orbitController = createOrbitController({
      ...homePreset,
      minPitch: -0.25,
      maxPitch: 1.52,
      minDistance: Math.max(0.15, radius * 0.65),
      maxDistance: Math.max(8, radius * 14),
      boundsMin: target.map(value => value - radius * 3.5),
      boundsMax: target.map(value => value + radius * 3.5),
    });

    await loadViewTransformForRendererOptions({ viewTransform: 'agx' });

    function buildSceneRenderer() {
      lighting = createShowcaseLighting({ theme: currentTheme.id });
      const resolvedEnvironment = loaded.environment
        ? { ...lighting.environment, ...loaded.environment, map: loaded.environment.map ?? lighting.map, fogDensity: 0 }
        : lighting.environment;
      floorPart = showGrid ? createCadGridFloor({ radius: floorRadius, height: baseHeight, theme: currentTheme.id }) : null;
      const renderParts = floorPart ? [...subjectParts, floorPart] : [...subjectParts];
      const maxExtent = Math.max(radius * 2.4, floorRadius * 0.45);
      renderer?.dispose();
      renderer = new CrucibleRenderer(canvas, renderParts, {
        ground: false,
        hdr: true,
        compactColor: false,
        world: false,
        transparent: true,
        viewTransform: 'agx',
        samples,
        pixelRatio,
        environment: resolvedEnvironment,
        shadowBounds: {
          target: [...target],
          eye: [target[0] - maxExtent, target[1] + maxExtent * 2.1, target[2] + maxExtent],
          extent: maxExtent * 1.3,
          near: maxExtent * 0.01,
          far: maxExtent * 8,
        },
      });
    }

    function renderFrame(deltaSeconds = 0.016) {
      if (!renderer || disposed) return false;
      const pose = orbitController.step(deltaSeconds);
      renderingFrame = true;
      let animationActive = false;
      try {
        animationActive = onFrame ? Boolean(onFrame(deltaSeconds, { renderer, parts: subjectParts, viewer })) : false;
      } finally {
        renderingFrame = false;
      }
      renderer.render({
        eye: pose.eye,
        target: pose.target,
        exposure: lighting.exposure,
        effects: lighting.effects,
      });
      return pose.active || animationActive;
    }

    function requestDraw() {
      if (disposed || scheduledFrame) return;
      scheduledFrame = globalThis.requestAnimationFrame(timestamp => {
        scheduledFrame = 0;
        if (disposed) return;
        const deltaSeconds = lastTimestamp ? Math.min(0.05, Math.max(0.001, (timestamp - lastTimestamp) / 1000)) : 0.016;
        lastTimestamp = timestamp;
        const keepRunning = renderFrame(deltaSeconds);
        if (keepRunning) requestDraw();
      });
    }

    const viewButtons = new Map();
    for (const [key, preset] of Object.entries(presets)) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'cs-btn';
      button.dataset.view = key;
      button.setAttribute('aria-pressed', String(key === activeView));
      button.innerHTML = `${actionIconSvg(key)}<span>${preset.label ?? key}</span>`;
      button.addEventListener('click', () => setView(key));
      viewButtons.set(key, button);
      topRight.append(button);
    }

    const resetButton = doc.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'cs-btn';
    resetButton.dataset.action = 'reset';
    resetButton.innerHTML = `${actionIconSvg('reset')}<span>Reset</span>`;
    resetButton.addEventListener('click', () => resetView());
    topRight.append(resetButton);

    for (const action of actions) {
      if (action.type === 'range') {
        const group = doc.createElement('label');
        group.className = 'cs-slider-group';
        const caption = doc.createElement('span');
        caption.textContent = action.label;
        const input = doc.createElement('input');
        input.type = 'range';
        input.className = 'cs-range';
        input.min = String(action.min ?? 0);
        input.max = String(action.max ?? 1);
        input.step = String(action.step ?? 0.01);
        input.value = String(action.value ?? 0);
        input.dataset.action = action.id;
        const readout = doc.createElement('span');
        readout.className = 'cs-value';
        const formatValue = action.formatValue ?? (value => `${Math.round(Number(value) * 100)}%`);
        readout.textContent = formatValue(input.value);
        input.addEventListener('input', () => {
          const numeric = Number(input.value);
          readout.textContent = formatValue(numeric);
          action.onChange?.(numeric, viewer);
          requestDraw();
        });
        group.append(caption, input, readout);
        dock.append(group);
      } else {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'cs-btn';
        button.dataset.action = action.id;
        button.setAttribute('aria-pressed', String(Boolean(action.active)));
        button.innerHTML = `${actionIconSvg(action.icon ?? 'action')}<span>${action.label}</span>`;
        button.addEventListener('click', () => {
          const next = button.getAttribute('aria-pressed') !== 'true';
          button.setAttribute('aria-pressed', String(next));
          action.onChange?.(next, viewer, button);
          requestDraw();
        });
        dock.append(button);
      }
    }

    function markActiveView(viewName) {
      activeView = viewName;
      for (const [key, button] of viewButtons.entries()) {
        button.setAttribute('aria-pressed', String(key === viewName));
      }
    }

    function setView(viewName, { immediate = false } = {}) {
      const preset = presets[viewName];
      if (!preset) return;
      const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      orbitController.setPreset(preset, { immediate: immediate || reducedMotion });
      markActiveView(viewName);
      requestDraw();
    }

    function resetView({ immediate = false } = {}) {
      const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      orbitController.reset({ immediate: immediate || reducedMotion });
      markActiveView(initialView);
      requestDraw();
    }

    function setTheme(themeName) {
      currentTheme = resolveTheme(themeName);
      applyThemeTokens(shell, currentTheme);
      themeButton.querySelector('.cs-theme-label').textContent = currentTheme.label;
      buildSceneRenderer();
      onThemeChange?.(currentTheme.id, viewer);
      requestDraw();
    }

    function updateParts(nextParts) {
      subjectParts = nextParts;
      const combined = floorPart ? [...subjectParts, floorPart] : [...subjectParts];
      renderer?.updateParts(combined);
      if (!renderingFrame) requestDraw();
    }

    themeButton.addEventListener('click', () => {
      setTheme(currentTheme.id === 'prototype' ? 'studio' : 'prototype');
    });

    const detachControls = attachOrbitControls(canvas, orbitController, {
      keyTarget: canvas,
      onInteract: kind => {
        if (kind === 'reset') markActiveView(initialView);
        else markActiveView(null);
      },
      onChange: () => requestDraw(),
    });

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          renderer?.resize();
          if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
            const nextSetup = buildShowcaseViews(bounds, viewOverrides, { aspect: canvas.clientWidth / canvas.clientHeight });
            Object.assign(presets, nextSetup.presets);
            const refreshedHome = presets[initialView] ?? presets.hero;
            orbitController.setHome(refreshedHome, { apply: activeView !== null, immediate: true });
          }
          requestDraw();
        })
      : null;
    resizeObserver?.observe(canvas);

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (scheduledFrame) globalThis.cancelAnimationFrame?.(scheduledFrame);
      resizeObserver?.disconnect();
      detachControls.dispose();
      renderer?.dispose();
      loaded.dispose();
      renderer = null;
    }

    const viewer = {
      canvas,
      shell,
      orbitController,
      get renderer() { return renderer; },
      getState: () => ({
        theme: currentTheme.id,
        view: activeView,
        orbit: orbitController.state(),
      }),
      setTheme,
      setView,
      resetView,
      updateParts,
      renderFrame,
      requestDraw,
      dispose,
    };

    buildSceneRenderer();
    status.hidden = true;
    renderFrame(0);
    requestDraw();
    return viewer;
  } catch (error) {
    status.textContent = `Could not load showcase: ${error.message}`;
    loaded?.dispose();
    throw error;
  }
}
