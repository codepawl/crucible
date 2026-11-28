// The Looks gallery of the Look tab: the open scene drawn under each colour look as a small picture, so a person skims them and
// picks one. The pictures come from a second, small renderer and are made one at a time between frames, never inside an edit, and
// are kept until the scene changes. Picking one is one undo step through the same controller call as the Color look menu.
import { agentEnvironmentMap, fitAgentShadow, resolveAgentShadow } from './agent-look.js';
import { loadAgentSceneModules } from './agent-scene.js';
import { studioFloorHeight } from './renderer.js';
import { createPartSyncTracker } from './studio-live-parts.js';
import './studio-look-gallery-styles.js';
import { choiceDisplayLabel } from './studio-properties.js';
import { hasStudioTab, registerStudioTab } from './studio-registry.js';
import { studioDrawsFloor, viewportFloorPart } from './studio-viewport-aids.js';
import { LOOK_NAMES, VIEW_TRANSFORM_NAMES } from './view-transform-names.js';

export const LOOK_PREVIEW_WIDTH = 256;
export const LOOK_PREVIEW_HEIGHT = 160;
// A burst of edits (a drag, a slider) settles before any picture is made; the pictures then follow one per step.
const REFRESH_DELAY_MILLISECONDS = 300;
const STEP_DELAY_MILLISECONDS = 16;
// The small renderer is released once its round is done, after a pause that lets the next edit reuse it.
const RENDERER_RELEASE_MILLISECONDS = 10000;
const PREVIEW_SAMPLES = 4;
const LOOKS_TAB_ID = 'looks';

/** The looks the gallery offers: each display transform plain, and each built-in look over the default transform. */
export const STUDIO_LOOK_PRESETS = Object.freeze([
  ...VIEW_TRANSFORM_NAMES.map(name => Object.freeze({ id: name, label: choiceDisplayLabel(name), viewTransform: name, look: null })),
  ...LOOK_NAMES.map(name => Object.freeze({ id: name, label: choiceDisplayLabel(name), viewTransform: 'aces', look: name })),
]);

/** The preset the environment shows right now, or null when it is a mix the gallery does not list. */
export function activeLookPresetId(environment = {}) {
  const viewTransform = environment.viewTransform ?? 'aces';
  const look = environment.look ?? null;
  return STUDIO_LOOK_PRESETS.find(preset => preset.viewTransform === viewTransform && preset.look === look)?.id ?? null;
}

/** The frame environment of one look: the scene's own environment with only the transform and the look replaced. */
export function environmentUnderLook(environment, preset) {
  const withLook = { ...environment, viewTransform: preset.viewTransform, look: preset.look ?? undefined };
  return { ...withLook, map: agentEnvironmentMap(withLook) };
}

function sceneNeedsDepth(environment) {
  return Boolean(environment.volumeFog?.density > 0 || environment.localVolumes?.length);
}

/**
 * Builds the gallery. `createPreviewRenderer(canvas, parts, options)` makes the small renderer (Studio passes its own factory),
 * `prepareLook(patch)` loads what a look needs before it is applied, `isVisible()` says whether the Look tab is in view, and
 * `schedule` and `cancel` stand for setTimeout and clearTimeout so a test can step the work by hand.
 */
