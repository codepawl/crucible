// How the Studio page hands over from its loading state to the app. The page paints the theme background and the loading
// element from its HTML alone (bench/studio/index.html); this module takes the loading element away once Studio has drawn
// its first frame, opens the first-run setup over that frame, and turns the element into an error when the boot fails.
// Nothing here is imported by Studio itself, so no Studio bundle carries it.

export const STUDIO_LOADING_ELEMENT_ID = 'studio-loading';

const LOADING_MESSAGE_SELECTOR = '[data-loading-message]';
const PROGRESS_PROPERTY = '--progress';
const FILL_SELECTOR = '.fill';
const WIND_DOWN_LIMIT_MILLISECONDS = 1200;
const FILL_EASE_MILLISECONDS = 30000;
const FILL_DRIFT_MILLISECONDS = 120000;
const FILL_EASE_EASING = 'cubic-bezier(0.1, 0.5, 0.2, 1)';
const FILL_EASE_SHARE = 0.85;
const FILL_DRIFT_SHARE = 0.97;
const FILL_COMPLETE_MILLISECONDS = 90;
const FILL_COMPLETE_REDUCED_MOTION_MILLISECONDS = 200;
const FILL_LANDED_SCALE = 0.04;
const STREAM_LANDING_MILLISECONDS = 800;
const STREAM_SELECTOR = '.stream';
const FILL_COMPLETE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Where the fill of the loading bar stands (0 to 1) once the page script reaches each step. The page's CSS starts a slow creep
 * toward 0.3 at first paint. At each step the fill eases, over thirty seconds with a strong ease-out, toward a point
 * 85 percent of the way to the next step, then drifts on, linearly over two more minutes, to 97 percent of the way. It keeps
 * moving while the load waits and never arrives early. It reaches 1 only when Studio is ready.
 */
export const STUDIO_LOADING_MILESTONES = Object.freeze({
  modulesLoaded: 0.35,
  sceneModulesLoaded: 0.55,
  studioCreated: 0.75,
  sceneFileLoaded: 0.9,
});

const HIGHEST_VALUE_BEFORE_READY = 0.97;

function pointShortOfNextStep(value, share) {
  const nextStep = Object.values(STUDIO_LOADING_MILESTONES).find(milestone => milestone > value) ?? 1;
  return Math.min(value + (nextStep - value) * share, HIGHEST_VALUE_BEFORE_READY);
}

/** Where the strong ease-out ends while the load waits for the step after the one at `value`: short of that step, never full. */
export function creepTargetAfter(value) {
  return pointShortOfNextStep(value, FILL_EASE_SHARE);
}

/** Where the slow drift after the ease ends: still short of the next step and of full. */
export function driftTargetAfter(value) {
  return pointShortOfNextStep(value, FILL_DRIFT_SHARE);
}

