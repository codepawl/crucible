import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio, STUDIO_PRIMITIVES } from '../src/studio.js';
import { STUDIO_CSS } from '../src/studio-styles.js';
import {
  STUDIO_BRAND_ICON_NAMES,
  STUDIO_FILLED_ICON_NAMES,
  STUDIO_ICON_PATHS,
  STUDIO_LIGHT_ICONS,
  STUDIO_NOTICE_ICONS,
  STUDIO_PRIMITIVE_ICONS,
  STUDIO_PROPERTY_SECTION_ICONS,
} from '../src/studio-icons.js';
import { PROPERTY_SECTIONS } from '../src/studio-properties.js';
import { byDataset, byText, createFakeRenderer, installStudioDom } from './support/studio-dom.mjs';

const ARGUMENT_COUNTS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

/** Every point a stroke path visits, so a glyph that leaves the 24 unit box is caught. */
function pathPoints(pathData) {
  const points = [];
  let currentX = 0;
  let currentY = 0;
  for (const [, command, argumentText] of pathData.matchAll(/([a-zA-Z])([^a-zA-Z]*)/gu)) {
    const numbers = (argumentText.match(/-?(?:\d+\.?\d*|\.\d+)/gu) ?? []).map(Number);
    const lower = command.toLowerCase();
    const relative = command === lower;
    const count = ARGUMENT_COUNTS[lower];
    for (let offset = 0; offset === 0 || offset + count <= numbers.length; offset += Math.max(count, 1)) {
      const chunk = numbers.slice(offset, offset + count);
      if (lower === 'z') break;
      let nextX = currentX;
      let nextY = currentY;
      if (lower === 'h') nextX = relative ? currentX + chunk[0] : chunk[0];
      else if (lower === 'v') nextY = relative ? currentY + chunk[0] : chunk[0];
      else {
        nextX = relative ? currentX + chunk.at(-2) : chunk.at(-2);
        nextY = relative ? currentY + chunk.at(-1) : chunk.at(-1);
      }
      currentX = nextX;
      currentY = nextY;
      points.push([currentX, currentY]);
    }
  }
  return points;
}

function mountStudio(testContext) {
  const dom = installStudioDom();
  const studio = createStudio(dom.container, { renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
  });
  return { dom, studio, root: dom.container.firstElementChild };
}

test('every shape of the basic add menu, every light and every notice outcome has a drawn icon', () => {
  for (const shape of STUDIO_PRIMITIVES) {
    assert.ok(STUDIO_ICON_PATHS[STUDIO_PRIMITIVE_ICONS[shape]], `${shape} has an icon`);
  }
  assert.deepEqual(Object.keys(STUDIO_LIGHT_ICONS).sort(), ['area', 'point', 'spot']);
  for (const iconName of [...Object.values(STUDIO_LIGHT_ICONS), ...Object.values(STUDIO_NOTICE_ICONS)]) {
    assert.ok(STUDIO_ICON_PATHS[iconName], `${iconName} resolves`);
  }
  assert.deepEqual(Object.keys(STUDIO_NOTICE_ICONS).sort(), ['error', 'info', 'success', 'warning']);
  assert.equal(new Set(Object.values(STUDIO_NOTICE_ICONS)).size, 4, 'each outcome has its own shape');
});

test('the shapes of the add menu do not share a glyph', () => {
  const iconNames = STUDIO_PRIMITIVES.map(shape => STUDIO_PRIMITIVE_ICONS[shape]);
  assert.equal(new Set(iconNames).size, iconNames.length);
  assert.equal(new Set(iconNames.map(name => STUDIO_ICON_PATHS[name])).size, iconNames.length);
});

test('every property section has an icon that resolves', () => {
  for (const sectionId of Object.keys(PROPERTY_SECTIONS)) {
    assert.ok(STUDIO_ICON_PATHS[STUDIO_PROPERTY_SECTION_ICONS[sectionId]], `${sectionId} has an icon`);
  }
  assert.deepEqual(Object.keys(STUDIO_PROPERTY_SECTION_ICONS).sort(), Object.keys(PROPERTY_SECTIONS).sort());
});

test('stroke glyph paths stay inside the 24 unit box', () => {
  for (const [name, pathData] of Object.entries(STUDIO_ICON_PATHS)) {
    if (STUDIO_BRAND_ICON_NAMES.includes(name)) continue;
    for (const [x, y] of pathPoints(pathData)) {
      assert.ok(x >= 0 && x <= 24 && y >= 0 && y <= 24, `${name} has a point at ${x}, ${y}`);
    }
  }
});

