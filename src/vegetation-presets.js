// Named tree presets and the growth parameters that tune them (#2992). This module is data and pure functions only:
// the tree builder, the recipe check and the scene_capabilities note all read it, so the three cannot drift apart.
//
// A preset is a base species of vegetation-species.js plus overrides. The tree keeps the base as its `species`, so
// level gains, seasons, scanned textures and packs keyed by species still apply. The parameter set follows the idea of
// ez-tree's options (github.com/dgreenheck/ez-tree, MIT): levels, angle, children, length, radius, gnarliness, twist,
// a growth force and leaf count, size and start. No code or numbers are copied from it.

const DEGREES = Math.PI / 180;
const FULL_TURN = Math.PI * 2;

/** The most branch generations past the trunk a tree may grow. */
export const MAX_TREE_LEVELS = 4;
/** The most branches one tree may grow, counted from the largest child counts, so a tree fails before it grows. */
export const MAX_TREE_BRANCHES = 4000;
/** The most leaf sites one tree may carry; growth stops with an error past it. */
export const MAX_TREE_LEAF_SITES = 20000;

// `list` says what a list of values per level starts with: 'sprout' lists start at the first branches off the trunk,
// 'shape' lists start at the trunk. A single number applies to every level.
export const TREE_PARAMETERS = Object.freeze({
  levels: Object.freeze({ minimum: 1, maximum: MAX_TREE_LEVELS, whole: true, example: 3, about: 'branch generations past the trunk' }),
  branches: Object.freeze({ minimum: 1, maximum: 60, whole: true, list: 'sprout', example: 7, about: 'child branches per parent (all branches on the trunk for a whorled conifer)' }),
  branchAngle: Object.freeze({ minimum: 5, maximum: 120, list: 'sprout', example: 55, about: 'degrees between a branch and its parent' }),
  branchStart: Object.freeze({ minimum: 0, maximum: 0.95, list: 'sprout', example: 0.3, about: 'fraction along the parent where branches begin' }),
  lengthFalloff: Object.freeze({ minimum: 0.05, maximum: 1.5, list: 'sprout', example: 0.5, about: 'branch length against its parent' }),
  radiusFalloff: Object.freeze({ minimum: 0.05, maximum: 1, list: 'sprout', example: 0.55, about: 'branch radius against the parent where it sprouts' }),
  gnarliness: Object.freeze({ minimum: 0, maximum: 0.6, list: 'shape', example: 0.15, about: 'how much a branch wanders' }),
  twist: Object.freeze({ minimum: -1, maximum: 1, list: 'shape', example: 0.2, about: 'turns a branch and its children spiral over its length' }),
  tropism: Object.freeze({ minimum: -0.5, maximum: 0.5, list: 'shape', example: 0.05, about: 'pull toward growthDirection per step; negative droops away from it' }),
  growthDirection: Object.freeze({ vector: true, example: [0.3, 1, 0], about: 'direction branches grow toward, such as the sun side; gravity is a negative tropism' }),
  crownShape: Object.freeze({ choices: Object.freeze(['round', 'cone', 'column', 'umbrella']), example: 'round', about: 'how branch length changes up the trunk' }),
  leafCount: Object.freeze({ minimum: 0.5, maximum: 20, example: 5, about: 'leaf sites per metre of twig' }),
  leafSize: Object.freeze({ minimum: 0.25, maximum: 3, example: 1, about: 'leaf and leaf card size against the species' }),
  leafStart: Object.freeze({ minimum: 0, maximum: 0.95, example: 0.2, about: 'fraction along a twig where leaves begin' }),
});

const CROWN_PROFILES = Object.freeze({ round: 'crown', cone: 'cone', column: 'column', umbrella: 'umbrella' });

// Each preset is a small JSON object: the base species, an optional height range in metres and growth overrides.
export const TREE_PRESETS = Object.freeze({
  oak: Object.freeze({
    label: 'Oak', species: 'broadleaf', height: [9, 13],
    tree: { crownShape: 'round', branches: [7, 4, 3], branchAngle: [68, 55, 50], lengthFalloff: [0.58, 0.5], gnarliness: [0.1, 0.22, 0.26, 0.28], leafCount: 6 },
  }),
  ash: Object.freeze({
    label: 'Ash', species: 'broadleaf', height: [12, 16],
    tree: { crownShape: 'round', branches: [9, 3, 3], branchAngle: [40, 42, 45], branchStart: [0.42], lengthFalloff: [0.44, 0.55], gnarliness: [0.05, 0.1, 0.14, 0.18], tropism: [0.02, 0.12, 0.06, 0], leafSize: 0.85, leafCount: 5 },
  }),
  aspen: Object.freeze({
    label: 'Aspen', species: 'birch', height: [11, 15],
    tree: { crownShape: 'column', branches: [14, 3, 3], branchAngle: [38, 45, 50], branchStart: [0.45], lengthFalloff: [0.18, 0.5], gnarliness: [0.03, 0.1, 0.12, 0.14], tropism: [0.02, 0.1, 0, -0.08], leafSize: 0.75, leafCount: 6 },
  }),
  birch: Object.freeze({ label: 'Birch', species: 'birch', tree: {} }),
  pine: Object.freeze({
    label: 'Pine', species: 'conifer', height: [12, 17],
    tree: { crownShape: 'umbrella', branches: [44, 9], branchAngle: [74, 55], branchStart: [0.55, 0.2], lengthFalloff: [0.4, 0.35], gnarliness: [0.03, 0.12, 0.1], tropism: [0, 0.08, 0.04], leafStart: 0.4 },
  }),
  palm: Object.freeze({ label: 'Palm', species: 'palm', tree: {} }),
  bush: Object.freeze({ label: 'Bush', species: 'bush', tree: {} }),
});

