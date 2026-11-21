// What Studio keeps when something goes wrong: the last few errors, lost graphics contexts, long tasks and slow edits,
// held in memory and saved only when a person asks. An entry carries a kind, a time, a short message, a capped stack and
// the scene's size in numbers. It never carries the recipe, node names, file names or keys, and nothing here talks to
// the network or schedules work while the scene is idle.
import { VERSION } from './version.js';

export const STUDIO_DIAGNOSTIC_KINDS = Object.freeze(['error', 'rejection', 'contextLost', 'contextRestored', 'longTask', 'slowOperation']);
export const DEFAULT_DIAGNOSTIC_LIMIT = 200;
export const MAXIMUM_DIAGNOSTIC_LIMIT = 5000;
export const DEFAULT_SLOW_OPERATION_MILLISECONDS = 100;
export const DIAGNOSTIC_MESSAGE_LIMIT = 300;
export const DIAGNOSTIC_STACK_LIMIT = 2000;
const DIAGNOSTIC_NAME_LIMIT = 100;
const KINDS_WITH_SCENE_SIZE = new Set(['error', 'rejection', 'slowOperation']);
// A URL or an absolute path in a stack or a message keeps only its last segment, so no folder or user name leaves with it.
const LOCATION_PATTERN = /(?:file:\/\/|https?:\/\/|[A-Za-z]:[\\/]|\/)[^\s()'"]*[\\/]([^\\/\s():'"]+)/g;

function truncate(value, limit) {
  const text = String(value).replace(LOCATION_PATTERN, '$1');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function roundMilliseconds(value) {
  return Math.round(value * 10) / 10;
}

function assertOptionalFunction(value, name) {
  if (value !== undefined && typeof value !== 'function') {
    throw new TypeError(`${name} must be a function when provided, got ${typeof value}.`);
  }
}

function assertOptions({ limit, now, onEntry, slowOperationMilliseconds, describeScene, describeEnvironment }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_DIAGNOSTIC_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAXIMUM_DIAGNOSTIC_LIMIT}, got ${JSON.stringify(limit)}.`);
  }
  if (typeof slowOperationMilliseconds !== 'number' || !Number.isFinite(slowOperationMilliseconds) || slowOperationMilliseconds <= 0) {
    throw new RangeError(`slowOperationMilliseconds must be a number above 0, got ${JSON.stringify(slowOperationMilliseconds)}.`);
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function that returns the current time in milliseconds.');
  }
  assertOptionalFunction(onEntry, 'onEntry');
  assertOptionalFunction(describeScene, 'describeScene');
  assertOptionalFunction(describeEnvironment, 'describeEnvironment');
}

function isThenable(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/** The name, message and stack of anything that was thrown or rejected, capped. A value that is not an error keeps only its type. */
export function describeThrown(thrown, fallbackMessage = '') {
  if (thrown && typeof thrown === 'object' && typeof thrown.message === 'string') {
    return {
      name: truncate(thrown.name || 'Error', DIAGNOSTIC_NAME_LIMIT),
      message: truncate(thrown.message, DIAGNOSTIC_MESSAGE_LIMIT),
      ...(typeof thrown.stack === 'string' ? { stack: truncate(thrown.stack, DIAGNOSTIC_STACK_LIMIT) } : {}),
    };
  }
  if (typeof thrown === 'string') {
    return { name: 'Error', message: truncate(thrown, DIAGNOSTIC_MESSAGE_LIMIT) };
  }
  return { name: 'Error', message: truncate(fallbackMessage || `A ${typeof thrown} was thrown that is not an error.`, DIAGNOSTIC_MESSAGE_LIMIT) };
}

/**
 * Keeps the last `limit` entries in a ring. `describeScene()` gives `{ nodes, triangles }` and `describeEnvironment()` the
 * browser facts for the report; both are called only when an entry or a report needs them. `onEntry` sees a copy of each
 * entry, and an exception it throws is dropped, so a broken hook never breaks the edit that was being timed.
 */
export function createStudioDiagnostics({
  limit = DEFAULT_DIAGNOSTIC_LIMIT,
  now = () => performance.now(),
  onEntry,
  slowOperationMilliseconds = DEFAULT_SLOW_OPERATION_MILLISECONDS,
  describeScene,
  describeEnvironment,
} = {}) {
  assertOptions({ limit, now, onEntry, slowOperationMilliseconds, describeScene, describeEnvironment });
  const entries = [];
  const counts = Object.fromEntries(STUDIO_DIAGNOSTIC_KINDS.map(kind => [kind, 0]));
  let notifying = false;

  function readSceneSize() {
    try {
      const size = describeScene?.();
      return size ? { nodes: size.nodes, triangles: size.triangles } : undefined;
    } catch {
      return undefined;
    }
  }

  function notify(entry) {
    if (!onEntry || notifying) {
      return;
    }
    notifying = true;
    try {
      onEntry(structuredClone(entry));
    } catch {
      // The embedding app's hook failed: that must not become another entry or interrupt Studio.
    } finally {
      notifying = false;
    }
  }

  function record(kind, details = {}) {
    if (!STUDIO_DIAGNOSTIC_KINDS.includes(kind)) {
      throw new RangeError(`Unknown diagnostic kind "${kind}". Use one of: ${STUDIO_DIAGNOSTIC_KINDS.join(', ')}.`);
    }
    const scene = KINDS_WITH_SCENE_SIZE.has(kind) ? readSceneSize() : undefined;
    const entry = { kind, time: new Date().toISOString(), ...details, ...(scene ? { scene } : {}) };
    entries.push(entry);
    if (entries.length > limit) {
      entries.shift();
    }
    counts[kind] += 1;
    notify(entry);
    return entry;
  }

  function recordFailure(kind, thrown, fallbackMessage) {
    return record(kind, describeThrown(thrown, fallbackMessage));
  }

  function finishMeasure(name, startedAt) {
    const durationMilliseconds = roundMilliseconds(now() - startedAt);
    if (durationMilliseconds >= slowOperationMilliseconds) {
      record('slowOperation', { name: truncate(name, DIAGNOSTIC_NAME_LIMIT), durationMilliseconds });
    }
  }

  /** Runs `operation`, records a slowOperation entry when it took the threshold or longer, and returns or rethrows what it did. */
  function measure(name, operation) {
    const startedAt = now();
    let outcome;
    try {
      outcome = operation();
    } catch (error) {
      finishMeasure(name, startedAt);
      throw error;
    }
    if (!isThenable(outcome)) {
      finishMeasure(name, startedAt);
      return outcome;
    }
    return outcome.then(
      value => {
        finishMeasure(name, startedAt);
        return value;
      },
      error => {
        finishMeasure(name, startedAt);
        throw error;
      },
    );
  }

  function report() {
    const environment = (() => {
      try {
        return describeEnvironment?.() ?? {};
      } catch {
        return {};
      }
    })();
    return JSON.parse(JSON.stringify({
      format: 'crucible.studio.diagnostics',
      version: 1,
      crucibleVersion: VERSION,
      generatedAt: new Date().toISOString(),
      userAgent: environment.userAgent ? truncate(environment.userAgent, DIAGNOSTIC_MESSAGE_LIMIT) : null,
      graphics: environment.graphics ?? null,
      viewport: environment.viewport ?? null,
      scene: readSceneSize() ?? null,
      counts,
      entries,
    }));
  }

  return {
    record,
    recordFailure,
    measure,
    report,
    entries: () => structuredClone(entries),
    get slowOperationMilliseconds() { return slowOperationMilliseconds; },
  };
}

/**
 * Starts listening where a Studio lives: uncaught errors and unhandled rejections on its window, context loss on its
 * canvas and long tasks where the browser reports them. Returns the function that removes all of it. Nothing here polls.
 */
export function watchStudioDiagnostics(diagnostics, { windowReference, canvas, PerformanceObserverClass = globalThis.PerformanceObserver }) {
  const stops = [];
  const listen = (target, type, handler) => {
    if (typeof target?.addEventListener !== 'function') {
      return;
    }
    target.addEventListener(type, handler);
    stops.push(() => target.removeEventListener(type, handler));
  };

  listen(windowReference, 'error', event => {
    diagnostics.recordFailure('error', event.error, event.message);
  });
  listen(windowReference, 'unhandledrejection', event => {
    diagnostics.recordFailure('rejection', event.reason, 'A promise was rejected with a value that is not an error.');
  });
  listen(canvas, 'webglcontextlost', () => diagnostics.record('contextLost'));
  listen(canvas, 'webglcontextrestored', () => diagnostics.record('contextRestored'));

  if (typeof PerformanceObserverClass === 'function') {
    try {
      const observer = new PerformanceObserverClass(list => {
        for (const task of list.getEntries()) {
          diagnostics.record('longTask', { name: 'longtask', durationMilliseconds: roundMilliseconds(task.duration) });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      stops.push(() => observer.disconnect());
    } catch {
      // This browser does not report long tasks.
    }
  }
  return () => {
    for (const stop of stops.splice(0)) {
      stop();
    }
  };
}

/** Browser facts for the report: no recipe, no page address. The GPU strings come from the renderer's WebGL context when it exposes them. */
export function describeStudioEnvironment({ windowReference, renderer, viewportWidth, viewportHeight }) {
  return {
    userAgent: windowReference?.navigator?.userAgent ?? globalThis.navigator?.userAgent,
    graphics: describeGraphics(renderer?.context),
    viewport: { width: viewportWidth, height: viewportHeight, pixelRatio: windowReference?.devicePixelRatio ?? 1 },
  };
}

function describeGraphics(context) {
  try {
    const debugInfo = context?.getExtension?.('WEBGL_debug_renderer_info');
    if (!debugInfo) {
      return null;
    }
    return {
      vendor: truncate(context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL), DIAGNOSTIC_MESSAGE_LIMIT),
      renderer: truncate(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL), DIAGNOSTIC_MESSAGE_LIMIT),
    };
  } catch {
    return null;
  }
}
