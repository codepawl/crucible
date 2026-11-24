// Studio trees: the tree controls of the inspector. They write the recipe field `vegetation` that agents write, so a
// tree edited here opens the same over MCP. Studio loads this file the first time a tree node is selected, so the core
// entry carries none of it.
import { TREE_PRESETS } from './vegetation-presets.js';
import { SPECIES } from './vegetation-species.js';

export const TREE_HEIGHT_RANGE = Object.freeze({ min: 0.5, max: 30, step: 0.1 });
export const TREE_SEASON_RANGE = Object.freeze({ min: 0, max: 1, step: 0.01 });
export const TREE_LEAF_DENSITY_RANGE = Object.freeze({ min: 0.5, max: 20, step: 0.5 });

const SEED_CEILING = 100000;

/** The vegetation field of a node that grows exactly one tree, or null for any other node. */
export function singleTreeOf(node) {
  const vegetation = node?.vegetation;
  if (!vegetation || vegetation.mix || vegetation.scatter) {
    return null;
  }
  return vegetation.preset || vegetation.species ? vegetation : null;
}

function speciesOf(vegetation) {
  return vegetation.preset ? TREE_PRESETS[vegetation.preset].species : vegetation.species;
}

function middleOf(range) {
  return (range[0] + range[1]) / 2;
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

/** The height the tree grows to when the recipe sets none: the middle of its preset or species range. */
export function defaultTreeHeight(vegetation) {
  const presetRange = vegetation.preset ? TREE_PRESETS[vegetation.preset].height : null;
  return middleOf(presetRange ?? SPECIES[speciesOf(vegetation)].height);
}

/** The leaf sites per metre of twig the tree grows with when the recipe sets none. */
export function defaultLeafDensity(vegetation) {
  const presetTree = vegetation.preset ? TREE_PRESETS[vegetation.preset].tree : null;
  return presetTree?.leafCount ?? SPECIES[speciesOf(vegetation)].leaf.sitesPerMeter;
}

/** The values the inspector controls show for one tree. */
export function treeControlValues(vegetation) {
  return {
    height: vegetation.height ?? roundTo(defaultTreeHeight(vegetation), TREE_HEIGHT_RANGE.step),
    season: vegetation.season ?? 0,
    leafDensity: vegetation.tree?.leafCount ?? defaultLeafDensity(vegetation),
    seed: vegetation.seed ?? 1,
  };
}

/** The vegetation field after one control moved; every other field of it stays as it was. */
export function vegetationAfterChange(vegetation, change) {
  const { leafDensity, ...direct } = change;
  const next = { ...vegetation, ...direct };
  if (leafDensity !== undefined) {
    next.tree = { ...vegetation.tree, leafCount: leafDensity };
  }
  return next;
}

/** A seed other than the current one, whole and small enough to type. */
export function nextTreeSeed(currentSeed, random = Math.random) {
  let seed = currentSeed;
  while (seed === currentSeed) {
    seed = 1 + Math.floor(random() * SEED_CEILING);
  }
  return seed;
}

/** Writes one control change into a tree node through the same edit path as the other inspector fields. */
export function changeSelectedTree(controller, nodeId, change) {
  const node = controller.exportRecipe().nodes.find(candidate => candidate.id === nodeId);
  const vegetation = singleTreeOf(node);
  if (!vegetation) {
    throw new RangeError(`Node "${nodeId}" does not grow a single tree.`);
  }
  controller.updateNodeTransform(nodeId, { vegetation: vegetationAfterChange(vegetation, change) });
}

/** The tree rows of the node panel: height, leaf density, season and a seed with a new seed button. */
export function createTreeInspector({ documentReference, createElement, createSliderField, controller, announce }) {
  const write = change => {
    const nodeId = controller.selectedNodeId;
    if (!nodeId) {
      return;
    }
    try {
      changeSelectedTree(controller, nodeId, change);
    } catch (error) {
      announce(error.message);
    }
  };
  const heightField = createSliderField(documentReference, 'Height m', { ...TREE_HEIGHT_RANGE, value: 10 }, height => write({ height }));
  const leafField = createSliderField(documentReference, 'Leaf density', { ...TREE_LEAF_DENSITY_RANGE, value: 5 }, leafDensity => write({ leafDensity }));
  const seasonField = createSliderField(documentReference, 'Season', { ...TREE_SEASON_RANGE, value: 0 }, season => write({ season }));
  const seedInput = createElement(documentReference, 'input', { type: 'number', min: '-2147483648', max: '2147483647', step: '1', attributes: { 'aria-label': 'Seed' } });
  const newSeedButton = createElement(documentReference, 'button', { type: 'button', textContent: 'New seed' });
  const newSeedChips = createElement(documentReference, 'div', { className: 'crucible-studio-chips' }, newSeedButton);
  seedInput.addEventListener('change', () => {
    const seed = Number(seedInput.value);
    if (Number.isInteger(seed)) {
      write({ seed });
    }
  });
  newSeedButton.addEventListener('click', () => write({ seed: nextTreeSeed(Number(seedInput.value)) }));
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-tree-controls' },
    createElement(documentReference, 'span', { className: 'crucible-studio-field-head', textContent: 'Tree' }),
    heightField.container,
    seasonField.container,
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-field' },
      createElement(documentReference, 'div', { className: 'crucible-studio-field-head' }, createElement(documentReference, 'span', { textContent: 'Seed' })),
      createElement(documentReference, 'div', { className: 'crucible-studio-tree-seed' }, seedInput, newSeedChips),
    ),
    leafField.container,
  );
  element.hidden = true;
  return {
    element,
    /** Shows the rows for a node that grows one tree and hides them for any other. */
    sync(node) {
      const vegetation = singleTreeOf(node);
      element.hidden = !vegetation;
      if (!vegetation) {
        return;
      }
      const values = treeControlValues(vegetation);
      heightField.setValue(values.height);
      leafField.setValue(values.leafDensity);
      seasonField.setValue(values.season);
      seedInput.value = String(values.seed);
    },
  };
}
