// How the Studio page hands over from its loading state to the app. The page paints the theme background and the loading
// element from its HTML alone (bench/studio/index.html); this module takes the loading element away once Studio has drawn
// its first frame, opens the first-run setup over that frame, and turns the element into an error when the boot fails.
// Nothing here is imported by Studio itself, so no Studio bundle carries it.

export const STUDIO_LOADING_ELEMENT_ID = 'studio-loading';

const LOADING_MESSAGE_SELECTOR = '[data-loading-message]';

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
 * Waits for Studio to be ready and for its first frame to be on screen, then takes the loading state away and, on a first
 * visit, opens the setup over the drawn app. `?setup=off` never opens it.
 */
export async function revealStudio({ studio, setupParameter, documentReference, requestFrame }) {
  await studio.ready;
  await waitForNextPaint(requestFrame);
  removeStudioLoading(documentReference);
  if (setupParameter !== 'off' && !studio.setupDone) {
    studio.openSetup();
  }
}