function currentFillScale(fillElement) {
  const transform = fillElement.ownerDocument.defaultView.getComputedStyle(fillElement).transform;
  const scale = /^matrix[(]([-\d.e]+)/.exec(transform);
  return scale ? Number(scale[1]) : 0;
}

const runningFillAnimations = new WeakMap();

/** Runs the fill through the stops, each a scale, from where it stands now. A new run replaces the one before it and never goes backward. */
function animateFill(loadingElement, stops, options) {
  const fillElement = loadingElement.querySelector(FILL_SELECTOR);
  if (!fillElement?.animate) {
    return;
  }
  const start = Math.max(currentFillScale(fillElement), FILL_LANDED_SCALE);
  const keyframes = [{ scale: start, ...stops[0] }, ...stops.slice(1)].map(({ scale, ...keyframe }) => ({
    ...keyframe,
    transform: `scaleX(${Math.max(scale, start)})`,
  }));
  const animation = fillElement.animate(keyframes, { fill: 'forwards', ...options });
  runningFillAnimations.get(fillElement)?.cancel();
  runningFillAnimations.set(fillElement, animation);
}

/**
 * Moves the fill forward to the step. It never moves back and never reaches full: only the wind-down does. The value goes on
 * the loading element as --progress (the resting size of the fill), and a long ease starts toward the next step.
 */
export function reportStudioLoadingProgress(documentReference, value) {
  const loadingElement = documentReference.getElementById(STUDIO_LOADING_ELEMENT_ID);
  if (!loadingElement?.style) {
    return;
  }
  const current = Number(loadingElement.style.getPropertyValue(PROGRESS_PROPERTY)) || 0;
  const reached = Math.min(Math.max(value, current), HIGHEST_VALUE_BEFORE_READY);
  loadingElement.style.setProperty(PROGRESS_PROPERTY, String(reached));
  const easeShare = FILL_EASE_MILLISECONDS / (FILL_EASE_MILLISECONDS + FILL_DRIFT_MILLISECONDS);
  animateFill(
    loadingElement,
    [{ easing: FILL_EASE_EASING }, { scale: creepTargetAfter(reached), offset: easeShare, easing: 'linear' }, { scale: driftTargetAfter(reached) }],
    { duration: FILL_EASE_MILLISECONDS + FILL_DRIFT_MILLISECONDS },
  );
}

/**
 * Moves the fill from the step after the script (0.35) toward the step after the scene modules (0.55) as each of the modules
 * arrives, so a slow load shows the bar moving in as many steps as there are modules, not in one jump when the last one lands.
 */
export function reportStudioModulesLoaded(documentReference, loaded, total) {
  const from = STUDIO_LOADING_MILESTONES.modulesLoaded;
  const to = STUDIO_LOADING_MILESTONES.sceneModulesLoaded;
  reportStudioLoadingProgress(documentReference, from + (to - from) * (Math.min(loaded, total) / total));
}

/** Fills the bar, while the stream still pours into it. */
function completeStudioLoadingProgress(loadingElement) {
  loadingElement.style?.setProperty(PROGRESS_PROPERTY, '1');
  const reducedMotion = loadingElement.ownerDocument?.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const duration = reducedMotion ? FILL_COMPLETE_REDUCED_MOTION_MILLISECONDS : FILL_COMPLETE_MILLISECONDS;
  animateFill(loadingElement, [{}, { scale: 1 }], { duration, easing: FILL_COMPLETE_EASING });
}

/**
 * Resolves once the stream has reached the bar. The fill stays hidden until then (the page's CSS), so a load that is ready sooner
 * waits here and the bar never fills with nothing pouring into it.
 */
export function waitForStreamLanding(documentReference) {
  const stream = documentReference.getElementById(STUDIO_LOADING_ELEMENT_ID)?.querySelector?.(STREAM_SELECTOR);
  const pouring = stream?.getAnimations?.().find(animation => animation.animationName === 'studio-stream-in');
  const remaining = pouring ? STREAM_LANDING_MILLISECONDS - Number(pouring.currentTime) : 0;
  return remaining > 0 ? new Promise(resolve => setTimeout(resolve, remaining)) : Promise.resolve();
}

/**
 * Studio is ready: the loading state stops taking input, the bar fills while the stream still pours (90 ms), the stream shortens
 * into the lip and the sparks stop (80 ms), the pot rights itself (100 ms), then the loading state fades out (100 ms), 370 ms in
 * all (300 ms with reduced motion, where only the fill and the fade move). All of it starts now; the returned promise resolves when those animations end.
 */
export function windDownStudioLoading(documentReference) {
  const loadingElement = documentReference.getElementById(STUDIO_LOADING_ELEMENT_ID);
  if (!loadingElement) {
    return Promise.resolve();
  }
  completeStudioLoadingProgress(loadingElement);
  loadingElement.dataset.state = 'done';
  const finishingAnimations = (loadingElement.getAnimations?.({ subtree: true }) ?? []).filter(
    animation => animation.effect.getComputedTiming().endTime <= WIND_DOWN_LIMIT_MILLISECONDS,
  );
  const limit = new Promise(resolve => setTimeout(resolve, WIND_DOWN_LIMIT_MILLISECONDS));
  return Promise.race([Promise.allSettled(finishingAnimations.map(animation => animation.finished)), limit]);
}

/** Resolves after the browser has painted one frame of whatever is on the page now. */
export function waitForNextPaint(requestFrame) {
  return new Promise(resolve => {
    requestFrame(() => requestFrame(() => resolve()));
  });
}

/** Removes the loading element and the boot theme the page's own script set on the root element. */
export function removeStudioLoading(documentReference) {
  documentReference.getElementById(STUDIO_LOADING_ELEMENT_ID)?.remove();
  documentReference.documentElement.removeAttribute('data-theme');
}

/** Shows the failure in place of the progress bar. The message is text, never markup. */
export function showStudioLoadingFailure(documentReference, error) {
  const loadingElement = documentReference.getElementById(STUDIO_LOADING_ELEMENT_ID);
  if (!loadingElement) {
    return;
  }
  loadingElement.dataset.state = 'error';
  const messageElement = loadingElement.querySelector(LOADING_MESSAGE_SELECTOR);
  if (messageElement) {
    messageElement.textContent = error?.message ?? String(error);
  }
}

/**
 * Waits for Studio to be ready and for its first frame to be on screen, then winds the pour down, takes the loading state away and, on a first
 * visit, opens the setup over the drawn app. `?setup=off` never opens it.
 */
export async function revealStudio({ studio, setupParameter, documentReference, requestFrame }) {
  await studio.ready;
  await waitForStreamLanding(documentReference);
  const windDown = windDownStudioLoading(documentReference);
  await waitForNextPaint(requestFrame);
  await windDown;
  removeStudioLoading(documentReference);
  if (setupParameter !== 'off' && !studio.setupDone) {
    studio.openSetup();
  }
}
