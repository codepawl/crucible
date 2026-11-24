// A browser can drop the WebGL context of a canvas at any time (a driver reset, too many contexts on the page). Studio
// pauses the picture and says so instead of letting the frame loop die without a word, then draws again on its own when
// the context returns.

// How long the notice waits before it offers a reload: the context often returns by itself within a moment.
export const RELOAD_OFFER_MILLISECONDS = 3000;

import { leadWithActionIcon, STUDIO_ACTION_ICONS } from './studio-icons.js';

export const CONTEXT_LOST_MESSAGE = 'The picture is paused: the graphics context was lost. It comes back on its own, or reload to restore it.';

export function frameFailureReason(error) {
  return error?.message ? String(error.message) : 'a frame could not be drawn';
}

export function describeFrameFailure(error) {
  const reason = frameFailureReason(error);
  return `The picture is paused: ${reason}. Change the view to try again, or reload.`;
}

/**
 * The notice that sits over the viewport while the picture is paused. It leads with an icon, is announced politely and
 * offers a plain Reload button once the pause has lasted a few seconds.
 */
export function createPausedPictureNotice({ documentReference, createIcon, reload }) {
  const message = documentReference.createElement('p');
  const reloadButton = documentReference.createElement('button');
  reloadButton.type = 'button';
  reloadButton.textContent = 'Reload';
  leadWithActionIcon(reloadButton, createIcon(STUDIO_ACTION_ICONS.reload), STUDIO_ACTION_ICONS.reload);
  reloadButton.hidden = true;
  reloadButton.addEventListener('click', reload);

  const element = documentReference.createElement('div');
  element.className = 'crucible-studio-island crucible-studio-paused';
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.hidden = true;
  element.append(createIcon('pause'), message, reloadButton);

  let reloadTimer = 0;

  // The reason inside the text is an error's own message, so it is marked selectable; the sentence around it is not.
  function show(text, reason = '') {
    const reasonStart = reason ? text.indexOf(reason) : -1;
    if (reasonStart === -1) {
      message.textContent = text;
    } else {
      const reasonElement = documentReference.createElement('span');
      reasonElement.className = 'crucible-studio-selectable';
      reasonElement.textContent = reason;
      message.replaceChildren(text.slice(0, reasonStart), reasonElement, text.slice(reasonStart + reason.length));
    }
    element.hidden = false;
    if (reloadTimer || !reloadButton.hidden) {
      return;
    }
    reloadTimer = setTimeout(() => {
      reloadTimer = 0;
      reloadButton.hidden = false;
    }, RELOAD_OFFER_MILLISECONDS);
  }

  function hide() {
    clearTimeout(reloadTimer);
    reloadTimer = 0;
    reloadButton.hidden = true;
    element.hidden = true;
  }

  return { element, show, hide, get visible() { return !element.hidden; } };
}

/**
 * Listens on the canvas for the context going away and coming back. The lost event is cancelled, which is what lets
 * the browser restore the context at all. Returns a function that removes both listeners.
 */
export function watchContextLoss(canvas, { onLost, onRestored }) {
  const handleLost = event => {
    event.preventDefault();
    onLost();
  };
  canvas.addEventListener('webglcontextlost', handleLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  return () => {
    canvas.removeEventListener('webglcontextlost', handleLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };
}
