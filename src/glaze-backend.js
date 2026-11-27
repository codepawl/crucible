// The Glaze backend boundary (#901): what the real-time renderer asks of a graphics API (see glaze-backend-webgl2.js for the list of calls).
// WebGL2 is the only implementation today. The renderer's frame core, reversed depth, render passes and float output call the backend
// instead of the raw context; pass files not yet ported still use `backend.context` directly.

import { WebGL2GlazeBackend } from './glaze-backend-webgl2.js';

/** Opens the canvas with the one backend there is; WebGL2 stays the fallback once another backend exists. */
export function createGlazeBackend(canvas, options = {}) {
  return WebGL2GlazeBackend.create(canvas, options);
}

/** True when `candidate` implements the GlazeBackend interface rather than a raw WebGL2 context. */
export function isGlazeBackend(candidate) {
  return Boolean(candidate && typeof candidate.name === 'string' && typeof candidate.createFramebufferTarget === 'function');
}

/** Accepts either a GlazeBackend or a raw WebGL2 context so standalone callers keep working. */
export function asGlazeBackend(contextOrBackend) {
  if (isGlazeBackend(contextOrBackend)) return contextOrBackend;
  return new WebGL2GlazeBackend(contextOrBackend);
}

/** Returns `renderer.backend` when it implements the backend boundary, or falls back to `renderer.context`. */
export function backendFor(renderer) {
  return asGlazeBackend(isGlazeBackend(renderer.backend) ? renderer.backend : renderer.context);
}

/** Picks `contextOrBackend` when it is already a backend, else reuses `activeBackend` when compatible, else wraps a raw context. */
export function resolveGlazeBackend(contextOrBackend, activeBackend = null) {
  if (activeBackend && (!contextOrBackend || activeBackend.name !== 'webgl2' || activeBackend.context === contextOrBackend)) {
    return activeBackend;
  }
  return asGlazeBackend(contextOrBackend);
}
