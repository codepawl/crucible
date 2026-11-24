// Shows an AI agent at work in the Studio viewport: a pointer with the agent's name that travels to each object the
// agent changed, the way a collaborator's cursor does in a shared document.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAXIMUM_NAME_LENGTH = 40;
const MAXIMUM_STOPS = 8;
const STOP_MILLISECONDS = 1100;
const LINGER_MILLISECONDS = 1600;
const TRAVEL_FALLBACK_MARGIN_MILLISECONDS = 40;
const DEFAULT_TRAVEL_MILLISECONDS = 360;
const DEFAULT_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const MINIMUM_GLIDE_PIXELS = 0.5;
// Custom properties of studio-styles.js: how long and with what curve the pointer glides to a new object.
export const TRAVEL_TOKEN = '--studio-motion-travel';
export const EASE_TOKEN = '--studio-ease-out';

function parseDurationMilliseconds(text, fallback) {
  const match = /^\s*(-?\d*\.?\d+)(ms|s)\s*$/.exec(text ?? '');
  if (!match) {
    return fallback;
  }
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
}

/** The x and y of a computed `transform` value: "none" is no offset, "matrix(a, b, c, d, x, y)" carries it last. */
function parseTranslation(transform) {
  const numbers = /^matrix\((.+)\)$/.exec(transform ?? '')?.[1].split(',').map(Number);
  return numbers?.length === 6 ? [numbers[4], numbers[5]] : [0, 0];
}

export const DEFAULT_AGENT_NAME = 'Agent';
// Brand kit accent and status colours, plus the blue of the Z axis. Each is light enough for ink text.
export const AGENT_COLORS = Object.freeze(['#fc9132', '#5fc48a', '#5ea8ff', '#ee7a6c', '#f0b34a']);

/** The colour an agent keeps for as long as it keeps its name. */
export function agentColor(name) {
  let hash = 0;
  for (const character of assertAgentName(name)) {
    hash = (hash * 158 + character.codePointAt(0)) % 9973;
  }
  return AGENT_COLORS[hash % AGENT_COLORS.length];
}

export function assertAgentName(name) {
  if (typeof name !== 'string' || name.trim() === '' || name.length > MAXIMUM_NAME_LENGTH) {
    throw new TypeError(`The agent name must be a string of 1 to ${MAXIMUM_NAME_LENGTH} characters, such as "Claude".`);
  }
  return name.trim();
}

function entriesById(entries) {
  return new Map((entries ?? []).map(entry => [entry.id, JSON.stringify(entry)]));
}

function changedIds(beforeEntries, afterEntries) {
  const before = entriesById(beforeEntries);
  const changed = new Set();
  for (const [id, text] of entriesById(afterEntries)) {
    if (before.get(id) !== text) {
      changed.add(id);
    }
  }
  return changed;
}

/**
 * Compares two scene recipes and lists what an edit touched.
 * `nodeIds` are the nodes of `after` that are new, changed, or use a material or geometry that changed.
 * `removedNodeIds` are the nodes of `before` that `after` no longer has. `otherChange` is true when anything else differs.
 */
export function diffRecipeNodes(before, after) {
  const changedNodes = changedIds(before.nodes, after.nodes);
  const changedMaterials = changedIds(before.materials, after.materials);
  const changedGeometries = changedIds(before.geometries, after.geometries);
  const nodeIds = (after.nodes ?? [])
    .filter(node => changedNodes.has(node.id) || changedMaterials.has(node.material) || changedGeometries.has(node.geometry))
    .map(node => node.id);
  const afterIds = new Set((after.nodes ?? []).map(node => node.id));
  const removedNodeIds = (before.nodes ?? []).map(node => node.id).filter(id => !afterIds.has(id));
  const withoutParts = recipe => JSON.stringify({ ...recipe, nodes: undefined, materials: undefined, geometries: undefined });
  const otherChange = withoutParts(before) !== withoutParts(after);
  return { nodeIds, removedNodeIds, otherChange };
}

/** One short line for the status region, such as "Claude edited hero, orb and 2 more". */
export function describeAgentEdit(name, { nodeIds, removedNodeIds, otherChange }) {
  if (nodeIds.length > 0) {
    const named = nodeIds.slice(0, 2).join(', ');
    const rest = nodeIds.length - 2;
    return rest > 0 ? `${name} edited ${named} and ${rest} more` : `${name} edited ${named}`;
  }
  if (removedNodeIds.length > 0) {
    return `${name} removed ${removedNodeIds.slice(0, 2).join(', ')}`;
  }
  return otherChange ? `${name} changed the scene look` : `${name} saved without changes`;
}

