import { createPropertyLine } from './studio-property-panel.js';
import { CONVERTIBLE_PRIMITIVES, planOwnMesh } from './studio-own-mesh.js';

// The Modifiers tab of the Properties editor. Blender keeps modifiers in a Properties tab as a stack of collapsible panels, each
// with a header (name, show in viewport, apply, delete, move) and its main fields, and an Add Modifier menu above them. This panel
// is the same list for the five modifiers people use every day, written to the stack of the selected mesh (`set-mesh-stack`).
// Every change is one scene operation batch, so it is one undo step; a shape of the Add menu becomes a mesh in the same step.

// The bounds of the recipe (mesh-subdivide.js, mesh-bevel.js, mesh-recipe.js), kept here because those modules are large and the
// panel is part of the core entry. tests/studio-modifier-panel.test.js keeps them equal to the recipe's own.
export const MODIFIER_LIMITS = Object.freeze({ subdivisionLevels: 4, bevelSegments: 16, arrayCount: 256, distance: 1000, maxStackNodes: 16 });

const ADD_PLACEHOLDER = 'Add Modifier';
const NO_SELECTION = 'Select a shape or a mesh to give it modifiers.';
const NO_MESH = 'This object has no mesh to modify. Select a shape or a mesh.';
const VECTOR_PRECISION = 1000;

const AXIS_CHOICES = Object.freeze(['x', 'y', 'z'].map(axis => Object.freeze({ value: axis, label: axis.toUpperCase() })));

// What each modifier writes when added, and the fields it shows. `fallback` is what the recipe assumes for a field the node leaves out.
const MODIFIERS = Object.freeze({
  subdivide: Object.freeze({
    title: 'Subdivision',
    create: () => ({ op: 'subdivide', levels: 1 }),
    fields: [{ key: 'levels', label: 'Levels', control: 'integer', min: 1, max: MODIFIER_LIMITS.subdivisionLevels, fallback: () => 1 }],
  }),
  mirror: Object.freeze({
    title: 'Mirror',
    create: () => ({ op: 'mirror', axis: 'x', merge: 0.001 }),
    fields: [
      { key: 'axis', label: 'Axis', control: 'choice', choices: AXIS_CHOICES, fallback: () => 'x' },
      { key: 'merge', label: 'Merge distance', control: 'number', min: 0, max: MODIFIER_LIMITS.distance, step: 0.001, fallback: () => 0.001 },
    ],
  }),
  array: Object.freeze({
    title: 'Array',
    create: () => ({ op: 'array', count: 2, relativeOffset: [1, 0, 0] }),
    fields: [
      { key: 'count', label: 'Count', control: 'integer', min: 1, max: MODIFIER_LIMITS.arrayCount, fallback: () => 2 },
      { key: 'relativeOffset', label: 'Relative offset', control: 'vector', fallback: node => (node.offset === undefined ? [1, 0, 0] : [0, 0, 0]) },
      { key: 'offset', label: 'Constant offset', control: 'vector', fallback: () => [0, 0, 0] },
      { key: 'merge', label: 'Merge distance', control: 'number', min: 0, max: MODIFIER_LIMITS.distance, step: 0.001, fallback: () => 0 },
    ],
  }),
  bevel: Object.freeze({
    title: 'Bevel',
    create: () => ({ op: 'bevel', width: 0.05, segments: 2 }),
    fields: [
      { key: 'width', label: 'Width', control: 'number', min: 0, exclusiveMinimum: true, max: MODIFIER_LIMITS.distance, step: 0.01, fallback: () => 0.05 },
      { key: 'segments', label: 'Segments', control: 'integer', min: 1, max: MODIFIER_LIMITS.bevelSegments, fallback: () => 1 },
      { key: 'profile', label: 'Profile', control: 'number', min: 0, max: 1, step: 0.05, fallback: () => 0.5 },
    ],
  }),
  solidify: Object.freeze({
    title: 'Solidify',
    create: () => ({ op: 'solidify', thickness: 0.1 }),
    fields: [
      { key: 'thickness', label: 'Thickness', control: 'number', min: 0, exclusiveMinimum: true, max: MODIFIER_LIMITS.distance, step: 0.01, fallback: () => 0.1 },
      { key: 'offset', label: 'Offset', control: 'number', min: -1, max: 1, step: 0.1, fallback: () => -1 },
      { key: 'evenThickness', label: 'Even thickness', control: 'toggle', fallback: () => true },
    ],
  }),
});