function describeRange(parameter) {
  return `${parameter.whole ? 'a whole number ' : 'a number '}from ${parameter.minimum} to ${parameter.maximum}`;
}

function checkNumber(value, parameter, path, fail) {
  if (typeof value !== 'number' || !(value >= parameter.minimum && value <= parameter.maximum) || (parameter.whole && !Number.isInteger(value))) {
    fail(path, value, `${describeRange(parameter)}, such as ${parameter.example}`);
  }
  return value;
}

function checkPerLevel(value, parameter, path, levelCount, fail) {
  if (!Array.isArray(value)) return checkNumber(value, parameter, path, fail);
  const entries = parameter.list === 'shape' ? levelCount + 1 : levelCount;
  const first = parameter.list === 'shape' ? 'the trunk' : 'the first branches off the trunk';
  if (value.length < 1 || value.length > entries) {
    fail(path, value, `one number, or a list of 1 to ${entries} numbers starting at ${first} (this tree has ${levelCount} branch levels), such as ${parameter.example}`);
  }
  return value.map((entry, index) => checkNumber(entry, parameter, `${path}[${index}]`, fail));
}

function checkVector(value, path, fail) {
  const valid = Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) && Math.hypot(...value) > 1e-6;
  if (!valid) fail(path, value, '[x, y, z] that is not zero, such as [0.3, 1, 0]');
  const length = Math.hypot(...value);
  return value.map(component => component / length);
}

/**
 * Check growth overrides and return a clean copy. `baseLevels` is the branch level count of the species or preset they
 * apply to; `fail(path, value, expected)` must throw, so the library and the recipe can each word the error their way.
 */
export function checkTreeGrowth(tree, baseLevels, fail, path = 'tree') {
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) fail(path, tree, 'an object of growth parameters, such as { "branchAngle": 50 }');
  const names = Object.keys(TREE_PARAMETERS);
  for (const key of Object.keys(tree)) {
    if (!names.includes(key)) fail(`${path}.${key}`, tree[key], `no such parameter; use one of ${names.join(', ')}`);
  }
  const result = {};
  if (tree.levels !== undefined) result.levels = checkNumber(tree.levels, TREE_PARAMETERS.levels, `${path}.levels`, fail);
  const levelCount = result.levels ?? baseLevels;
  for (const [name, parameter] of Object.entries(TREE_PARAMETERS)) {
    const value = tree[name];
    if (value === undefined || name === 'levels') continue;
    if (parameter.vector) result[name] = checkVector(value, `${path}.${name}`, fail);
    else if (parameter.choices) {
      if (!parameter.choices.includes(value)) fail(`${path}.${name}`, value, `one of ${parameter.choices.join(', ')}`);
      result[name] = value;
    } else if (parameter.list) result[name] = checkPerLevel(value, parameter, `${path}.${name}`, levelCount, fail);
    else result[name] = checkNumber(value, parameter, `${path}.${name}`, fail);
  }
  return result;
}

function valueAt(value, index) {
  if (Array.isArray(value)) return value[index];
  return value;
}

function cloneLevel(level) {
  const copy = { ...level };
  if (level.children) copy.children = { ...level.children };
  return copy;
}

// Grow or cut the level list to `levelCount` branch generations. A new generation copies the sprouting of the one
// before the last and the shape of the last, so it reads as more of the same tree.
function resizeLevels(levels, levelCount) {
  const resized = levels.slice(0, levelCount + 1).map(cloneLevel);
  delete resized[resized.length - 1].children;
  while (resized.length < levelCount + 1) {
    const last = resized[resized.length - 1];
    const template = levels[Math.max(0, Math.min(resized.length - 2, levels.length - 2))].children;
    const { profile, whorls, perWhorl, ...sprouting } = template;
    last.children = whorls ? { ...sprouting, count: perWhorl } : sprouting;
    const next = cloneLevel(last);
    delete next.children;
    resized.push(next);
  }
  return resized;
}

function setBranchCount(children, count) {
  if (children.whorls) {
    const perWhorl = (children.perWhorl[0] + children.perWhorl[1]) / 2;
    children.whorls = Math.max(1, Math.round(count / perWhorl));
    return;
  }
  const halfWidth = (children.count[1] - children.count[0]) / 2;
  children.count = [Math.max(1, count - halfWidth), count + halfWidth];
}

