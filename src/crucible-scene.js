// <crucible-scene src="scene.pack" poster="poster.webp">: the runtime of `crucible pack` (docs/pack.md).
// It shows the poster at once, loads the packed scene and the renderer, then swaps the canvas in. It imports no
// agent-scene module: the recipe was compiled ahead of time, so the page pays for the renderer and nothing else.
import { decodePack } from './scene-pack-format.js';
import { loadPackShaderModules } from './scene-pack-shaders.js';
import { TriggerAnimator, applyViewToCamera, parseHoverTiltAttribute, parseScrollAttribute, parseViews, scrollProgress } from './scene-triggers.js';
import { partsWithImageData } from './scene-pack-images.js';
import { createPackEnvironmentMap } from './scene-pack-environment.js';

export const SCENE_STATES = Object.freeze(['loading', 'live', 'error']);

const TEMPLATE = `
<style>
  :host { display: block; position: relative; overflow: hidden; background: #111; }
  canvas, img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  img { object-fit: cover; transition: opacity 240ms ease; }
  canvas { opacity: 0; transition: opacity 240ms ease; }
  :host([state="live"]) canvas { opacity: 1; }
  :host([state="live"]) img { opacity: 0; pointer-events: none; }
</style>
<img part="poster" alt="" hidden>
<canvas part="canvas"></canvas>
`;

async function fetchPack(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`<crucible-scene src="${url}"> answered ${response.status}; point src at the scene.pack that crucible pack wrote.`);
  return decodePack(await response.arrayBuffer());
}

// The renderer and its lighting load after the poster is on screen, so the first paint never waits for them.
async function createLiveRenderer(canvas, scene) {
  const [{ CrucibleRenderer }, map] = await Promise.all([
    import('./renderer.js'),
    createPackEnvironmentMap(scene),
    loadPackShaderModules(scene.shaderModules),
  ]);
  const environment = { ...scene.environment, map };
  // Baked lightmaps arrive as plain bytes; the renderer uploads ImageData.
  const hasBlendedWater = scene.parts.some(part => part.material.tag === 'water' && part.material.alphaMode === 'blend');
  const renderer = new CrucibleRenderer(canvas, partsWithImageData(scene.parts), {
    ground: false,
    hdr: true,
    compactColor: !hasBlendedWater,
    depth: true,
    world: scene.environment.world,
    environment,
    shadowBounds: scene.shadowBounds,
  });
  return { renderer, environment };
}

// The package is imported in Node too (server rendering, the package smoke), where there is no DOM;
// the element only registers in a browser.
const ElementBase = typeof HTMLElement === 'undefined' ? class {} : HTMLElement;

export class CrucibleSceneElement extends ElementBase {
  static observedAttributes = ['src', 'poster', 'scroll', 'hover-tilt', 'view'];

  #renderer = null;
  #frame = null;
  #resizeObserver = null;
  #triggers = null;
  #loadToken = 0;
  // An element that upgrades after parsing gets its attributes before connectedCallback; only a change after the first load reloads.
  #started = false;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = TEMPLATE;
  }

  connectedCallback() {
    this.#started = true;
    this.#showPoster();
    this.#load();
  }

  disconnectedCallback() {
    this.#started = false;
    this.#dispose();
  }

  attributeChangedCallback(name) {
    if (!this.#started) return;
    if (name === 'poster') this.#showPoster();
    if (name === 'src') this.#load();
    if (name === 'view') this.#triggers?.changeView();
    if (name === 'scroll' || name === 'hover-tilt') this.#triggers?.configure();
  }

  get state() {
    return this.getAttribute('state');
  }

  #showPoster() {
    const image = this.shadowRoot.querySelector('img');
    const poster = this.getAttribute('poster');
    image.hidden = !poster;
    if (poster) image.src = poster;
  }

  #dispose() {
    this.#loadToken += 1;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#triggers?.stop();
    this.#triggers = null;
    if (this.#frame !== null) cancelAnimationFrame(this.#frame);
    this.#frame = null;
    this.#renderer?.dispose?.();
    this.#renderer = null;
  }

  async #load() {
    this.#dispose();
    const token = this.#loadToken;
    const source = this.getAttribute('src');
    this.setAttribute('state', 'loading');
    try {
      if (!source) throw new Error('<crucible-scene> needs a src attribute: the scene.pack that crucible pack wrote.');
      const scene = await fetchPack(source);
      const canvas = this.shadowRoot.querySelector('canvas');
      const { renderer, environment } = await createLiveRenderer(canvas, scene);
      if (token !== this.#loadToken) {
        renderer.dispose?.();
        return;
      }
      this.#renderer = renderer;
      this.#startDrawing(scene, environment);
      this.setAttribute('state', 'live');
      this.dispatchEvent(new CustomEvent('crucible-scene-ready', { detail: { parts: scene.parts.length } }));
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.setAttribute('state', 'error');
      this.dispatchEvent(new CustomEvent('crucible-scene-error', { detail: { message: error.message } }));
    }
  }

  // A still scene draws again only when the element changes size, or while a trigger is still moving the camera.
  #startDrawing(scene, environment) {
    const schedule = () => {
      if (this.#frame === null) this.#frame = requestAnimationFrame(draw);
    };
    const triggers = new SceneTriggers(this, schedule, message => this.#reportTriggerError(message));
    const draw = now => {
      this.#frame = null;
      this.#renderer.resize();
      const { camera, animating } = triggers.frame(scene.camera, now);
      this.#renderer.render({ ...camera, environment, effects: scene.effects, exposure: scene.effects.exposure, time: 0 });
      if (animating) schedule();
    };
    this.#triggers = triggers;
    triggers.configure();
    this.#resizeObserver = new ResizeObserver(schedule);
    this.#resizeObserver.observe(this);
    schedule();
  }

  // A bad trigger attribute is reported and ignored: the scene keeps drawing, so state stays "live".
  #reportTriggerError(message) {
    this.dispatchEvent(new CustomEvent('crucible-scene-error', { detail: { message } }));
  }
}

