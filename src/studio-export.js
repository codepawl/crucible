// The panel of the Export workspace: one group for each thing Studio writes (a picture, a model, a web pack), each with the
// facts about what will be written, one action and the result of the last run. It holds no export code; studio.js wires the actions.

const KIND_ROWS = Object.freeze([
  Object.freeze({ id: 'image', title: 'Image', icon: 'image', action: 'Save PNG' }),
  Object.freeze({ id: 'model', title: 'Model', icon: 'node', action: 'Save GLB' }),
  Object.freeze({ id: 'pack', title: 'Web pack', icon: 'globe', action: 'Save pack' }),
]);
const KILOBYTE = 1024;
const MEGABYTE = KILOBYTE * KILOBYTE;

/** A byte count as a person reads it: 812 B, 49 KB, 1.2 MB. */
export function formatFileSize(byteCount) {
  if (byteCount < KILOBYTE) return `${byteCount} B`;
  if (byteCount < MEGABYTE) return `${Math.round(byteCount / KILOBYTE)} KB`;
  return `${(byteCount / MEGABYTE).toFixed(1)} MB`;
}

/** How many bytes a `data:` URL carries once decoded, without decoding it. */
export function dataUrlByteLength(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.floor((encoded.length * 3) / 4) - padding;
}

/** The last name in a path a host returns, so a folder or a file is shown by its own name. */
export function lastPathName(path) {
  return String(path).split(/[\/]/).filter(Boolean).at(-1) ?? String(path);
}

export function createExportPanel({ documentReference, createElement, createIcon }) {
  const parts = {};
  for (const kind of KIND_ROWS) {
    const heading = createElement(documentReference, 'div', { className: 'crucible-studio-export-heading' }, createIcon(kind.icon), createElement(documentReference, 'span', { textContent: kind.title }));
    const facts = createElement(documentReference, 'div', { className: 'crucible-studio-export-facts' });
    const action = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-export-action', textContent: kind.action, dataset: { export: kind.id } });
    // The line under the button is for the eye; the status region below says the same to a screen reader.
    const result = createElement(documentReference, 'div', { className: 'crucible-studio-export-result', attributes: { hidden: '', 'aria-hidden': 'true' } });
    const group = createElement(documentReference, 'section', { className: 'crucible-studio-export-group', dataset: { kind: kind.id }, attributes: { 'aria-label': kind.title } }, heading, facts, action, result);
    parts[kind.id] = { group, facts, action, result };
  }
  // Always in the page and never hidden, so a screen reader has it registered before the first message: only its text changes.
  const status = createElement(documentReference, 'div', { className: 'crucible-studio-export-status', attributes: { role: 'status' } });
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-export-body' }, ...KIND_ROWS.map(kind => parts[kind.id].group), status);

  function chipFor(fact) {
    if (fact.frame) {
      const [width, height] = fact.frame;
      const picture = createElement(documentReference, 'span', { className: 'crucible-studio-export-frame', dataset: { tall: String(height > width) }, attributes: { role: 'img', 'aria-label': 'Shape of the picture' } });
      picture.style.aspectRatio = `${width} / ${height}`;
      return createElement(documentReference, 'span', { className: 'crucible-studio-export-fact' }, picture);
    }
    return createElement(documentReference, 'span', { className: 'crucible-studio-export-fact', dataset: { warning: String(Boolean(fact.icon === 'warning')) } }, ...(fact.icon ? [createIcon(fact.icon)] : []), createElement(documentReference, 'span', { textContent: fact.text }));
  }

  const shownKeys = {};
  /** Replaces the facts of one kind. Each fact is `{ text, icon? }`, or `{ frame: [width, height] }` for the shape of the picture. Unchanged facts are left alone. */
  function showFacts(kindId, facts) {
    const key = JSON.stringify(facts);
    if (shownKeys[kindId] === key) return;
    shownKeys[kindId] = key;
    parts[kindId].facts.replaceChildren(...facts.map(chipFor));
  }

  /** A kind that cannot be saved right now: its button is disabled and its facts line says why. */
  function setBlocked(kindId, blocked) {
    if (blocked) parts[kindId].action.setAttribute('aria-disabled', 'true');
    else parts[kindId].action.removeAttribute('aria-disabled');
  }

  /** Runs `handler` when the kind's button is pressed, unless the kind is blocked. A new run clears the line of the last one first. */
  function onAction(kindId, handler) {
    parts[kindId].action.addEventListener('click', event => {
      if (parts[kindId].action.getAttribute('aria-disabled') === 'true') return;
      clearResult(kindId);
      return handler(event);
    });
  }

  /** The line under an action: a check for a file that was written, a warning for one that was not. */
  function showResult(kindId, { ok, text }) {
    const { result } = parts[kindId];
    result.dataset.state = ok ? 'ok' : 'failed';
    result.replaceChildren(createIcon(ok ? 'check' : 'warning'), createElement(documentReference, 'span', { textContent: text }));
    result.removeAttribute('hidden');
    status.textContent = text;
  }

  function clearResult(kindId) {
    parts[kindId].result.setAttribute('hidden', '');
    parts[kindId].result.replaceChildren();
  }

  function clearResults() {
    for (const kind of KIND_ROWS) clearResult(kind.id);
    status.textContent = '';
  }

  function hasResults() {
    return KIND_ROWS.some(kind => !parts[kind.id].result.hasAttribute('hidden'));
  }

  return { element, onAction, showFacts, setBlocked, showResult, clearResult, clearResults, hasResults };
}
