import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeLanguage, enhanceCodeBlocks } from '../src/site-code.js';

function fakeCodeElement(text, { dataset = {}, classes = [], closestMap = {} } = {}) {
  const classSet = new Set(classes);
  return {
    textContent: text,
    innerHTML: text,
    dataset: { ...dataset },
    classList: {
      add: (...names) => names.forEach(name => classSet.add(name)),
      contains: name => classSet.has(name),
      [Symbol.iterator]: () => classSet.values(),
    },
    matches: selector => selector.split(',').some(part => {
      const trimmed = part.trim();
      if (trimmed.startsWith('.')) return classSet.has(trimmed.slice(1));
      if (trimmed === '[data-no-highlight]') return dataset.noHighlight !== undefined;
      return false;
    }),
    closest: selector => closestMap[selector] ?? null,
    querySelector: () => null,
  };
}

test('detectCodeLanguage uses explicit attributes, command context, and JSON/XML/JS syntax', () => {
  assert.equal(detectCodeLanguage(fakeCodeElement('{"a": 1}', { dataset: { language: 'json' } })), 'json');
  assert.equal(detectCodeLanguage(fakeCodeElement('npm install crucible', { closestMap: { '.command-row, .command': {} } })), 'shell');
  assert.equal(detectCodeLanguage(fakeCodeElement('{"mcpServers": {"crucible-scene": {"command": "npx"}}}')), 'json');
  assert.equal(detectCodeLanguage(fakeCodeElement('<crucible-scene></crucible-scene>')), 'xml');
  assert.equal(detectCodeLanguage(fakeCodeElement("import { Glaze } from '@codepawlhq/crucible';")), 'javascript');
  assert.equal(detectCodeLanguage(fakeCodeElement('not valid json {')), null);
  assert.equal(detectCodeLanguage(fakeCodeElement('{"a": 1}', { dataset: { noHighlight: '1' } })), null);
});

test('enhanceCodeBlocks highlights code blocks once and mounts an SVG copy icon cleanly', () => {
  const jsonCode = fakeCodeElement('{"ok": true}');
  let listeners = [];
  const children = ['Copy'];
  const copyButton = {
    dataset: { copy: 'npm i @codepawlhq/crucible' },
    querySelector: () => (children.some(child => child?.tagName === 'svg') ? children[0] : null),
    prepend: node => children.unshift(node),
    addEventListener: (event, handler) => listeners.push({ event, handler }),
  };

  const previousDocument = globalThis.document;
  globalThis.document = {
    createElementNS: (_namespace, tagName) => {
      const attributes = new Map();
      const childNodes = [];
      return {
        tagName,
        setAttribute: (key, value) => attributes.set(key, value),
        getAttribute: key => attributes.get(key),
        append: (...nodes) => childNodes.push(...nodes),
      };
    },
  };
  try {
    const root = {
      querySelectorAll: selector => {
        if (selector.includes('.code-block')) return [jsonCode];
        if (selector.includes('data-copy')) return [copyButton];
        return [];
      },
    };
    enhanceCodeBlocks(root);
    assert.ok(jsonCode.classList.contains('hljs'));
    assert.ok(jsonCode.classList.contains('language-json'));
    assert.match(jsonCode.innerHTML, /hljs-attr/);
    assert.equal(children[0].tagName, 'svg');
    assert.equal(copyButton.dataset.copyBound, '1');
    assert.equal(listeners.length, 1);

    // Calling a second time is idempotent and adds neither duplicate icon nor duplicate listener.
    enhanceCodeBlocks(root);
    assert.equal(children.filter(child => child?.tagName === 'svg').length, 1);
    assert.equal(listeners.length, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});