export const MODIFIER_NAMES = Object.freeze(Object.keys(MODIFIERS));

// A modifier an agent wrote that this panel has no fields for still shows, switches and moves; its name is its operation.
function titleOf(node) {
  if (MODIFIERS[node.op]) return MODIFIERS[node.op].title;
  const words = node.op.replaceAll('_', ' ');
  return words[0].toUpperCase() + words.slice(1);
}

function fieldValue(node, field) {
  return node[field.key] ?? field.fallback(node);
}

/** The geometry of the selected node when it can carry a stack (a mesh or a shape that becomes one), or why it cannot. */
function stackTargetOf(recipe, nodeId) {
  if (!nodeId) return { refusal: NO_SELECTION };
  const node = recipe.nodes.find(candidate => candidate.id === nodeId);
  const spec = recipe.geometries?.find(candidate => candidate.id === node?.geometry);
  if (!spec || (spec.type !== 'mesh' && !CONVERTIBLE_PRIMITIVES.has(spec.type))) return { refusal: NO_MESH };
  return { nodeId, geometryId: spec.id, stack: spec.type === 'mesh' ? spec.stack ?? [] : [] };
}

/**
 * The Modifiers tab: an Add Modifier menu and one collapsible section per node of the stack of the selected object.
 * `builders` are the control builders of studio.js ({ createElement, createIcon, createIconButton, createVectorRow }).
 * `sync` re-reads the recipe, so an edit an agent makes or an undo shows up there.
 */
