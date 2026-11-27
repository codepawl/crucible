import { highlightElement } from './code-highlight.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const COPIED_DURATION_MILLISECONDS = 1600;
const JAVASCRIPT_START_PATTERN = /^(?:import|export|const|let|function|async|class)\s/;
const CODE_SELECTOR = '.command-row code, .command code, .code-block, pre code';
const COPY_BUTTON_SELECTOR = 'button[data-copy], button[data-copy-code], .command-row button';

/** Creates the shared clipboard SVG icon element. */
export function createCopyIcon() {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'site-copy-icon');
  svg.setAttribute('aria-hidden', 'true');
  const front = document.createElementNS(SVG_NAMESPACE, 'rect');
  front.setAttribute('x', '9');
  front.setAttribute('y', '9');
  front.setAttribute('width', '13');
  front.setAttribute('height', '13');
  front.setAttribute('rx', '2');
  const back = document.createElementNS(SVG_NAMESPACE, 'path');
  back.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');
  svg.append(front, back);
  return svg;
}

/** Creates the shared check SVG icon shown briefly after copying. */
export function createCheckIcon() {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'site-copy-icon site-check-icon');
  svg.setAttribute('aria-hidden', 'true');
  const mark = document.createElementNS(SVG_NAMESPACE, 'path');
  mark.setAttribute('d', 'M20 6 9 17l-5-5');
  svg.append(mark);
  return svg;
}

/** Infers highlight language from attributes, container role, or source syntax; returns null when unknown or opted out. */
export function detectCodeLanguage(element) {
  if (!element) return null;
  if (typeof element.matches === 'function' && element.matches('.live-console, .live-editor, .live-editor *, [data-no-highlight]')) return null;
  if (typeof element.closest === 'function' && element.closest('.live-editor, [data-no-highlight]')) return null;

  const explicit = element.dataset?.language ?? element.dataset?.lang;
  if (explicit) return explicit;

  if (element.classList) {
    for (const name of element.classList) {
      if (name.startsWith('language-') && name.length > 'language-'.length) {
        return name.slice('language-'.length);
      }
    }
  }

  if (typeof element.closest === 'function' && element.closest('.command-row, .command')) return 'shell';

  const trimmed = String(element.textContent ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith('<')) return 'xml';
  if (JAVASCRIPT_START_PATTERN.test(trimmed)) return 'javascript';
  return null;
}

/** Copies `text` to the clipboard and temporarily swaps the button icon and label to a check confirmation. */
export async function copyTextWithFeedback(button, text, copiedLabel = 'Copied', sourceElement = null) {
  if (!button._originalCopyNodes) {
    button._originalCopyNodes = [...button.childNodes];
  }
  const originalNodes = button._originalCopyNodes;
  if (button._copyResetTimer) {
    clearTimeout(button._copyResetTimer);
  }
  try {
    await navigator.clipboard.writeText(text);
    button.replaceChildren(createCheckIcon(), document.createTextNode(copiedLabel));
  } catch {
    if (sourceElement && typeof getSelection === 'function') {
      getSelection().selectAllChildren(sourceElement);
    }
    button.textContent = 'Copy failed';
  }
  button._copyResetTimer = setTimeout(() => {
    button.replaceChildren(...originalNodes);
    button._copyResetTimer = null;
  }, COPIED_DURATION_MILLISECONDS);
}

function resolveCopyPayload(button) {
  if (button.dataset?.copy !== undefined) {
    return { text: button.dataset.copy, sourceElement: null };
  }
  const targetId = button.dataset?.copyCode;
  if (targetId && typeof document !== 'undefined') {
    const target = document.getElementById(targetId);
    if (target) return { text: target.textContent ?? '', sourceElement: target };
  }
  const holder = typeof button.closest === 'function'
    ? button.closest('.command-row, .command, .code-wrap, .code-block')
    : null;
  const source = holder?.querySelector('code, pre') ?? null;
  return { text: source?.textContent ?? '', sourceElement: source };
}

/** Highlights unhighlighted code/command elements and mounts copy icons + handlers inside `root`. */
export function enhanceCodeBlocks(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  for (const element of root.querySelectorAll(CODE_SELECTOR)) {
    if (element.classList?.contains('code-block') && element.querySelector('pre, code')) continue;
    const sourceText = element.textContent ?? '';
    if (element.classList?.contains('hljs') && element.dataset?.highlightedText === sourceText) continue;
    const language = detectCodeLanguage(element);
    if (!language) continue;
    highlightElement(element, language);
    if (element.dataset) element.dataset.highlightedText = sourceText;
  }

  for (const button of root.querySelectorAll(COPY_BUTTON_SELECTOR)) {
    if (!button.querySelector('svg') && typeof button.prepend === 'function') {
      button.prepend(createCopyIcon());
    }
    if (button.dataset?.copyBound) continue;
    if (button.dataset) button.dataset.copyBound = '1';
    button.addEventListener('click', () => {
      const { text, sourceElement } = resolveCopyPayload(button);
      const copiedLabel = button.dataset?.copiedLabel || 'Copied';
      void copyTextWithFeedback(button, text, copiedLabel, sourceElement);
    });
  }
}

/** Runs `enhanceCodeBlocks` on `root` immediately and whenever dynamic content is added. */
export function observeCodeBlocks(root = typeof document !== 'undefined' ? document.body : null) {
  if (!root) return null;
  enhanceCodeBlocks(root);
  if (typeof MutationObserver !== 'function') return null;

  let enhancing = false;
  let queued = false;
  const runPass = () => {
    queued = false;
    if (enhancing) return;
    enhancing = true;
    try {
      enhanceCodeBlocks(root);
    } finally {
      enhancing = false;
    }
  };
  const observer = new MutationObserver(() => {
    if (enhancing || queued) return;
    queued = true;
    queueMicrotask(runPass);
  });
  observer.observe(root, { childList: true, subtree: true });
  return observer;
}