/** Reads the trigger attributes of one element, listens only for what they ask and asks for a frame when something moves. */
class SceneTriggers {
  #element;
  #schedule;
  #report;
  #animator = new TriggerAnimator();
  #visibilityObserver = null;
  #listening = false;
  #cleanups = [];

  constructor(element, schedule, report) {
    this.#element = element;
    this.#schedule = schedule;
    this.#report = report;
  }

  configure() {
    this.stop();
    const element = this.#element;
    const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const animator = new TriggerAnimator({ reducedMotion });
    this.#animator = animator;
    const attempt = action => {
      try {
        action();
      } catch (error) {
        this.#report(error.message);
      }
    };
    attempt(() => { if (element.hasAttribute('scroll')) animator.scroll = parseScrollAttribute(element.getAttribute('scroll')); });
    attempt(() => { if (element.hasAttribute('hover-tilt')) animator.hoverTilt = parseHoverTiltAttribute(element.getAttribute('hover-tilt')); });
    attempt(() => {
      const declaration = element.querySelector('script[type="application/json"]');
      if (declaration) animator.views = parseViews(declaration.textContent);
    });
    attempt(() => { if (element.hasAttribute('view')) animator.setViewName(element.getAttribute('view')); });
    if (animator.scroll) this.#watchScroll();
    if (animator.hoverTilt > 0) this.#watchPointer(reducedMotion);
    this.#schedule();
  }

  // A new view name moves the camera there with the ease; the other values stay as they are.
  changeView() {
    try {
      this.#animator.setViewName(this.#element.getAttribute('view'));
    } catch (error) {
      this.#report(error.message);
    }
    this.#schedule();
  }

  stop() {
    this.#visibilityObserver?.disconnect();
    this.#visibilityObserver = null;
    for (const cleanup of this.#cleanups) cleanup();
    this.#cleanups = [];
  }

  frame(camera, now) {
    const animator = this.#animator;
    if (animator.scroll) animator.setProgress(scrollProgress(this.#element.getBoundingClientRect(), window.innerHeight));
    const { view, animating } = animator.advance(now);
    return { camera: applyViewToCamera(camera, view), animating };
  }

  // The scroll listener exists only while the element is on screen.
  #watchScroll() {
    const onScroll = () => this.#schedule();
    this.#visibilityObserver = new IntersectionObserver(entries => {
      const visible = entries.some(entry => entry.isIntersecting);
      if (visible === this.#listening) return;
      this.#listening = visible;
      if (visible) window.addEventListener('scroll', onScroll, { passive: true });
      else window.removeEventListener('scroll', onScroll);
      this.#schedule();
    });
    this.#visibilityObserver.observe(this.#element);
    this.#cleanups.push(() => {
      window.removeEventListener('scroll', onScroll);
      this.#listening = false;
    });
  }

  #watchPointer(reducedMotion) {
    if (reducedMotion) return;
    const element = this.#element;
    const onMove = event => {
      const box = element.getBoundingClientRect();
      this.#animator.setPointer({ x: ((event.clientX - box.left) / box.width) * 2 - 1, y: ((event.clientY - box.top) / box.height) * 2 - 1 });
      this.#schedule();
    };
    const onLeave = () => {
      this.#animator.setPointer(null);
      this.#schedule();
    };
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerleave', onLeave);
    this.#cleanups.push(() => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerleave', onLeave);
    });
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('crucible-scene')) {
  customElements.define('crucible-scene', CrucibleSceneElement);
}