export function createModifierPanel({ documentReference, controller, announce, builders }) {
  const { createElement, createIcon, createIconButton, createVectorRow } = builders;
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-modifiers' });
  const addSelect = createElement(documentReference, 'select', {
    className: 'crucible-studio-modifier-add',
    attributes: { 'aria-label': ADD_PLACEHOLDER },
  }, createElement(documentReference, 'option', { value: '', textContent: ADD_PLACEHOLDER }), ...MODIFIER_NAMES.map(operation => createElement(documentReference, 'option', { value: operation, textContent: MODIFIERS[operation].title })));
  const emptyMessage = createElement(documentReference, 'p', { className: 'crucible-studio-modifier-empty' });
  const list = createElement(documentReference, 'div', { className: 'crucible-studio-modifier-list' });
  element.append(createElement(documentReference, 'div', { className: 'crucible-studio-modifier-bar' }, createIcon(documentReference, 'modifiers'), addSelect), emptyMessage, list);

  let shownKey = null;
  let sections = [];
  let target = { refusal: NO_SELECTION };
  // Sections a person folded, by geometry and position, so a fold survives edits of the stack.
  const folded = new Set();
  // The section a drag started on; the section under the pointer carries data-drop while a drag is over it.
  let draggedIndex = null;

  function endDrag() {
    draggedIndex = null;
    for (const section of sections) delete section.container.dataset.drop;
  }

  function markDropTarget(index) {
    for (const section of sections) delete section.container.dataset.drop;
    if (index !== draggedIndex) sections[index].container.dataset.drop = index < draggedIndex ? 'before' : 'after';
  }

  function currentTarget() {
    return stackTargetOf(controller.exportRecipe(), controller.selectedNodeId);
  }

  // Applies the new stack as one batch. A shape becomes a mesh of its own first, and a mesh a twin shares is copied, in the same step.
  // The recipe checks the values; what it refuses is told to the person and the controls go back to the recipe.
  function writeStack(nextStack, { apply = 0 } = {}) {
    const recipe = controller.exportRecipe();
    const nodeId = target.nodeId;
    try {
      const own = planOwnMesh(recipe, nodeId);
      const stackOperation = { type: 'set-mesh-stack', geometry: own.geometryId, stack: nextStack, ...(apply > 0 ? { apply } : {}) };
      controller.applyImportOperations([...own.operations, stackOperation], { detail: { kind: 'topology', nodeId } });
    } catch (error) {
      announce(error.message);
      sync();
    }
  }

  const replaceAt = (index, node) => target.stack.map((existing, position) => (position === index ? node : existing));

  function commitField(index, field, value) {
    const node = { ...target.stack[index], [field.key]: value };
    writeStack(replaceAt(index, node));
  }

  function numberControl(index, field) {
    const input = createElement(documentReference, 'input', {
      type: 'number',
      min: String(field.min),
      max: String(field.max),
      step: String(field.control === 'integer' ? 1 : field.step),
      attributes: { 'aria-label': field.label },
    });
    input.addEventListener('change', () => {
      const typed = Number(input.value);
      if (input.value === '' || !Number.isFinite(typed)) {
        sync();
        return;
      }
      commitField(index, field, typed);
    });
    const unitMark = createElement(documentReference, 'span', { className: 'crucible-studio-prop-unit', attributes: { 'aria-hidden': 'true' } });
    return { container: createPropertyLine(documentReference, createElement, field.label, input, unitMark), setValue: value => { input.value = String(value); } };
  }

  function choiceControl(index, field) {
    const select = createElement(documentReference, 'select', { attributes: { 'aria-label': field.label } },
      ...field.choices.map(choice => createElement(documentReference, 'option', { value: choice.value, textContent: choice.label })));
    select.addEventListener('change', () => commitField(index, field, select.value));
    return { container: createPropertyLine(documentReference, createElement, field.label, select), setValue: value => { select.value = value; } };
  }

  function toggleControl(index, field) {
    const knob = createElement(documentReference, 'span', { className: 'crucible-studio-switch-knob', attributes: { 'aria-hidden': 'true' } });
    const button = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-switch',
      attributes: { role: 'switch', 'aria-checked': 'false', 'aria-label': field.label },
    }, knob);
    button.addEventListener('click', () => commitField(index, field, button.getAttribute('aria-checked') !== 'true'));
    return { container: createPropertyLine(documentReference, createElement, field.label, button), setValue: value => button.setAttribute('aria-checked', value ? 'true' : 'false') };
  }

  function vectorControl(index, field) {
    const row = createVectorRow(documentReference, field.label, values => commitField(index, field, values), { accessibleTitle: field.label });
    return { container: row.container, setValue: values => row.setValues(values, VECTOR_PRECISION) };
  }

  const CONTROL_BUILDERS = { integer: numberControl, number: numberControl, choice: choiceControl, toggle: toggleControl, vector: vectorControl };

  function headerButton(iconName, label, action) {
    return createIconButton(documentReference, iconName, label, { dataset: { action } });
  }

  // A row of the block menu: the icon and the word, since the three actions are not worth a header button each.
  function menuItem(iconName, label, action) {
    const item = createElement(documentReference, 'button', { type: 'button', dataset: { action }, attributes: { role: 'menuitem' } }, createIcon(documentReference, iconName), createElement(documentReference, 'span', { textContent: label }));
    item.setAttribute('aria-disabled', 'false');
    return item;
  }

  function buildSection(node, index) {
    const modifier = MODIFIERS[node.op];
    const title = titleOf(node);
    const foldKey = `${target.geometryId}:${index}`;
    const fieldRows = (modifier?.fields ?? []).map(field => ({ field, ...CONTROL_BUILDERS[field.control](index, field) }));
    const rows = createElement(documentReference, 'div', { className: 'crucible-studio-property-rows' }, ...fieldRows.map(row => {
      row.container.dataset.field = row.field.key;
      return row.container;
    }));
    const titleButton = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-modifier-title',
      attributes: { 'aria-expanded': 'true' },
    }, createIcon(documentReference, 'chevron'), createElement(documentReference, 'span', { textContent: title }));
    const visibility = createElement(documentReference, 'button', {
      type: 'button',
      className: 'crucible-studio-switch',
      attributes: { role: 'switch', 'aria-checked': 'true', 'aria-label': `Show ${title} in viewport` },
      dataset: { action: 'enable' },
    }, createElement(documentReference, 'span', { className: 'crucible-studio-switch-knob', attributes: { 'aria-hidden': 'true' } }));
    const up = menuItem('minimize', 'Move up', 'up');
    const down = menuItem('expand', 'Move down', 'down');
    const apply = menuItem('check', 'Apply', 'apply');
    const menu = createElement(documentReference, 'div', { className: 'crucible-studio-modifier-menu', hidden: true, attributes: { role: 'menu', 'aria-label': `${title} actions` } }, up, down, apply);
    const menuButton = createIconButton(documentReference, 'more', `${title} actions`, { attributes: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
    const remove = headerButton('remove', `Delete ${title}`, 'remove');
    const grip = createIconButton(documentReference, 'grip', `Drag ${title} to reorder`, { className: 'crucible-studio-modifier-grip', draggable: true, dataset: { action: 'drag' } });
    const head = createElement(documentReference, 'div', { className: 'crucible-studio-modifier-head' }, grip, titleButton, visibility, menuButton, remove);
    const container = createElement(documentReference, 'div', { className: 'crucible-studio-modifier', dataset: { op: node.op, index: String(index) } }, head, menu, rows);

    const showOpen = open => {
      container.dataset.open = open ? 'true' : 'false';
      titleButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      rows.hidden = !open;
    };
    showOpen(!folded.has(foldKey));
    titleButton.addEventListener('click', () => {
      const open = container.dataset.open !== 'true';
      if (open) folded.delete(foldKey);
      else folded.add(foldKey);
      showOpen(open);
    });
    const setMenuOpen = open => {
      menu.hidden = !open;
      menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    menuButton.addEventListener('click', () => setMenuOpen(menu.hidden));
    menu.addEventListener('click', () => setMenuOpen(false));
    visibility.addEventListener('click', () => {
      const { enabled, ...rest } = target.stack[index];
      writeStack(replaceAt(index, enabled === false ? rest : { ...rest, enabled: false }));
    });
    const swap = other => {
      const next = [...target.stack];
      [next[index], next[other]] = [next[other], next[index]];
      writeStack(next);
    };
    up.addEventListener('click', () => index > 0 && swap(index - 1));
    down.addEventListener('click', () => index < target.stack.length - 1 && swap(index + 1));
    // As in Blender, Apply bakes this modifier into the mesh as if it were first; the ones around it stay in the stack.
    apply.addEventListener('click', () => (target.stack[index].enabled === false ? announce(`Switch ${title} on to apply it, or delete it.`) : writeStack([target.stack[index], ...target.stack.filter((_, position) => position !== index)], { apply: 1 })));
    grip.addEventListener('dragstart', event => {
      draggedIndex = index;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData?.('text/plain', String(index));
      }
    });
    grip.addEventListener('dragend', endDrag);
    container.addEventListener('dragover', event => {
      if (draggedIndex === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      markDropTarget(index);
    });
    container.addEventListener('drop', event => {
      if (draggedIndex === null) return;
      event.preventDefault();
      const from = draggedIndex;
      endDrag();
      if (from === index) return;
      const next = [...target.stack];
      next.splice(index, 0, ...next.splice(from, 1));
      writeStack(next);
    });
    remove.addEventListener('click', () => writeStack(target.stack.filter((_, position) => position !== index)));
    return { container, fieldRows, visibility, up, down, apply };
  }

  function rebuild() {
    sections = target.stack.map(buildSection);
    list.replaceChildren(...sections.map(section => section.container));
  }

  function setDisabled(button, disabled, reason) {
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (disabled && reason) button.title = reason;
  }

  function showValues() {
    const last = target.stack.length - 1;
    sections.forEach((section, index) => {
      const node = target.stack[index];
      const enabled = node.enabled !== false;
      section.container.dataset.enabled = enabled ? 'true' : 'false';
      section.visibility.setAttribute('aria-checked', enabled ? 'true' : 'false');
      setDisabled(section.up, index === 0);
      setDisabled(section.down, index === last);
      for (const row of section.fieldRows) row.setValue(fieldValue(node, row.field));
    });
  }

  function sync() {
    target = currentTarget();
    element.dataset.state = target.refusal ? 'empty' : 'ready';
    emptyMessage.hidden = !target.refusal;
    emptyMessage.textContent = target.refusal ?? '';
    const full = !target.refusal && target.stack.length >= MODIFIER_LIMITS.maxStackNodes;
    addSelect.disabled = Boolean(target.refusal) || full;
    addSelect.title = full ? `A stack holds at most ${MODIFIER_LIMITS.maxStackNodes} modifiers.` : '';
    // The sections are drawn again only when the stack changes shape; a value edit leaves them, and the focus in them, alone.
    const key = target.refusal ? 'none' : `${target.nodeId}|${target.geometryId}|${target.stack.map(node => node.op).join(',')}`;
    if (key !== shownKey) {
      shownKey = key;
      if (target.refusal) list.replaceChildren();
      else rebuild();
    }
    if (!target.refusal) showValues();
  }

  addSelect.addEventListener('change', () => {
    const operation = addSelect.value;
    addSelect.value = '';
    if (!MODIFIERS[operation] || target.refusal) return;
    writeStack([...target.stack, MODIFIERS[operation].create()]);
  });

  return { element, sync };
}
