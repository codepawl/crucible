import assert from 'node:assert/strict';
import test from 'node:test';
import '../src/studio-features.js';
import { AGENT_CHAT_CSS } from '../src/studio-agent-chat.js';
import { registeredStudioStyles } from '../src/studio-registry.js';
import { STUDIO_CSS } from '../src/studio-styles.js';

const ALL_STUDIO_CSS = `${STUDIO_CSS}\n${AGENT_CHAT_CSS}\n${registeredStudioStyles()}`;

const LAYOUT_PROPERTIES = [
  'left', 'top', 'right', 'bottom',
  'width', 'height', 'inline-size', 'block-size',
  'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding', 'inset', 'grid-template', 'flex-basis', 'font-size',
];
const LAYOUT_PREFIXES = ['margin-', 'padding-', 'inset-', 'grid-template-'];
const MOTION_PROPERTIES = [
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function',
  'animation', 'animation-duration', 'animation-timing-function',
];
const AT_RULES = ['@media', '@container', '@supports', '@keyframes', '@layer', '@starting-style'];

function isLayoutProperty(name) {
  return LAYOUT_PROPERTIES.includes(name) || LAYOUT_PREFIXES.some(prefix => name.startsWith(prefix));
}

function parseRules(stylesheet) {
  const text = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const conditions = [];
  let buffer = '';
  for (const character of text) {
    if (character === '{') {
      const prelude = buffer.trim();
      buffer = '';
      if (AT_RULES.some(name => prelude.startsWith(name))) {
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

function splitList(value) {
  return value.split(/,(?![^(]*\))/).map(part => part.trim());
}

function hasCondition(rule, fragment) {
  return rule.conditions.some(condition => condition?.includes(fragment));
}

const parsedRules = parseRules(ALL_STUDIO_CSS);

test('no transition, animation, keyframe, or starting-style in any Studio stylesheet animates a layout property (#3223)', () => {
  for (const rule of parsedRules) {
    const inKeyframes = rule.conditions.some(condition => condition?.startsWith('@keyframes'));
    const inStartingStyle = rule.conditions.some(condition => condition?.startsWith('@starting-style'));
    for (const { property, value } of declarationsOf(rule)) {
      if (inKeyframes || inStartingStyle) {
        assert.ok(!isLayoutProperty(property), `${rule.selector}: sets layout property "${property}" inside ${inKeyframes ? '@keyframes' : '@starting-style'}`);
      }
      if (property === 'transition' && value !== 'none') {
        const names = splitList(value).flatMap(segment => segment.split(/\s+/));
        for (const name of names) {
          assert.notEqual(name, 'all', `${rule.selector}: transitions "all"`);
          assert.ok(!isLayoutProperty(name), `${rule.selector}: transitions layout property "${name}"`);
        }
      }
      if (property === 'transition-property') {
        for (const name of splitList(value)) {
          assert.notEqual(name, 'all', `${rule.selector}: transition-property uses "all"`);
          assert.ok(!isLayoutProperty(name), `${rule.selector}: transition-property uses layout property "${name}"`);
        }
      }
    }
  }
});

test('dialogs and backdrop enter with opacity + translate and exit cleanly, with fade-only under reduced motion (#3223)', () => {
  const motionDialogRules = parsedRules.filter(rule => hasCondition(rule, 'no-preference') && hasCondition(rule, 'allow-discrete') && rule.selector.includes('dialog'));
  const closedDialog = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog');
  const openDialog = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog[open]' && !hasCondition(rule, '@starting-style'));
  const startingDialog = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog[open]' && hasCondition(rule, '@starting-style'));
  const closedBackdrop = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog::backdrop');
  const openBackdrop = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog[open]::backdrop' && !hasCondition(rule, '@starting-style'));
  const startingBackdrop = motionDialogRules.find(rule => rule.selector === '.crucible-studio dialog[open]::backdrop' && hasCondition(rule, '@starting-style'));

  assert.ok(closedDialog, 'closed dialog rule exists');
  assert.match(closedDialog.body, /pointer-events:\s*none/);
  assert.match(closedDialog.body, /opacity var\(--studio-motion-quick\) var\(--studio-ease-out\)/);
  assert.match(closedDialog.body, /display var\(--studio-motion-quick\) var\(--studio-ease-out\) allow-discrete/);
  assert.match(closedDialog.body, /overlay var\(--studio-motion-quick\) var\(--studio-ease-out\) allow-discrete/);

  assert.ok(openDialog, 'open dialog rule exists');
  assert.match(openDialog.body, /pointer-events:\s*auto/);
  assert.match(openDialog.body, /opacity var\(--studio-motion-base\) var\(--studio-ease-out\)/);
  assert.match(openDialog.body, /translate var\(--studio-motion-base\) var\(--studio-ease-out\)/);

  assert.ok(startingDialog, 'dialog starting-style rule exists');
  assert.match(startingDialog.body, /opacity:\s*0/);
  assert.match(startingDialog.body, /translate:\s*0 6px/);

  assert.ok(closedBackdrop && openBackdrop && startingBackdrop, 'dialog backdrop enter/exit rules exist');
  assert.match(openBackdrop.body, /opacity var\(--studio-motion-base\) var\(--studio-ease-out\)/);

  const reducedDialogRules = parsedRules.filter(rule => hasCondition(rule, 'motion: reduce') && hasCondition(rule, 'allow-discrete') && rule.selector.includes('dialog'));
  assert.ok(reducedDialogRules.length >= 6, 'reduced-motion rules cover dialog and backdrop enter/exit');
  for (const rule of reducedDialogRules) {
    assert.ok(!/translate|scale|transform/.test(rule.body), `${rule.selector}: reduced motion dialog moves nothing`);
  }
});

test('the file drop overlay and secondary viewport notices animate on compositor and reduce to opacity fades (#3223)', () => {
  const dropEnter = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector.includes('crucible-studio-drop-overlay') && rule.selector.includes('data-drop-active') && !hasCondition(rule, '@starting-style'));
  const dropExit = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector === '.crucible-studio-drop-overlay');
  assert.ok(dropEnter && dropExit, 'drop overlay enter and exit rules exist');
  assert.match(dropEnter.body, /opacity var\(--studio-motion-quick\) var\(--studio-ease-out\)/);
  assert.match(dropExit.body, /display var\(--studio-motion-exit\) var\(--studio-ease-out\) allow-discrete/);

  const reducedDrop = parsedRules.filter(rule => hasCondition(rule, 'motion: reduce') && rule.selector.includes('crucible-studio-drop-overlay'));
  assert.ok(reducedDrop.length >= 3);
  for (const rule of reducedDrop) {
    assert.ok(!/translate|scale|transform/.test(rule.body));
  }

  const noticeEnter = parsedRules.find(rule => hasCondition(rule, 'no-preference') && !hasCondition(rule, '@starting-style') && rule.selector.includes('crucible-studio-numpad-notice') && !rule.selector.includes('[hidden]'));
  const noticeExit = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector.includes('crucible-studio-numpad-notice[hidden]'));
  assert.ok(noticeEnter && noticeExit, 'secondary viewport notice enter and exit rules exist');
  assert.match(noticeEnter.body, /opacity var\(--studio-motion-base\) var\(--studio-ease-out\)/);
  assert.match(noticeEnter.body, /translate var\(--studio-motion-base\) var\(--studio-ease-out\)/);
  assert.match(noticeExit.body, /pointer-events:\s*none/);

  const reducedNotices = parsedRules.filter(rule => hasCondition(rule, 'motion: reduce') && rule.selector.includes('crucible-studio-numpad-notice'));
  assert.ok(reducedNotices.length >= 3);
  for (const rule of reducedNotices) {
    assert.ok(!/translate|scale|transform/.test(rule.body));
  }
});

test('panel show, card body expand, button press feedback, and remaining chevrons are gated off under reduced motion (#3223)', () => {
  const dockFade = parsedRules.find(rule => hasCondition(rule, 'no-preference') && !hasCondition(rule, '@starting-style') && rule.selector === '.crucible-studio-dock');
  assert.ok(dockFade, 'panel show fade exists');
  assert.match(dockFade.body, /opacity var\(--studio-motion-quick\) var\(--studio-ease-out\)/);
  assert.ok(!dockFade.body.includes('allow-discrete'), 'panel collapse stays instant with no allow-discrete');

  const bodyFade = parsedRules.find(rule => hasCondition(rule, 'no-preference') && !hasCondition(rule, '@starting-style') && rule.selector.includes('data-outliner-minimized="false"'));
  assert.ok(bodyFade, 'card body expand fade exists');
  assert.match(bodyFade.body, /opacity var\(--studio-motion-quick\) var\(--studio-ease-out\)/);

  const pressRule = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector.includes(':active') && rule.selector.includes('crucible-studio-toolbar'));
  assert.ok(pressRule, 'button press feedback rule exists');
  assert.match(pressRule.body, /scale:\s*0\.97/);

  const recentChevron = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector.includes('data-recent-chevron'));
  assert.ok(recentChevron, 'recent menu chevron transition exists');
  assert.match(recentChevron.body, /transform var\(--studio-motion-quick\) var\(--studio-ease-out\)/);

  const modifierDrag = parsedRules.find(rule => hasCondition(rule, 'no-preference') && rule.selector === '.crucible-studio-modifier');
  assert.ok(modifierDrag, 'modifier drag highlight transition exists');

  const reducedPreferenceRules = parsedRules.filter(rule => rule.selector.includes('[data-motion="reduced"]'));
  const combinedReducedPreference = reducedPreferenceRules.map(rule => `${rule.selector} { ${rule.body} }`).join('\n');
  assert.match(combinedReducedPreference, /crucible-studio-keyboard-dot/);
  assert.match(combinedReducedPreference, /crucible-studio-name-busy/);
  assert.match(combinedReducedPreference, /dialog/);
  assert.match(combinedReducedPreference, /animation:\s*none/);
  assert.match(combinedReducedPreference, /translate:\s*none/);
});

