// Shared look for the sliders that live examples add to their result frame.
// Examples create a bare `<input type="range">` and keep their own layout; this stylesheet and script give every one of them
// the site's dark brand tokens, a visible value, and hover and focus-visible states, so no example restyles its own slider.
// The frame is a separate document, so the tokens are written out here (the stage is dark in light mode too).

const controlTokens = {
  panel: '#201f24ee',
  text: '#f1f0ec',
  muted: '#a09ea6',
  track: '#fefefd24',
  accent: '#fc9132',
  accentHover: '#ffb25e',
};

export const frameControlStyle = `
.crucible-panel { background: ${controlTokens.panel} !important; color: ${controlTokens.text} !important; border-radius: 14px !important; padding: 8px 14px !important; font: 500 12px/1.4 Inter, system-ui, sans-serif !important; backdrop-filter: blur(12px); max-width: calc(100vw - 24px); box-sizing: border-box; }
.crucible-control { display: flex !important; align-items: center; gap: 12px !important; color: ${controlTokens.text}; font: 500 12px/1.4 Inter, system-ui, sans-serif; }
.crucible-value { flex: none; min-width: 3.5ch; text-align: right; font-variant-numeric: tabular-nums; color: ${controlTokens.accent}; }
input[type=range][data-crucible-range] { --fill: 0%; flex: 1 1 120px; width: 100%; min-width: 96px; max-width: 220px; height: 24px; margin: 0; background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none; }
input[type=range][data-crucible-range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(90deg, ${controlTokens.accent} var(--fill), ${controlTokens.track} var(--fill)); }
input[type=range][data-crucible-range]::-moz-range-track { height: 4px; border-radius: 2px; background: ${controlTokens.track}; }
input[type=range][data-crucible-range]::-moz-range-progress { height: 4px; border-radius: 2px; background: ${controlTokens.accent}; }
input[type=range][data-crucible-range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border: 0; border-radius: 50%; background: ${controlTokens.text}; box-shadow: 0 0 0 0 ${controlTokens.accent}55; transition: box-shadow 110ms ease, background-color 110ms ease; }
input[type=range][data-crucible-range]::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: ${controlTokens.text}; transition: box-shadow 110ms ease, background-color 110ms ease; }
input[type=range][data-crucible-range]:hover::-webkit-slider-thumb, input[type=range][data-crucible-range]:active::-webkit-slider-thumb { background: ${controlTokens.accentHover}; box-shadow: 0 0 0 5px ${controlTokens.accent}33; }
input[type=range][data-crucible-range]:hover::-moz-range-thumb, input[type=range][data-crucible-range]:active::-moz-range-thumb { background: ${controlTokens.accentHover}; box-shadow: 0 0 0 5px ${controlTokens.accent}33; }
input[type=range][data-crucible-range]:focus { outline: none; }
input[type=range][data-crucible-range]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px #17161a, 0 0 0 5px ${controlTokens.accent}; }
input[type=range][data-crucible-range]:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 3px #17161a, 0 0 0 5px ${controlTokens.accent}; }
@media (prefers-reduced-motion: reduce) { input[type=range][data-crucible-range]::-webkit-slider-thumb, input[type=range][data-crucible-range]::-moz-range-thumb { transition: none; } }
`;

// Runs inside the frame. It marks each slider, adds a value label, and keeps both in step with the slider.
export const frameControlScript = `
  let rangeCounter = 0;
  const enhanceRange = slider => {
    if (slider.dataset.crucibleRange) return;
    slider.dataset.crucibleRange = 'true';
    const stepSize = slider.step === 'any' ? 0.001 : Number(slider.step || 1);
    const decimals = stepSize > 0 ? (Number(stepSize.toFixed(10)).toString().split('.')[1] || '').length : 0;
    const value = document.createElement('output');
    value.className = 'crucible-value';
    if (!slider.id) slider.id = 'crucible-range-' + (++rangeCounter);
    value.htmlFor = slider.id;
    let shownValue = null;
    const refresh = () => {
      if (slider.value === shownValue) return;
      shownValue = slider.value;
      const minimum = Number(slider.min || 0);
      const maximum = Number(slider.max || 100);
      const fraction = maximum > minimum ? (Number(slider.value) - minimum) / (maximum - minimum) : 0;
      slider.style.setProperty('--fill', Math.round(fraction * 100) + '%');
      value.textContent = Number(slider.value).toFixed(decimals);
      slider.setAttribute('aria-valuetext', value.textContent);
    };
    let panel = slider.parentElement;
    if (getComputedStyle(slider).position === 'fixed') {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;left:12px;bottom:12px;display:flex;align-items:center;gap:12px';
      const name = slider.getAttribute('aria-label');
      if (name) panel.append(Object.assign(document.createElement('span'), { textContent: name }));
      slider.before(panel);
      panel.append(slider);
      slider.style.position = 'static';
      slider.style.width = '';
    }
    slider.after(value);
    panel.classList.add('crucible-control');
    for (let ancestor = panel; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).position === 'fixed') ancestor.classList.add('crucible-panel');
    }
    // Examples also set slider.value in code (a playing timeline, a starting value), which fires no event.
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(slider, 'value', {
      configurable: true,
      get() { return nativeValue.get.call(slider); },
      set(newValue) {
        nativeValue.set.call(slider, newValue);
        refresh();
      },
    });
    slider.addEventListener('input', refresh);
    slider.addEventListener('change', refresh);
    refresh();
  };
  const enhanceRanges = () => document.querySelectorAll('input[type=range]').forEach(enhanceRange);
  new MutationObserver(records => {
    if (records.some(record => record.addedNodes.length > 0)) enhanceRanges();
  }).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('load', enhanceRanges);
`;

export { attachOrbitControls as attachFrameOrbitControls, createOrbitController as createFrameOrbitController } from './orbit-controller.js';

export const ORBIT_CONTROL_BINDINGS = Object.freeze({
  orbit: 'Left-drag',
  pan: 'Right-drag / Middle-drag / Shift-drag',
  zoom: 'Wheel',
  move: 'WASD / Arrows / Q / E',
  reset: 'R / Double-click',
});

export const frameOrbitControlScript = `
  const applyStyle = () => {
    document.querySelectorAll('canvas').forEach(canvasElement => {
      canvasElement.style.touchAction = 'none';
      if (!canvasElement.hasAttribute('tabindex')) canvasElement.tabIndex = 0;
    });
  };
  new MutationObserver(records => {
    if (records.some(record => record.addedNodes.length > 0)) applyStyle();
  }).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('load', applyStyle);
`;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => HTML_ESCAPES[character]);
}

export function revokeImportUrls(imports, revokeUrl = URL.revokeObjectURL) {
  for (const url of Object.values(imports ?? {})) revokeUrl(url);
}