export function createLookGallery({
  documentReference,
  createElement,
  controller,
  announce = () => {},
  announceError = announce,
  createPreviewRenderer,
  prepareLook = patch => loadAgentSceneModules(patch),
  isVisible = () => true,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = handle => clearTimeout(handle),
}) {
  if (typeof createPreviewRenderer !== 'function') {
    throw new TypeError('createLookGallery needs createPreviewRenderer(canvas, parts, options), a function that builds the small renderer.');
  }
  const pictures = new Map();
  const partSync = createPartSyncTracker();
  let pictureScene = null;
  let pictureRevision = null;
  let previewRenderer = null;
  let rendererGround = null;
  let batchCamera = null;
  let unavailable = false;
  let timer = null;
  let releaseTimer = null;
  let disposed = false;
  // The controller tells the panels about the change while updateLook runs, before the gallery knows the change is its own.
  let applyingOwnLook = false;

  const previewCanvas = createElement(documentReference, 'canvas', { className: 'crucible-studio-look-canvas', attributes: { 'aria-hidden': 'true' } });
  const cards = STUDIO_LOOK_PRESETS.map(preset => {
    const image = createElement(documentReference, 'img', { alt: '', width: LOOK_PREVIEW_WIDTH, height: LOOK_PREVIEW_HEIGHT, attributes: { decoding: 'async' }, hidden: true });
    const card = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-look-card', dataset: { look: preset.id }, attributes: { 'aria-pressed': 'false', 'aria-label': `${preset.label} look` } },
      createElement(documentReference, 'span', { className: 'crucible-studio-look-thumb' }, image),
      createElement(documentReference, 'span', { className: 'crucible-studio-look-name', textContent: preset.label }),
    );
    card.addEventListener('click', () => applyPreset(preset));
    return { preset, card, image };
  });
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-look-gallery' },
    createElement(documentReference, 'div', { className: 'crucible-studio-look-grid', attributes: { role: 'group', 'aria-label': 'Looks' } }, ...cards.map(({ card }) => card)),
    previewCanvas,
  );

  const sceneRevision = () => `${controller.scene.topologyRevision}|${controller.scene.revision}`;
  const picturesAreCurrent = () => pictureScene === controller.scene && pictureRevision === sceneRevision();

  function forgetPictures() {
    pictures.clear();
    unavailable = false;
    batchCamera = null;
    // The old pictures stay on show until each is replaced, so an edit never blanks the gallery.
    pictureScene = controller.scene;
    pictureRevision = sceneRevision();
  }

  function markActive() {
    const activeId = activeLookPresetId(controller.scene.environment);
    for (const { preset, card } of cards) {
      card.setAttribute('aria-pressed', preset.id === activeId ? 'true' : 'false');
    }
  }

  async function applyPreset(preset) {
    try {
      await prepareLook({ environment: { viewTransform: preset.viewTransform, look: preset.look } });
      // The other pictures hold their own look in every frame, so picking one does not change them; only an edit to the scene does.
      const wasCurrent = picturesAreCurrent();
      applyingOwnLook = true;
      try {
        controller.updateLook({ environment: { viewTransform: preset.viewTransform, look: preset.look } });
      } finally {
        applyingOwnLook = false;
      }
      if (wasCurrent) {
        pictureScene = controller.scene;
        pictureRevision = sceneRevision();
      }
      markActive();
      announce(`${preset.label} look`);
    } catch (error) {
      announceError(error.message);
    }
  }

  function dropPreviewRenderer() {
    previewRenderer?.dispose?.();
    previewRenderer = null;
    rendererGround = null;
  }

  // The renderer takes its floor and depth at construction, so a scene that wants a different one gets a new renderer.
  function ensurePreviewRenderer(scene) {
    const ground = `${studioDrawsFloor(scene.parts, scene.environment)}|${studioFloorHeight(scene.parts)}|${sceneNeedsDepth(scene.environment)}`;
    if (previewRenderer && rendererGround !== ground) dropPreviewRenderer();
    if (previewRenderer) return previewRenderer;
    const environment = scene.environment;
    previewRenderer = createPreviewRenderer(previewCanvas, scene.parts, {
      hdr: true,
      depth: sceneNeedsDepth(environment),
      world: environment.world,
      environment: { ...environment, map: agentEnvironmentMap(environment) },
      shadowBounds: resolveAgentShadow(fitAgentShadow(scene.shadow, scene.parts), environment.lightDirection),
      pixelRatio: 1,
      samples: PREVIEW_SAMPLES,
      ground: studioDrawsFloor(scene.parts, environment) && viewportFloorPart(studioFloorHeight(scene.parts)),
    });
    rendererGround = ground;
    partSync.reset(scene, String(scene.topologyRevision));
    return previewRenderer;
  }

  function syncPreviewParts(scene) {
    const topology = String(scene.topologyRevision);
    const revisionKey = `${controller.motionTime}|${scene.motionTime}`;
    if (partSync.needsReplace(scene, topology)) partSync.replace(previewRenderer, scene, topology, revisionKey, scene.parts);
    else partSync.update(previewRenderer, revisionKey, scene.parts);
  }

  function drawPicture(preset) {
    const scene = controller.scene;
    const activeRenderer = ensurePreviewRenderer(scene);
    syncPreviewParts(scene);
    if (!batchCamera) {
      // One framing for the whole round, so the looks compare on the same picture.
      batchCamera = { ...controller.viewCamera };
      activeRenderer.shadowBounds = resolveAgentShadow(fitAgentShadow(scene.shadow, scene.parts), scene.environment.lightDirection);
      activeRenderer.shadowsDirty = true;
    }
    const frameEnvironment = environmentUnderLook(scene.environment, preset);
    activeRenderer.world = scene.environment.world;
    activeRenderer.environment = frameEnvironment;
    activeRenderer.resize();
    activeRenderer.render({
      ...batchCamera,
      environment: frameEnvironment,
      effects: scene.effects,
      exposure: scene.effects.exposure,
      time: controller.motionTime,
      lines: scene.environment.lines,
    });
    return previewCanvas.toDataURL('image/webp', 0.85);
  }

  function showPicture(presetId) {
    const card = cards.find(candidate => candidate.preset.id === presetId);
    card.image.src = pictures.get(presetId);
    card.image.hidden = false;
  }

  function drawNextPicture() {
    timer = null;
    if (disposed || unavailable || !isVisible()) return;
    if (!picturesAreCurrent()) forgetPictures();
    const next = STUDIO_LOOK_PRESETS.find(preset => !pictures.has(preset.id));
    if (!next) return;
    cancel(releaseTimer);
    try {
      pictures.set(next.id, drawPicture(next));
      showPicture(next.id);
    } catch {
      // A scene the small renderer cannot draw keeps its empty slots; the look controls still work.
      unavailable = true;
      dropPreviewRenderer();
      return;
    }
    timer = pictures.size < STUDIO_LOOK_PRESETS.length
      ? schedule(drawNextPicture, STEP_DELAY_MILLISECONDS)
      : null;
    if (timer === null) releaseTimer = schedule(dropPreviewRenderer, RENDERER_RELEASE_MILLISECONDS);
  }

  function queueDrawing() {
    if (timer !== null || disposed || unavailable || !isVisible()) return;
    const waiting = !picturesAreCurrent() || pictures.size < STUDIO_LOOK_PRESETS.length;
    if (waiting) timer = schedule(drawNextPicture, REFRESH_DELAY_MILLISECONDS);
  }

  return {
    element,
    /** Marks the active look and, when the scene changed since the pictures were made, makes them again in the background. */
    sync() {
      markActive();
      if (applyingOwnLook) return;
      if (!picturesAreCurrent()) {
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        forgetPictures();
      }
      queueDrawing();
    },
    dispose() {
      disposed = true;
      if (timer !== null) cancel(timer);
      cancel(releaseTimer);
      timer = null;
      dropPreviewRenderer();
    },
  };
}

if (!hasStudioTab(LOOKS_TAB_ID)) {
  registerStudioTab({
    id: LOOKS_TAB_ID,
    label: 'Looks',
    order: 20,
    bodyClassName: 'crucible-studio-panel-body',
    workspaces: ['look'],
    createPanel: ({ documentReference, controller, announce, announceError, builders, createRenderer }) => {
      const gallery = createLookGallery({
        documentReference,
        createElement: builders.createElement,
        controller,
        announce,
        announceError,
        createPreviewRenderer: createRenderer,
        isVisible: () => controller.activeTab === LOOKS_TAB_ID,
      });
      return { element: gallery.element, sync: gallery.sync, dispose: gallery.dispose };
    },
  });
}
