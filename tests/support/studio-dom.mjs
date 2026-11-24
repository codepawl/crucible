import { resolveObjectURL } from 'node:buffer';

// A small stand-in for the browser, just enough to mount the Studio (src/studio.js) in plain Node: elements with attributes, dataset,
// children, event capture and bubbling, popovers, dialogs, timers and animation frames that tests run by hand, and the observers.
// Tests drive the UI by dispatching events on the elements Studio created, then read state back from the elements and the recipe.

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAhMkV7QAAAABJRU5ErkJggg==';

function matchesCompound(element, compound) {
  const tokens = compound.match(/^([a-zA-Z0-9-]*)((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!tokens) {
    throw new Error(`The fake DOM does not support the selector "${compound}".`);
  }
  const [, tagName, rest] = tokens;
  if (tagName && element.tagName.toLowerCase() !== tagName.toLowerCase()) {
    return false;
  }
  for (const part of rest.match(/[.#][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part[0] === '.') {
      if (!String(element.className).split(/\s+/).includes(part.slice(1))) return false;
    } else if (part[0] === '#') {
      if (element.id !== part.slice(1)) return false;
    } else {
      const [name, expected] = part.slice(1, -1).split('=');
      const actual = element.getAttribute(name);
      if (actual === null) return false;
      if (expected !== undefined && actual !== expected.replace(/^"|"$/g, '')) return false;
    }
  }
  return true;
}

function matchesSelector(element, selector) {
  const compounds = selector.trim().split(/\s+/);
  if (!matchesCompound(element, compounds.at(-1))) {
    return false;
  }
  let ancestor = element.parentNode;
  for (let index = compounds.length - 2; index >= 0; index -= 1) {
    while (ancestor && !(ancestor.tagName && matchesCompound(ancestor, compounds[index]))) {
      ancestor = ancestor.parentNode;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

export class FakeNode {
  constructor(ownerDocument, tagName, namespace = 'http://www.w3.org/1999/xhtml') {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.namespaceURI = namespace;
    this.children = [];
    this.parentNode = null;
    this.listeners = [];
    this.attributeMap = new Map();
    this.dataset = {};
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      getPropertyValue(name) { return this[name] ?? ''; },
    };
    this.ownText = '';
    this.className = '';
    this.id = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.box = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    this.measuredClientWidth = null;
    this.measuredClientHeight = null;
    this.popoverOpen = false;
    this.open = false;
    this.returnValue = '';
    this.capturedPointerIds = [];
    this.clicks = 0;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  get clientWidth() {
    return this.measuredClientWidth ?? this.parentNode?.clientWidth ?? 0;
  }

  set clientWidth(width) {
    this.measuredClientWidth = width;
  }

  get clientHeight() {
    return this.measuredClientHeight ?? this.parentNode?.clientHeight ?? 0;
  }

  set clientHeight(height) {
    this.measuredClientHeight = height;
  }

  get textContent() {
    return this.ownText + this.children.map(child => child.textContent).join('');
  }

  set textContent(text) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = String(text);
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  adoptChildren(nodes) {
    return nodes.map(node => {
      if (typeof node === 'string') {
        const textNode = new FakeNode(this.ownerDocument, '#text');
        textNode.ownText = node;
        node = textNode;
      }
      if (node.parentNode) {
        node.parentNode.removeChild(node);
        node.moves = (node.moves ?? 0) + 1;
      }
      node.parentNode = this;
      return node;
    });
  }

  append(...nodes) {
    const adopted = this.adoptChildren(nodes);
    this.children.push(...adopted);
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  before(...nodes) {
    if (nodes.length === 1 && nodes[0] === this) return;
    const adopted = this.parentNode.adoptChildren(nodes);
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 0, ...adopted);
  }

  prepend(...nodes) {
    const adopted = this.adoptChildren(nodes);
    this.children.unshift(...adopted);
  }

  replaceChildren(...nodes) {
    for (const child of this.children) {
      this.blurWhenInside(child);
      child.parentNode = null;
    }
    this.children = [];
    this.ownText = '';
    this.append(...nodes);
  }

  // A browser blurs the focused element when it, or an ancestor of it, leaves the document.
  blurWhenInside(node) {
    const focused = this.ownerDocument.activeElement;
    if (focused && node.contains(focused)) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  insertBefore(node, reference) {
    if (reference === null || reference === undefined) {
      this.append(node);
    } else if (node !== reference) {
      reference.before(node);
    }
    return node;
  }

  removeChild(node) {
    this.blurWhenInside(node);
    this.children = this.children.filter(child => child !== node);
    node.parentNode = null;
    return node;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributeMap.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributeMap.has(name) ? this.attributeMap.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributeMap.has(name);
  }

  removeAttribute(name) {
    this.attributeMap.delete(name);
    if (name === 'tabindex') this.tabIndex = -1;
  }

  toggleAttribute(name, force) {
    const shouldHave = force ?? !this.attributeMap.has(name);
    if (shouldHave) this.attributeMap.set(name, '');
    else this.attributeMap.delete(name);
    return shouldHave;
  }

  addEventListener(type, listener, options) {
    const capture = options === true || options?.capture === true;
    this.listeners.push({ type, listener, capture });
  }

  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter(entry => entry.type !== type || entry.listener !== listener);
  }

  dispatchEvent(event) {
    event.target ??= this;
    const path = [];
    for (let node = this; node; node = node.parentNode) path.push(node);
    const run = (node, capturePhase) => {
      event.currentTarget = node;
      for (const entry of [...node.listeners]) {
        if (entry.type !== event.type) continue;
        const atTarget = node === event.target;
        if (!atTarget && entry.capture !== capturePhase) continue;
        if (atTarget && capturePhase) continue;
        entry.listener.call(node, event);
      }
    };
    for (const node of [...path].reverse().slice(0, -1)) {
      run(node, true);
      if (event.propagationStopped) return !event.defaultPrevented;
    }
    for (const node of path) {
      run(node, false);
      if (event.propagationStopped || (!event.bubbles && node === this)) break;
    }
    return !event.defaultPrevented;
  }

  closest(selector) {
    for (let node = this; node && node.tagName; node = node.parentNode) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.tagName !== '#TEXT' && matchesSelector(child, selector)) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect() {
    return this.box;
  }

  setPointerCapture(pointerId) {
    this.capturedPointerIds.push(pointerId);
  }

  // A browser refuses focus for an element that is detached, hidden or disabled; preventScroll is accepted and ignored.
  focus(options = {}) {
    for (let current = this; current; current = current.parentNode) {
      if (current.hidden) return;
    }
    if (!this.isConnected || this.disabled) return;
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(this.ownerDocument.createEvent('focusin', { bubbles: true }));
  }

  select() {
    this.selected = true;
  }

  click() {
    this.clicks += 1;
    this.dispatchEvent(this.ownerDocument.createEvent('click', { bubbles: true }));
    const popoverTarget = this.getAttribute('popovertarget');
    if (popoverTarget) {
      this.ownerDocument.getElementById(popoverTarget)?.showPopover();
    }
    if (this.tagName === 'A' && this.download) {
      this.ownerDocument.recordDownload(this);
    }
  }

  showPopover() {
    const toggleEvent = this.ownerDocument.createEvent('beforetoggle', { newState: 'open' });
    this.dispatchEvent(toggleEvent);
    this.popoverOpen = true;
  }

  hidePopover() {
    this.popoverOpen = false;
  }

  showModal() {
    this.open = true;
    this.modal = true;
  }

  close(returnValue = '') {
    if (!this.open) return;
    this.open = false;
    this.returnValue = returnValue;
    this.dispatchEvent(this.ownerDocument.createEvent('close'));
  }

  toDataURL(type) {
    this.lastDataUrlType = type;
    return PNG_DATA_URL;
  }

  /** Every descendant, depth first. */
  descendants() {
    const found = [];
    const walk = node => {
      for (const child of node.children) {
        found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

export class FakeDocument extends FakeNode {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.hidden = false;
    this.activeElement = null;
    this.downloads = [];
    this.documentElement = new FakeNode(this, 'html');
    this.head = new FakeNode(this, 'head');
    this.body = new FakeNode(this, 'body');
    this.documentElement.append(this.head, this.body);
    this.append(this.documentElement);
    this.defaultView = { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 };
  }

  get isConnected() {
    return true;
  }

  createElement(tagName) {
    return new FakeNode(this, tagName);
  }

  createElementNS(namespace, tagName) {
    return new FakeNode(this, tagName, namespace);
  }

  createEvent(type, properties = {}) {
    return {
      type,
      bubbles: false,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...properties,
    };
  }

  getElementById(id) {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.descendants().find(element => element.id === id) ?? null;
  }

  recordDownload(anchor) {
    const blob = resolveObjectURL(anchor.href);
    this.downloads.push({ filename: anchor.download, href: anchor.href, blob });
  }
}

class FakeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
  }

  observe(element) {
    this.observed.push(element);
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeHtmlElement {}

const REPLACED_GLOBALS = [
  'document',
  'window',
  'HTMLElement',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'setTimeout',
  'clearTimeout',
  'ResizeObserver',
  'IntersectionObserver',
  'navigator',
];

/**
 * Installs the fake browser on globalThis and returns a handle. Call `uninstall()` when the test ends.
 * `document` is the fake document, `container` an empty element in its body, and `clipboard` the text copied so far.
 */
const SETTLE_DEADLINE_MILLISECONDS = 10000;

export function installStudioDom({ clipboardFails = false } = {}) {
  const originals = new Map(REPLACED_GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new FakeDocument();
  const container = document.createElement('div');
  container.id = 'studio-container';
  document.body.append(container);

  const timers = new Map();
  const animationFrames = new Map();
  let nextHandle = 1;
  const observers = { resize: [], intersection: [] };
  const clipboardTexts = [];
  const realSetImmediate = globalThis.setImmediate;

  class RecordingResizeObserver extends FakeObserver {
    constructor(callback) {
      super(callback);
      observers.resize.push(this);
    }
  }

  class RecordingIntersectionObserver extends FakeObserver {
    constructor(callback) {
      super(callback);
      observers.intersection.push(this);
    }
  }

  const replacements = {
    document,
    window: document.defaultView,
    HTMLElement: FakeHtmlElement,
    getComputedStyle: () => ({ direction: 'ltr' }),
    requestAnimationFrame: callback => {
      const handle = nextHandle++;
      animationFrames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame: handle => {
      animationFrames.delete(handle);
    },
    setTimeout: (callback, delay) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, delay });
      return handle;
    },
    clearTimeout: handle => {
      timers.delete(handle);
    },
    ResizeObserver: RecordingResizeObserver,
    IntersectionObserver: RecordingIntersectionObserver,
    navigator: {
      clipboard: {
        writeText: async text => {
          if (clipboardFails) throw new Error('Clipboard is not available.');
          clipboardTexts.push(text);
        },
      },
    },
  };
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
  }

  return {
    document,
    container,
    observers,
    clipboardTexts,
    get pendingTimerCount() {
      return timers.size;
    },
    get pendingTimerDelays() {
      return [...timers.values()].map(timer => timer.delay);
    },
    get pendingAnimationFrameCount() {
      return animationFrames.size;
    },
    /** Runs every queued animation frame once, at the given timestamp in milliseconds. */
    runAnimationFrames(timestamp) {
      const queued = [...animationFrames.entries()];
      animationFrames.clear();
      for (const [, callback] of queued) callback(timestamp);
      return queued.length;
    },
    /** Runs and clears every pending timer (status message resets, object URL clean-up). */
    runTimers() {
      const queued = [...timers.values()];
      timers.clear();
      for (const { callback } of queued) callback();
      return queued.length;
    },
    /** Lets promise chains started by event handlers finish. */
    settle() {
      return new Promise(resolve => {
        realSetImmediate(resolve);
      });
    },
    /**
     * Settles until isDone() holds or the time runs out. A deadline, not a turn count: an import hashes the file with
     * crypto.subtle on the thread pool, which can take more than a few hundred event-loop turns on a loaded runner (#3330).
     */
    async settleUntil(isDone, milliseconds = SETTLE_DEADLINE_MILLISECONDS) {
      const deadline = performance.now() + milliseconds;
      while (!isDone() && performance.now() < deadline) await this.settle();
    },
    uninstall() {
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
}

/** A renderer that records what Studio asks of it, in place of the WebGL one. */
export function createFakeRenderer() {
  const renderer = {
    calls: [],
    frames: [],
    shadowBounds: null,
    shadowsDirty: false,
    world: null,
    updateFailure: null,
    disposed: false,
    replaceParts(parts) {
      renderer.calls.push('replaceParts');
      renderer.partCount = parts.length;
    },
    updateParts(parts) {
      renderer.calls.push('updateParts');
      renderer.partCount = parts.length;
      if (renderer.updateFailure) throw renderer.updateFailure;
    },
    resize() {
      renderer.calls.push('resize');
    },
    render(frame) {
      renderer.calls.push('render');
      renderer.frames.push(frame);
    },
    dispose() {
      renderer.calls.push('dispose');
      renderer.disposed = true;
    },
  };
  return renderer;
}

/** Builds a pointer, keyboard or plain event object for `dispatch`. */
export function eventProperties(type, properties = {}) {
  const defaults = {
    pointerdown: { button: 0, pointerId: 1, clientX: 0, clientY: 0, shiftKey: false, altKey: false },
    pointermove: { pointerId: 1, clientX: 0, clientY: 0, shiftKey: false },
    pointerup: { pointerId: 1, clientX: 0, clientY: 0, altKey: false },
    keydown: { key: '', ctrlKey: false, metaKey: false, shiftKey: false },
  };
  return { bubbles: true, ...defaults[type], ...properties };
}

/** Dispatches an event on an element and returns it, so a test can read `defaultPrevented`. */
export function dispatch(element, type, properties = {}) {
  const event = element.ownerDocument.createEvent(type, eventProperties(type, properties));
  element.dispatchEvent(event);
  return event;
}

/** The descendants of `root` whose attribute `name` equals `value`. */
export function allByAttribute(root, name, value) {
  return root.descendants().filter(element => element.getAttribute(name) === value);
}

/** The one descendant of `root` with this aria-label, or an error that lists what is there. */
export function byLabel(root, label) {
  const matches = allByAttribute(root, 'aria-label', label);
  if (matches.length !== 1) {
    const known = root.descendants().map(element => element.getAttribute('aria-label')).filter(Boolean);
    throw new Error(`Expected one element labelled "${label}", found ${matches.length}. Labels: ${known.join(' | ')}`);
  }
  return matches[0];
}

/** The one descendant whose dataset key equals value, such as byDataset(root, 'tool', 'rotate'). */
export function byDataset(root, key, value) {
  const matches = root.descendants().filter(element => element.dataset[key] === value);
  if (matches.length !== 1) {
    throw new Error(`Expected one element with data-${key}="${value}", found ${matches.length}.`);
  }
  return matches[0];
}

/** The one button-like descendant whose own text is exactly `text`. */
export function byText(root, text) {
  const matches = root.descendants().filter(element => element.ownText === text);
  if (matches.length !== 1) {
    throw new Error(`Expected one element with text "${text}", found ${matches.length}.`);
  }
  return matches[0];
}