function applySprouting(children, tree, index) {
  const count = valueAt(tree.branches, index);
  if (count !== undefined) setBranchCount(children, count);
  const angle = valueAt(tree.branchAngle, index);
  if (angle !== undefined) {
    const halfWidth = (children.angle[1] - children.angle[0]) / 2;
    children.angle = [Math.max(0.01, angle * DEGREES - halfWidth), angle * DEGREES + halfWidth];
  }
  const start = valueAt(tree.branchStart, index);
  if (start !== undefined) {
    children.start = start;
    children.end = Math.max(children.end, start);
  }
  const lengthRatio = valueAt(tree.lengthFalloff, index);
  if (lengthRatio !== undefined) {
    const scale = lengthRatio / ((children.lengthRatio[0] + children.lengthRatio[1]) / 2);
    children.lengthRatio = children.lengthRatio.map(ratio => ratio * scale);
  }
  const radiusRatio = valueAt(tree.radiusFalloff, index);
  if (radiusRatio !== undefined) children.radiusRatio = radiusRatio;
}

function applyShape(level, tree, index) {
  const gnarl = valueAt(tree.gnarliness, index);
  if (gnarl !== undefined) level.gnarl = gnarl;
  const tropism = valueAt(tree.tropism, index);
  if (tropism !== undefined) level.tropism = tropism;
  const twist = valueAt(tree.twist, index);
  if (twist) level.twist = twist * FULL_TURN;
  if (tree.growthDirection) level.growthDirection = tree.growthDirection;
}

function applyLeaves(leaf, tree) {
  const result = { ...leaf };
  if (tree.leafCount !== undefined) result.sitesPerMeter = tree.leafCount;
  if (tree.leafStart !== undefined) result.start = tree.leafStart;
  if (tree.leafSize !== undefined) {
    result.meshLength = leaf.meshLength * tree.leafSize;
    result.meshWidth = leaf.meshWidth * tree.leafSize;
    result.cardSize = leaf.cardSize.map(size => size * tree.leafSize);
  }
  return result;
}

/**
 * Preset growth with overrides on top. A list sets levels from the first one; the levels it leaves out keep the
 * preset's value, so { branchAngle: [70] } changes only the first branches of a preset.
 */
export function mergeTreeGrowth(presetTree, overrides) {
  const merged = { ...presetTree, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    const inherited = presetTree[name];
    if (!Array.isArray(value) || inherited === undefined) continue;
    const length = Array.isArray(inherited) ? Math.max(inherited.length, value.length) : MAX_TREE_LEVELS + 1;
    merged[name] = Array.from({ length }, (_, index) => value[index] ?? valueAt(inherited, index));
  }
  return merged;
}

/** The largest number of branches `levels` can grow, from the top of every child count. */
export function maximumBranchCount(levels) {
  let total = 1;
  let generation = 1;
  for (const level of levels) {
    const children = level.children;
    if (!children) break;
    const perParent = children.whorls ? children.whorls * Math.ceil(children.perWhorl[1]) : Math.ceil(children.count[1]);
    generation *= perParent;
    total += generation;
  }
  return total;
}

/**
 * A species preset with growth overrides applied: a new object, the base left untouched. `tree` must have passed
 * checkTreeGrowth; `height` is an optional [min, max] that replaces the species height range.
 */
export function applyTreeGrowth(base, tree, height) {
  const levels = resizeLevels(base.levels, tree.levels ?? base.levels.length - 1);
  levels.forEach((level, index) => {
    if (level.children) applySprouting(level.children, tree, index);
    applyShape(level, tree, index);
  });
  if (tree.crownShape) levels[0].children.profile = CROWN_PROFILES[tree.crownShape];
  return { ...base, ...(height ? { height: [...height] } : {}), levels, leaf: applyLeaves(base.leaf, tree), leafSiteLimit: MAX_TREE_LEAF_SITES };
}

/** What scene_capabilities lists for tree growth: presets with their base species, and every parameter with its range. */
export function treeGrowthCapabilities() {
  const parameters = {};
  for (const [name, parameter] of Object.entries(TREE_PARAMETERS)) {
    const range = parameter.vector ? '[x,y,z]' : parameter.choices ? parameter.choices.join('|') : `${parameter.minimum}-${parameter.maximum}`;
    parameters[name] = `${range}${parameter.list ? ` (or a list per level from ${parameter.list === 'shape' ? 'the trunk' : 'the first branches'})` : ''}: ${parameter.about}`;
  }
  return {
    use: 'vegetation {preset: name, tree?: {parameter: value}} grows one tree, or a scatter of it with scatter; species with tree works too. A list sets levels from the first; levels it leaves out keep the preset value. tree is not allowed with mix.',
    presets: Object.fromEntries(Object.entries(TREE_PRESETS).map(([name, preset]) => [name, preset.species])),
    parameters,
  };
}