test('add menu entries lead with their icon and keep their label as the name', testContext => {
  const { root } = mountStudio(testContext);
  const addPopover = root.querySelector('#crucible-studio-pop-add');
  for (const label of [...STUDIO_PRIMITIVES.map(shape => (shape === 'icoSphere' ? 'Icosphere' : shape === 'disc' ? 'Circle' : shape[0].toUpperCase() + shape.slice(1))), 'Point light', 'Spot light', 'Area light']) {
    const entry = byText(addPopover, label);
    assert.equal(entry.querySelectorAll('svg').length, 1, `${label} has one icon`);
    assert.equal(entry.querySelector('svg').getAttribute('aria-hidden'), 'true');
    assert.equal(entry.firstElementChild.tagName.toLowerCase(), 'svg', `${label} leads with its icon`);
    assert.equal(entry.getAttribute('aria-label'), null, `${label} keeps its visible text as its name`);
  }
});

test('the add menu is one column, so every label starts at the same x and the menu is no wider than its longest entry', () => {
  assert.ok(STUDIO_CSS.includes('#crucible-studio-pop-add .crucible-studio-popover-grid { grid-template-columns: minmax(0, 1fr); }'));
});

test('each property section title carries its chevron and exactly one section icon', async testContext => {
  const { dom, root, studio } = mountStudio(testContext);
  studio.controller.addPrimitive('box');
  await dom.settle();
  const titles = [];
  for (const tab of ['node', 'look', 'camera']) {
    byDataset(root, 'tab', tab).click();
    titles.push(...root.querySelectorAll('.crucible-studio-property-title'));
  }
  assert.ok(titles.length > 0);
  for (const title of titles) {
    assert.equal(title.querySelectorAll('.crucible-studio-chevron').length, 1);
    assert.equal(title.querySelectorAll('.crucible-studio-section-icon').length, 1);
    assert.equal(title.querySelectorAll('svg').length, 2);
  }
  assert.ok(byDataset(root, 'section', 'transform').querySelector('.crucible-studio-section-icon'));
});

test('the dialog titles carry exactly one icon', testContext => {
  const { root } = mountStudio(testContext);
  const headings = root.querySelectorAll('dialog h2');
  assert.ok(headings.length >= 3, 'recipe, shortcuts and settings dialogs');
  for (const heading of headings) {
    assert.equal(heading.querySelectorAll('svg').length, 1, heading.textContent);
  }
});

test('the notice under the top bar leads with a mark per outcome', async testContext => {
  const { dom, root } = mountStudio(testContext);
  const status = root.querySelector('.crucible-studio-status');
  const markOf = () => status.querySelector('svg').querySelector('path').getAttribute('d');
  byText(root.querySelector('#crucible-studio-pop-add'), 'Box').click();
  await dom.settle();
  assert.equal(status.getAttribute('data-outcome'), 'success');
  assert.equal(markOf(), STUDIO_ICON_PATHS.check);
  root.querySelectorAll('button').find(button => button.getAttribute('aria-label') === 'Play (Space)').click();
  assert.equal(status.getAttribute('data-outcome'), 'warning');
  assert.equal(markOf(), STUDIO_ICON_PATHS.warning);
  assert.equal(status.textContent, 'Add a keyframe first (K)');
});

test('the error mark is a solid disc and the other outcomes stay outlines, and the light marks differ from the sun', () => {
  assert.deepEqual([...STUDIO_FILLED_ICON_NAMES], ['error']);
  assert.ok(STUDIO_FILLED_ICON_NAMES.includes(STUDIO_NOTICE_ICONS.error));
  const lightPaths = Object.values(STUDIO_LIGHT_ICONS).map(name => STUDIO_ICON_PATHS[name]);
  assert.equal(new Set([...lightPaths, STUDIO_ICON_PATHS.sun]).size, 4, 'point, spot, area and the sun each draw their own glyph');
});

test('the icon colour is a mix of existing tokens and the status icons and section icons use it', () => {
  assert.ok(STUDIO_CSS.includes('--studio-icon: color-mix(in srgb, var(--studio-text) 78%, var(--studio-panel));'));
  assert.ok(STUDIO_CSS.includes('.crucible-studio-property-title .crucible-studio-section-icon { color: var(--studio-icon); stroke-width: 2; }'));
  assert.ok(STUDIO_CSS.includes('.crucible-studio-status .crucible-studio-icon { color: var(--studio-icon); }'));
});

test('every dialog title icon has one size and one stroke weight', () => {
  const ruleStart = STUDIO_CSS.indexOf('.crucible-studio dialog h2 .crucible-studio-icon {');
  const rule = STUDIO_CSS.slice(ruleStart, STUDIO_CSS.indexOf('}', ruleStart));
  assert.ok(rule.includes('inline-size: 18px;') && rule.includes('block-size: 18px;') && rule.includes('stroke-width: 1.9;'));
});
