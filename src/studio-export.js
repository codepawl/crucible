// The panel of the Export workspace: one group for each thing Studio writes (a picture, a model, a web pack), each with the
// facts about what will be written, one action and the result of the last run. It holds no export code; studio.js wires the actions.

const KIND_ROWS = Object.freeze([
  Object.freeze({ id: 'image', title: 'Image', icon: 'image', action: 'Save PNG' }),
  Object.freeze({ id: 'model', title: 'Model', icon: 'node', action: 'Save GLB' }),
  Object.freeze({ id: 'pack', title: 'Web pack', icon: 'globe', action: 'Save pack' }),
]);
const FRAME_LONG_SIDE = 36;
const FRAME_SHORT_SIDE_LEAST = 8;
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

// The picture of the output's shape: a small rectangle with the aspect of the image that will be saved.
function frameShape(width, height) {
  const longer = Math.max(width, height);
  const scale = FRAME_LONG_SIDE / longer;
  return { inlineSize: Math.max(FRAME_SHORT_SIDE_LEAST, Math.round(width * scale)), blockSize: Math.max(FRAME_SHORT_SIDE_LEAST, Math.round(height * scale)) };
}

export function createExportPanel({ documentReference, createElement, createIcon }) {
  const parts = {};
  for (const kind of KIND_ROWS) {
    const heading = createElement(documentReference, 'div', { className: 'crucible-studio-export-heading' }, createIcon(kind.icon), createElement(documentReference, 'span', { textContent: kind.title }));
    const facts = createElement(documentReference, 'div', { className: 'crucible-studio-export-facts' });
    const action = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-export-action', dataset: { export: kind.id } },
      createIcon('export'),
      createElement(documentReference, 'span', { textContent: kind.action }),
    );
    const result = createElement(documentReference, 'div', { className: 'crucible-studio-export-result', attributes: { role: 'status', hidden: '' } });
    const group = createElement(documentReference, 'section', { className: 'crucible-studio-export-group', dataset: { kind: kind.id }, attributes: { 'aria-label': kind.title } }, heading, facts, action, result);
    parts[kind.id] = { group, facts, action, result };
  }
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-export-body' }, ...KIND_ROWS.map(kind => parts[kind.id].group));

  function chipFor(fact) {
    if (fact.frame) {
      const shape = frameShape(...fact.frame);
      const picture = createElement(documentReference, 'span', { className: 'crucible-studio-export-frame' });
      picture.style.inlineSize = `${shape.inlineSize}px`;
      picture.style.blockSize = `${shape.blockSize}px`;
      return createElement(documentReference, 'span', { className: 'crucible-studio-export-fact', attributes: { 'aria-hidden': 'true' } }, picture);
    }
    return createElement(documentReference, 'span', { className: 'crucible-studio-export-fact' }, ...(fact.icon ? [createIcon(fact.icon)] : []), createElement(documentReference, 'span', { textContent: fact.text }));
  }

  const shownKeys = {};
  /** Replaces the facts of one kind. Each fact is `{ text, icon? }`, or `{ frame: [width, height] }` for the shape of the picture. Unchanged facts are left alone. */
  function showFacts(kindId, facts) {
    const key = JSON.stringify(facts);
    if (shownKeys[kindId] === key) return;
    shownKeys[kindId] = key;
    parts[kindId].facts.replaceChildren(...facts.map(chipFor));
  }

  /** The line under an action: a check for a file that was written, a warning for one that was not. */
  function showResult(kindId, { ok, text }) {
    const { result } = parts[kindId];
    result.dataset.state = ok ? 'ok' : 'failed';
    result.replaceChildren(createIcon(ok ? 'check' : 'warning'), createElement(documentReference, 'span', { textContent: text }));
    result.removeAttribute('hidden');
  }

  function clearResults() {
    for (const kind of KIND_ROWS) {
      parts[kind.id].result.setAttribute('hidden', '');
      parts[kind.id].result.replaceChildren();
    }
  }

  return {
    element,
    actions: { image: parts.image.action, model: parts.model.action, pack: parts.pack.action },
    showFacts,
    showResult,
    clearResults,
  };
}
