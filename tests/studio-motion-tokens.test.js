import assert from 'node:assert/strict';
import test from 'node:test';
import { EASE_TOKEN, TRAVEL_TOKEN } from '../src/studio-agent-presence.js';
import { STUDIO_CSS } from '../src/studio-styles.js';

const LAYOUT_PROPERTIES = ['left', 'top', 'right', 'bottom', 'width', 'height', 'inline-size', 'block-size', 'min-width', 'min-height', 'max-width', 'max-height', 'margin', 'padding', 'inset', 'grid-template', 'flex-basis', 'font-size'];
const LAYOUT_PROPERTY_PREFIXES = ['margin-', 'padding-', 'inset-', 'grid-template-'];
const MOTION_PROPERTIES = ['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'animation', 'animation-duration', 'animation-timing-function'];
const UNRESOLVED = '<unresolved>';
const AT_RULES_WITH_RULES = ['@media', '@container', '@supports', '@keyframes', '@layer'];

function isLayoutProperty(name) {
  return LAYOUT_PROPERTIES.includes(name) || LAYOUT_PROPERTY_PREFIXES.some(prefix => name.startsWith(prefix));
}

/** Flattens a stylesheet into rules, each with the at-rules it sits inside. A style rule is marked by null while open. */
function parseRules(stylesheet) {
  const text = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const conditions = [];
  let buffer = '';
  for (const character of text) {
    if (character === '{') {
      const prelude = buffer.trim();
      buffer = '';
      if (AT_RULES_WITH_RULES.some(name => prelude.startsWith(name))) {
        conditions.push(prelude);
      } else {
        rules.push({ selector: prelude, conditions: [...conditions], body: '' });
        conditions.push(null);
      }
    } else if (character === '}') {
      const closed = conditions.pop();
      if (closed === null) {
        rules.at(-1).body = buffer;
      }
      buffer = '';
    } else {
      buffer += character;
    }
  }
  return rules;
}

function declarationsOf(rule) {
  const declarations = [];
  for (const declaration of rule.body.split(/;(?![^(]*\))/)) {
    const separator = declaration.indexOf(':');
    if (separator !== -1) {
      declarations.push({ property: declaration.slice(0, separator).trim(), value: declaration.slice(separator + 1).trim() });
    }
  }
  return declarations;
}

function customPropertiesOf(rules) {
  const properties = new Map();
  for (const rule of rules.filter(candidate => candidate.conditions.length === 0)) {
    for (const { property, value } of declarationsOf(rule).filter(declaration => declaration.property.startsWith('--'))) {
      properties.set(property, value);
    }
  }
  return properties;
}

const VARIABLE_PATTERN = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/;

/** Replaces var() with the stylesheet's own custom property or the var() fallback; what neither gives stays marked. */
function resolveValue(value, properties) {
  let resolved = value;
  for (let round = 0; round < 10 && VARIABLE_PATTERN.test(resolved); round += 1) {
    resolved = resolved.replace(VARIABLE_PATTERN, (match, name, fallback) => properties.get(name) ?? fallback ?? UNRESOLVED);
  }
  return resolved;
}

function splitList(value) {
  return value.split(/,(?![^(]*\))/).map(part => part.trim());
}

function transitionedNames(property, resolvedValue) {
  if (property === 'transition') {
    return splitList(resolvedValue).flatMap(segment => segment.split(/\s+/));
  }
  if (property === 'transition-property') {
    return splitList(resolvedValue);
  }
  return [];
}

/** Everything the motion checks that depend on one stylesheet alone: layout properties, all, keyframes and var() values. */
function findMotionProblems(stylesheet) {
  const rules = parseRules(stylesheet);
  const properties = customPropertiesOf(rules);
  const problems = [];
  for (const rule of rules) {
    const insideKeyframes = rule.conditions.some(condition => condition?.startsWith('@keyframes'));
    for (const { property, value } of declarationsOf(rule)) {
      if (insideKeyframes && isLayoutProperty(property)) {
        problems.push(`${rule.selector}: a keyframe sets "${property}", which lays out on every frame`);
      }
      if (!MOTION_PROPERTIES.includes(property)) {
        continue;
      }
      const resolved = resolveValue(value, properties);
      if (resolved.includes(UNRESOLVED)) {
        problems.push(`${rule.selector}: "${property}: ${value}" uses a var() the stylesheet does not define and gives no fallback`);
      }
      for (const name of transitionedNames(property, resolved)) {
        if (name === 'all') {
          problems.push(`${rule.selector}: "${property}" transitions all, which includes layout properties`);
        } else if (isLayoutProperty(name)) {
          problems.push(`${rule.selector}: "${property}" transitions "${name}", which lays out on every frame`);
        }
      }
    }
  }
  return problems;
}

const motionRules = parseRules(STUDIO_CSS)
  .map(rule => ({ ...rule, declarations: declarationsOf(rule).filter(declaration => MOTION_PROPERTIES.includes(declaration.property)) }))
  .filter(rule => rule.declarations.length > 0);

test('the parser reads the motion rules, including the bake pulse keyframes and their real body (#3223)', () => {
  assert.ok(motionRules.length >= 7, `only ${motionRules.length} rules with motion were parsed`);
  const keyframes = parseRules(STUDIO_CSS).filter(rule => rule.conditions.some(condition => condition?.startsWith('@keyframes crucible-studio-bake-pulse')));
  assert.equal(keyframes.length, 1);
  assert.match(keyframes[0].body, /opacity:\s*0\.45/);
});

test('no Studio transition, animation or keyframe lays out, and none transitions all or an unresolved var (#3223)', () => {
  assert.deepEqual(findMotionProblems(STUDIO_CSS), []);
});

test('the motion check catches a layout property in a transition or keyframe, all, and an unknown var (#3223)', () => {
  assert.match(findMotionProblems('.a { transition: left 1s ease; }')[0], /transitions "left"/);
  assert.match(findMotionProblems('.a { transition: opacity 1s, margin-top 1s; }')[0], /transitions "margin-top"/);
  assert.match(findMotionProblems('.a { transition: all 1s; }')[0], /transitions all/);
  assert.match(findMotionProblems('.a { transition: opacity 1s, all 2s; }')[0], /transitions all/);
  assert.match(findMotionProblems('.a { transition-property: opacity, all; }')[0], /transitions all/);
  assert.match(findMotionProblems('.a { transition-property: width; }')[0], /transitions "width"/);
  assert.match(findMotionProblems('@media (prefers-reduced-motion: no-preference) { @keyframes grow { from { width: 0; } to { width: 10px; } } }')[0], /keyframe sets "width"/);
  assert.match(findMotionProblems('.a { transition: var(--missing); }')[0], /does not define/);
  assert.match(findMotionProblems('.a { animation: spin var(--missing-duration) linear; }')[0], /does not define/);
  assert.deepEqual(findMotionProblems('.studio { --duration: 100ms; } .a { transition: opacity var(--duration) var(--ease, ease-out); }'), []);
  assert.equal(findMotionProblems('.studio { --change: all 1s; } .a { transition: var(--change); }').length, 1, 'a var() that resolves to all is caught');
});

test('every Studio transition is off for reduced motion (#3223)', () => {
  const rules = parseRules(STUDIO_CSS);
  const reducedRules = rules.filter(rule => rule.conditions.some(condition => condition?.includes('prefers-reduced-motion: reduce')));
  const zeroedTokens = reducedRules.flatMap(rule => [...rule.body.matchAll(/(--studio-motion-[a-z]+):\s*0ms/g)].map(match => match[1]));
  for (const rule of motionRules) {
    const gated = rule.conditions.some(condition => condition?.includes('prefers-reduced-motion: no-preference'));
    const switchedOff = reducedRules.some(reduced => reduced.selector === rule.selector && /transition:\s*none|animation:\s*none/.test(reduced.body));
    const durations = rule.declarations.flatMap(declaration => [...declaration.value.matchAll(/var\((--studio-motion-[a-z]+)\)/g)].map(match => match[1]));
    const onlyZeroedTokens = durations.length > 0 && durations.every(token => zeroedTokens.includes(token));
    assert.ok(gated || switchedOff || onlyZeroedTokens, `${rule.selector} moves under reduced motion: wrap it in prefers-reduced-motion: no-preference or add a reduce rule that switches it off`);
  }
});

test('every Studio transition takes its duration and easing from the motion tokens (#3223)', () => {
  for (const rule of motionRules) {
    for (const declaration of rule.declarations.filter(candidate => candidate.property === 'transition' && candidate.value !== 'none')) {
      for (const segment of splitList(declaration.value)) {
        assert.match(segment, /var\(--studio-motion-(quick|base|travel|fade)\)/, `${rule.selector}: "${segment}" has a hard-coded duration`);
        assert.match(segment, /var\(--studio-ease-(out|in)\)/, `${rule.selector}: "${segment}" has a hard-coded easing`);
      }
    }
  }
});

test('the motion tokens fall back to the site tokens, reduced motion zeroes the movement and keeps the fade (#3223)', () => {
  assert.match(STUDIO_CSS, /--studio-motion-quick: var\(--site-motion-quick, 110ms\);/);
  assert.match(STUDIO_CSS, /--studio-motion-base: var\(--site-motion-base, 170ms\);/);
  assert.match(STUDIO_CSS, /--studio-motion-travel: 360ms;/);
  assert.match(STUDIO_CSS, /--studio-motion-fade: 100ms;/);
  assert.match(STUDIO_CSS, /--studio-ease-out: var\(--site-ease-out, cubic-bezier\(0\.2, 0, 0, 1\)\);/);
  assert.ok(!STUDIO_CSS.includes('--studio-motion-press'), 'the press token waits for the group that uses it');
  const reduced = parseRules(STUDIO_CSS).filter(rule => rule.selector === '.crucible-studio' && rule.conditions.some(condition => condition?.includes('reduce')));
  assert.equal(reduced.length, 1);
  for (const token of ['quick', 'base', 'travel']) {
    assert.match(reduced[0].body, new RegExp(`--studio-motion-${token}: 0ms`));
  }
  assert.ok(!reduced[0].body.includes('--studio-motion-fade'), 'a fade has no movement, so reduced motion keeps it');
});

test('the agent pointer is glued by translate and has no CSS motion; its glide is a transform animation from the script (#3223)', () => {
  const pointerRules = parseRules(STUDIO_CSS).filter(rule => rule.selector.startsWith('.crucible-studio-agent-cursor'));
  const base = pointerRules.find(rule => rule.selector === '.crucible-studio-agent-cursor');
  assert.match(base.body, /translate:\s*var\(--studio-agent-x, 0px\) var\(--studio-agent-y, 0px\)/);
  assert.ok(!/(^|[;\s])(left|top)\s*:/.test(base.body), 'the pointer is not placed with left or top');
  assert.deepEqual(pointerRules.filter(rule => /transition|animation/.test(rule.body)).map(rule => rule.selector), [], 'a transition on the pointer would make it trail the camera');
});

test('the custom properties the pointer script reads exist in the stylesheet under the constant names the script uses (#3223)', () => {
  const properties = customPropertiesOf(parseRules(STUDIO_CSS));
  assert.ok(properties.has(TRAVEL_TOKEN), `${TRAVEL_TOKEN} is read by studio-agent-presence.js and must be defined`);
  assert.match(properties.get(TRAVEL_TOKEN), /^\d+ms$/);
  assert.ok(properties.has(EASE_TOKEN), `${EASE_TOKEN} is read by studio-agent-presence.js and must be defined`);
});