function centreOf(points) {
  const sum = points.reduce((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

function createPointerIcon(documentReference) {
  const icon = documentReference.createElementNS(SVG_NAMESPACE, 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const arrow = documentReference.createElementNS(SVG_NAMESPACE, 'path');
  arrow.setAttribute('d', 'M2 2 14.6 5.4 9.4 9.4 5.4 14.6Z');
  icon.append(arrow);
  return icon;
}

/**
 * Creates the pointer and the outline it draws. `controller` supplies `nodeOutline`, `viewportWidth` and `viewportHeight`;
 * `requestDraw` asks the Studio for a frame so the outline appears. Returns the elements to mount and the calls that drive them.
 */
export function createAgentPresence(documentReference, { controller, requestDraw }) {
  const pointer = documentReference.createElement('div');
  pointer.className = 'crucible-studio-agent-cursor';
  pointer.hidden = true;
  pointer.setAttribute('aria-hidden', 'true');
  const nameTag = documentReference.createElement('span');
  nameTag.className = 'crucible-studio-agent-name';
  pointer.append(createPointerIcon(documentReference), nameTag);

  let stops = [];
  let stopIndex = 0;
  let color = AGENT_COLORS[0];
  let timer = null;
  let travelTimer = null;
  let glide = null;
  let placedX = null;
  let placedY = null;

  function activeNodeId() {
    return stops[stopIndex] ?? null;
  }

  function endTravel() {
    clearTimeout(travelTimer);
    travelTimer = null;
    if (glide) {
      const finishedGlide = glide;
      glide = null;
      finishedGlide.onfinish = null;
      finishedGlide.oncancel = null;
      finishedGlide.cancel();
    }
    delete pointer.dataset.travelling;
  }

  function readTokens() {
    const view = documentReference.defaultView;
    const style = view?.getComputedStyle?.(pointer);
    // A missing or unreadable token must not play a glide for someone who asked for reduced motion.
    const reducedMotion = view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    return {
      duration: reducedMotion ? 0 : parseDurationMilliseconds(style?.getPropertyValue(TRAVEL_TOKEN), DEFAULT_TRAVEL_MILLISECONDS),
      easing: style?.getPropertyValue(EASE_TOKEN)?.trim() || DEFAULT_EASING,
      transform: style?.transform,
    };
  }

  // Where the pointer is on screen right now: its glued place plus the offset the running glide has left.
  function visiblePosition(transform) {
    const [glideX, glideY] = parseTranslation(transform);
    return [placedX + glideX, placedY + glideY];
  }

  // A travel is a transform animation that starts at the offset between where the pointer stood and the new target and
  // runs to zero. The translate that glues the pointer to its object keeps following the camera underneath it, so the
  // pointer lands on a moving object exactly instead of chasing it, and a new target starts from the visible position.
  function beginGlide(fromX, fromY, { duration, easing }) {
    const offsetX = fromX - placedX;
    const offsetY = fromY - placedY;
    endTravel();
    if (duration <= 0 || typeof pointer.animate !== 'function' || Math.hypot(offsetX, offsetY) < MINIMUM_GLIDE_PIXELS) {
      return;
    }
    glide = pointer.animate(
      [{ transform: `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px)` }, { transform: 'translate(0px, 0px)' }],
      { duration, easing },
    );
    glide.onfinish = endTravel;
    glide.oncancel = endTravel;
    pointer.dataset.travelling = 'true';
    // The timer outlives the glide by a frame or two, so the animation events normally end a travel first.
    travelTimer = setTimeout(endTravel, duration + TRAVEL_FALLBACK_MARGIN_MILLISECONDS);
  }

  // The pointer is glued to its object by the compositor-run translate property from two pixel values, with no
  // transition: the camera moves it every frame and it never trails.
  function place() {
    const nodeId = activeNodeId();
    if (!nodeId) {
      return null;
    }
    const outline = controller.nodeOutline(nodeId);
    if (!outline) {
      return null;
    }
    const centre = centreOf(outline);
    const x = Number(centre[0].toFixed(1));
    const y = Number(centre[1].toFixed(1));
    if (x !== placedX || y !== placedY) {
      pointer.style.setProperty('--studio-agent-x', `${x}px`);
      pointer.style.setProperty('--studio-agent-y', `${y}px`);
      placedX = x;
      placedY = y;
    }
    return outline;
  }

  function finish() {
    clearTimeout(timer);
    timer = null;
    stops = [];
    stopIndex = 0;
    endTravel();
    placedX = null;
    placedY = null;
    pointer.hidden = true;
    pointer.dataset.nodeId = '';
    requestDraw();
  }

  function goToStop(index) {
    stopIndex = index;
    const previousNodeId = pointer.dataset.nodeId;
    pointer.dataset.nodeId = activeNodeId();
    // A pointer that is already on screen travels to a new object from where it stands; a hidden one appears in place,
    // and a stop on the object it is already on has nowhere to travel.
    const travels = !pointer.hidden && previousNodeId !== activeNodeId();
    const tokens = travels ? readTokens() : null;
    const origin = travels ? visiblePosition(tokens.transform) : null;
    pointer.hidden = place() === null;
    if (pointer.hidden) {
      endTravel();
    }
    if (travels && !pointer.hidden) {
      beginGlide(origin[0], origin[1], tokens);
    }
    requestDraw();
    const isLast = index >= stops.length - 1;
    timer = setTimeout(() => (isLast ? finish() : goToStop(index + 1)), isLast ? LINGER_MILLISECONDS : STOP_MILLISECONDS);
  }

  return {
    element: pointer,
    get activeNodeId() {
      return activeNodeId();
    },
    get color() {
      return color;
    },
    /** Called on every Studio frame: keeps the pointer on its object while the camera moves and returns the outline to draw. */
    place,
    /** Walks the pointer over `nodeIds` in order, under `name`. A new call replaces a walk in progress. */
    show({ name, nodeIds }) {
      const label = assertAgentName(name);
      if (!Array.isArray(nodeIds) || nodeIds.some(nodeId => typeof nodeId !== 'string' || nodeId === '')) {
        throw new TypeError('nodeIds must be an array of node id strings.');
      }
      clearTimeout(timer);
      stops = [];
      stopIndex = 0;
      nameTag.textContent = label;
      color = agentColor(label);
      pointer.style.color = color;
      nameTag.style.background = color;
      // The outline of a node costs a pass over its parts, so the search ends at the stops the pointer will visit (#2842).
      for (const nodeId of nodeIds) {
        if (stops.length >= MAXIMUM_STOPS) {
          break;
        }
        if (controller.nodeOutline(nodeId) !== null) {
          stops.push(nodeId);
        }
      }
      if (stops.length > 0) {
        goToStop(0);
      } else {
        finish();
      }
      return stops.length;
    },
    hide: finish,
    dispose() {
      clearTimeout(timer);
      endTravel();
    },
  };
}