test('every Studio motion rule is switched off, zeroed, or opacity-fade-only under prefers-reduced-motion: reduce (#3223)', () => {
  const reducedRules = parsedRules.filter(rule => hasCondition(rule, 'prefers-reduced-motion: reduce'));
  const zeroedTokens = reducedRules.flatMap(rule => [...rule.body.matchAll(/(--studio-motion-[a-z]+):\s*0ms/g)].map(match => match[1]));
  for (const rule of parsedRules) {
    const motionDeclarations = declarationsOf(rule).filter(declaration => MOTION_PROPERTIES.includes(declaration.property));
    if (motionDeclarations.length === 0) continue;
    const gated = hasCondition(rule, 'prefers-reduced-motion: no-preference');
    const switchedOff = reducedRules.some(reduced => reduced.selector === rule.selector && /transition:\s*none|animation:\s*none/.test(reduced.body));
    const durations = motionDeclarations.flatMap(declaration => [...declaration.value.matchAll(/var\((--studio-motion-[a-z]+)\)/g)].map(match => match[1]));
    const onlyZeroedTokens = durations.length > 0 && durations.every(token => zeroedTokens.includes(token));
    const insideReduce = hasCondition(rule, 'prefers-reduced-motion: reduce');
    const fadeOnly = insideReduce && motionDeclarations.filter(declaration => declaration.value !== 'none').every(declaration => splitList(declaration.value).every(segment => /^(opacity|display|overlay) /.test(segment) && segment.includes('var(--studio-motion-fade)')));
    assert.ok(
      gated || switchedOff || onlyZeroedTokens || fadeOnly || motionDeclarations.every(declaration => declaration.value === 'none'),
      `${rule.selector}: motion rule is not disabled or reduced under prefers-reduced-motion`,
    );
  }
});
