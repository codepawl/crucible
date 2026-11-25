import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStudio } from '../src/studio.js';
import {
  AGENT_CHAT_LIMITS,
  agentChatHostProblems,
  createAgentConversation,
  parseAgentChatEvent,
} from '../src/studio-agent-chat.js';
import { AGENT_SUBSCRIBE_OPTIONS } from '../src/studio-agent-chat.js';
import { AGENT_STATUS_LIMITS, agentUsageLevel } from '../src/studio-agent-status.js';
import { STUDIO_ICON_PATHS } from '../src/studio-icons.js';
import { normalizeStudioPreferences } from '../src/studio-preferences.js';
import { byText, createFakeRenderer, dispatch, installStudioDom } from './support/studio-dom.mjs';

const RECIPE = {
  format: 'crucible.scene',
  schemaVersion: 1,
  geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
  materials: [{ id: 'paint', tag: 'surface', color: [0.8, 0.25, 0.2], roughness: 0.4, metallic: 0.1 }],
  nodes: [{ id: 'hero', geometry: 'cube', material: 'paint', translation: [0, 0.5, 0] }],
  camera: { eye: [0, 2, 6], target: [0, 0.5, 0], up: [0, 1, 0], fov: 45, near: 0.1, far: 100 },
  environment: { setup: 'studio', lightDirection: [-2, 5, 3] },
};

/** A sample host: it records what Studio sends and lets a test push events and end the run. */
function createSampleHost() {
  let listener = null;
  let finishRun = null;
  const record = { sent: [], stopCalls: 0 };
  const host = {
    send: text => {
      record.sent.push(text);
      return new Promise((resolve, reject) => {
        finishRun = { resolve, reject };
      });
    },
    stop: () => { record.stopCalls += 1; },
    subscribe: nextListener => {
      listener = nextListener;
      return () => { listener = null; };
    },
  };
  return {
    host,
    record,
    emit: event => listener(event),
    endRun: () => finishRun.resolve(),
    failRun: error => finishRun.reject(error),
    get subscribed() { return listener !== null; },
  };
}

function mountWithHost(testContext, { host, preferences, storage } = {}) {
  const dom = installStudioDom();
  if (host) globalThis.crucibleShell = { agentChat: host };
  const preferenceStorage = storage ?? { getItem: () => (preferences ? JSON.stringify(preferences) : null), setItem: () => {} };
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer(), preferenceStorage });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
    delete globalThis.crucibleShell;
  });
  const root = dom.container.firstElementChild;
  const ui = {
    dom,
    studio,
    root,
    card: () => root.querySelector('.crucible-studio-agent'),
    list: () => root.querySelector('.crucible-studio-agent-list'),
    field: () => root.querySelector('.crucible-studio-agent-field'),
    sendButton: () => root.querySelector('.crucible-studio-agent-send'),
    notices: () => root.querySelector('.crucible-studio-agent-notices'),
    viewMenu: () => root.querySelector('#crucible-studio-pop-view'),
    rows: () => root.querySelectorAll('.crucible-studio-agent-message'),
    type: text => { ui.field().value = text; },
    pressEnter: (properties = {}) => dispatch(ui.field(), 'keydown', { key: 'Enter', ...properties }),
  };
  return ui;
}

test('an event is checked at the boundary and keeps only the fields it defines', () => {
  assert.deepEqual(parseAgentChatEvent({ type: 'text', text: 'Hi', extra: 1 }), { type: 'text', text: 'Hi' });
  assert.deepEqual(parseAgentChatEvent({ type: 'step', label: 'Moved the lamp', nodeId: 'lamp' }), { type: 'step', label: 'Moved the lamp', nodeId: 'lamp' });
  assert.deepEqual(parseAgentChatEvent({ type: 'done' }), { type: 'done' });
  assert.deepEqual(parseAgentChatEvent({ type: 'stopped' }), { type: 'stopped' });
  assert.deepEqual(parseAgentChatEvent({ type: 'error', message: 'It failed' }), { type: 'error', message: 'It failed' });
  const action = () => {};
  const notice = parseAgentChatEvent({ type: 'notice', kind: 'signedOut', message: 'Signed out', actionLabel: 'Sign in', action });
  assert.equal(notice.action, action);
  assert.throws(() => parseAgentChatEvent(null), /is an object such as/);
  assert.equal(parseAgentChatEvent({ type: 'shout' }), null);
  assert.throws(() => parseAgentChatEvent({ kind: 'quota' }), /needs type as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 7 }), /needs type as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'text', text: '' }), /needs text as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'text', text: 7 }), /needs text as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'step', label: 'x'.repeat(AGENT_CHAT_LIMITS.labelLength + 1) }), /most is 120/);
  assert.throws(() => parseAgentChatEvent({ type: 'step', label: 'Moved', nodeId: 4 }), /needs nodeId/);
  assert.equal(parseAgentChatEvent({ type: 'notice', kind: 'weather', message: 'Rain' }), null);
  assert.throws(() => parseAgentChatEvent({ type: 'notice', message: 'Rain' }), /needs kind as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'notice', kind: 'quota', message: 'Out', actionLabel: 'Buy' }), /no action function/);
});

test('a host is accepted only with send, stop and subscribe', () => {
  assert.deepEqual(agentChatHostProblems(undefined), []);
  assert.deepEqual(agentChatHostProblems({ send() {}, stop() {}, subscribe() {} }), []);
  assert.deepEqual(agentChatHostProblems({ send() {} }), ['crucibleShell.agentChat.stop must be a function.', 'crucibleShell.agentChat.subscribe must be a function.']);
  assert.match(agentChatHostProblems('chat')[0], /must be an object/);
});

test('a reply is appended piece by piece, a step breaks it, and the newest messages are kept', () => {
  const conversation = createAgentConversation();
  conversation.addPersonMessage('Move the lamp');
  conversation.apply({ type: 'text', text: 'Sure, ' });
  conversation.apply({ type: 'text', text: 'moving it.' });
  assert.equal(conversation.apply({ type: 'step', label: 'Moved the lamp', nodeId: 'lamp' }), 'lamp');
  conversation.apply({ type: 'text', text: 'All set.' });
  conversation.apply({ type: 'done' });
  assert.deepEqual(conversation.messages.map(message => [message.kind, message.text]), [
    ['person', 'Move the lamp'],
    ['reply', 'Sure, moving it.'],
    ['step', 'Moved the lamp'],
    ['reply', 'All set.'],
    ['outcome', 'Done'],
  ]);
  assert.equal(conversation.running, false);
  for (let count = 0; count < AGENT_CHAT_LIMITS.messageCount + 20; count += 1) conversation.apply({ type: 'step', label: `Step ${count}` });
  assert.equal(conversation.messages.length, AGENT_CHAT_LIMITS.messageCount);
  assert.equal(conversation.messages.at(-1).text, `Step ${AGENT_CHAT_LIMITS.messageCount + 19}`);
});

test('a notice of one kind replaces the one before it, and a new message clears them', () => {
  const conversation = createAgentConversation();
  conversation.apply({ type: 'notice', kind: 'quota', message: 'First' });
  conversation.apply({ type: 'notice', kind: 'quota', message: 'Second' });
  conversation.apply({ type: 'notice', kind: 'signedOut', message: 'Out' });
  assert.deepEqual(conversation.notices.map(notice => notice.message), ['Second', 'Out']);
  assert.equal(conversation.messages.length, 0, 'a notice is never a message');
  conversation.addPersonMessage('Try again');
  assert.deepEqual(conversation.notices, []);
});

test('without a host there is no card, no View row, no key row and Alt+M does nothing', testContext => {
  const ui = mountWithHost(testContext);
  assert.equal(ui.card(), null);
  assert.equal(ui.root.dataset.agentCollapsed, undefined);
  assert.equal(ui.viewMenu().querySelectorAll('button').some(button => button.textContent === 'Agent'), false);
  assert.equal(dispatch(ui.root.querySelector('canvas'), 'keydown', { key: 'µ', code: 'KeyM', altKey: true }).defaultPrevented, false);
  assert.equal(ui.root.querySelectorAll('.crucible-studio-shortcut-item').some(item => item.textContent.includes('Show or hide Agent')), false);
});

test('a host that lacks a function gets no card and the console says why', testContext => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  testContext.after(() => { console.warn = originalWarn; });
  const ui = mountWithHost(testContext, { host: { send() {} } });
  assert.equal(ui.card(), null);
  assert.match(warnings[0], /agentChat\.stop must be a function/);
});

test('a host fills the card: the message shows, the reply streams, steps show and the pointer walks to the node', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  assert.equal(ui.root.dataset.agentCollapsed, 'false');
  assert.equal(ui.list().dataset.empty, 'true', 'the empty card shows a mark and no text');
  assert.equal(ui.sendButton().textContent, 'Send');
  ui.type('Move the hero');
  const enter = ui.pressEnter();
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(sample.record.sent, ['Move the hero']);
  assert.equal(ui.field().value, '', 'the field empties');
  assert.equal(ui.sendButton().textContent, 'Stop');
  sample.emit({ type: 'text', text: 'On it' });
  sample.emit({ type: 'text', text: ' now.' });
  sample.emit({ type: 'step', label: 'Moved the hero', nodeId: 'hero' });
  const rows = ui.rows();
  assert.deepEqual(rows.map(row => row.dataset.kind), ['person', 'reply', 'step']);
  assert.equal(rows[1].textContent, 'On it now.');
  assert.equal(rows[2].textContent, 'Moved the hero');
  assert.ok(ui.root.querySelector('.crucible-studio-agent-cursor'), 'the agent pointer is shown for the node');
  sample.emit({ type: 'done' });
  assert.equal(ui.rows().at(-1).dataset.outcome, 'done');
  assert.equal(ui.sendButton().textContent, 'Send');
  sample.endRun();
});

test('Shift+Enter does not send and Stop calls the host', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  ui.type('Line one');
  assert.equal(ui.pressEnter({ shiftKey: true }).defaultPrevented, false);
  assert.deepEqual(sample.record.sent, []);
  ui.pressEnter();
  ui.sendButton().click();
  assert.equal(sample.record.stopCalls, 1);
  sample.emit({ type: 'stopped' });
  assert.equal(ui.rows().at(-1).dataset.outcome, 'stopped');
  assert.equal(ui.sendButton().textContent, 'Send');
});

test('a send that rejects ends the run with a failed row', async testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  ui.type('Hello');
  ui.pressEnter();
  sample.failRun(new Error('The agent is not reachable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.rows().at(-1).dataset.outcome, 'failed');
  assert.equal(ui.rows().at(-1).textContent, 'The agent is not reachable');
  assert.equal(ui.sendButton().textContent, 'Send');
});

test('reply text is shown as text, never as markup', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  sample.emit({ type: 'text', text: '<img src=x onerror=alert(1)>' });
  const reply = ui.rows()[0];
  assert.equal(reply.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(reply.querySelectorAll('img').length, 0);
});

test('an event type or notice kind from a newer host is skipped without a notice or a row', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  sample.emit({ type: 'billing', plan: 'studio' });
  sample.emit({ type: 'notice', kind: 'maintenance', message: 'Back at noon' });
  assert.equal(ui.notices().textContent, '');
  assert.equal(ui.rows().length, 0);
  sample.emit({ type: 'text', text: 'Still here' });
  assert.equal(ui.rows()[0].textContent, 'Still here');
});

test('a malformed event shows an error notice that says what was wrong and the card carries on', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  sample.emit({ type: 'text', text: 42 });
  assert.match(ui.notices().textContent, /could not read.*needs text as a non-empty string/);
  sample.emit({ type: 'text', text: 'Still here' });
  assert.equal(ui.rows()[0].textContent, 'Still here');
});

test('notices sit outside the message list with their own mark and the host action', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  let signInCalls = 0;
  assert.equal(ui.notices().hidden, true);
  sample.emit({ type: 'notice', kind: 'signedOut', message: 'Sign in to continue', actionLabel: 'Sign in', action: () => { signInCalls += 1; } });
  sample.emit({ type: 'notice', kind: 'quota', message: 'No credits left' });
  assert.equal(ui.rows().length, 0, 'no message row for a notice');
  assert.equal(ui.list().contains(ui.notices()), false);
  assert.equal(ui.card().contains(ui.notices()), true);
  const noticeRows = ui.notices().querySelectorAll('.crucible-studio-agent-notice');
  assert.deepEqual(noticeRows.map(row => row.dataset.kind), ['signedOut', 'quota']);
  const markOf = row => row.querySelector('path').getAttribute('d');
  assert.notEqual(markOf(noticeRows[0]), markOf(noticeRows[1]), 'each kind has its own mark');
  byText(noticeRows[0], 'Sign in').click();
  assert.equal(signInCalls, 1);
  assert.equal(ui.notices().querySelectorAll('.crucible-studio-agent-notice').length, 1, 'the pressed notice is cleared');
});

test('the card has a minimize button and no close button, and View > Agent and Alt+M show and hide it', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const head = ui.card().querySelector('.crucible-studio-dock-head');
  assert.deepEqual(head.querySelectorAll('button').map(button => button.getAttribute('aria-label')), ['Minimize Agent']);
  const row = byText(ui.viewMenu(), 'Agent');
  assert.equal(row.getAttribute('role'), 'menuitemcheckbox');
  assert.equal(row.getAttribute('aria-checked'), 'true');
  assert.equal(row.dataset.shortcut, 'Alt+M');
  row.click();
  assert.equal(ui.root.dataset.agentCollapsed, 'true');
  assert.equal(row.getAttribute('aria-checked'), 'false');
  const press = dispatch(ui.root.querySelector('canvas'), 'keydown', { key: 'µ', code: 'KeyM', altKey: true });
  assert.equal(press.defaultPrevented, true);
  assert.equal(ui.root.dataset.agentCollapsed, 'false');
});

test('shown, minimized and height are remembered for the next visit', testContext => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const sample = createSampleHost();
  const first = mountWithHost(testContext, { host: sample.host, storage });
  first.card().querySelector('.crucible-studio-dock-head').querySelectorAll('button')[0].click();
  assert.equal(first.root.dataset.agentMinimized, 'true');
  byText(first.viewMenu(), 'Agent').click();
  const grip = first.card().querySelector('.crucible-studio-grip-agent-height');
  dispatch(grip, 'keydown', { key: 'ArrowUp' });
  const savedPreferences = JSON.parse(saved.get('crucible-studio-preferences'));
  assert.equal(savedPreferences.agentMinimized, true);
  assert.equal(savedPreferences.agentVisible, false);
  assert.ok(savedPreferences.agentHeight > 0, 'the height is saved');
  const second = mountWithHost(testContext, { host: createSampleHost().host, storage });
  assert.equal(second.root.dataset.agentMinimized, 'true');
  assert.equal(second.root.dataset.agentCollapsed, 'true');
  assert.equal(second.card().querySelector('.crucible-studio-grip-agent-height').getAttribute('aria-valuenow'), String(savedPreferences.agentHeight));
});

test('the preferences have the Agent defaults and pull a height back into range', () => {
  const defaults = normalizeStudioPreferences(null);
  assert.deepEqual([defaults.agentVisible, defaults.agentMinimized, defaults.agentHeight], [true, false, 0]);
  assert.equal(normalizeStudioPreferences({ agentHeight: 5 }).agentHeight, 96);
});

test('in a compact window the Agent card starts closed and takes turns with Properties', testContext => {
  const dom = installStudioDom();
  dom.container.clientWidth = 600;
  globalThis.crucibleShell = { agentChat: createSampleHost().host };
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
    delete globalThis.crucibleShell;
  });
  const root = dom.container.firstElementChild;
  assert.equal(root.dataset.compact, 'true');
  assert.equal(root.dataset.agentCollapsed, 'true');
  byText(root.querySelector('#crucible-studio-pop-view'), 'Agent').click();
  assert.equal(root.dataset.agentCollapsed, 'false');
  assert.equal(root.dataset.inspectorCollapsed, 'true');
  byText(root.querySelector('#crucible-studio-pop-view'), 'Properties').click();
  assert.equal(root.dataset.inspectorCollapsed, 'false');
  assert.equal(root.dataset.agentCollapsed, 'true', 'Properties brings the Agent card away');
});

test('disposing Studio unsubscribes from the host', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  assert.equal(sample.subscribed, true);
  ui.studio.dispose();
  assert.equal(sample.subscribed, false);
});

function mountSized(testContext, { width, height }) {
  const dom = installStudioDom();
  dom.container.clientWidth = width;
  dom.container.clientHeight = height;
  globalThis.crucibleShell = { agentChat: createSampleHost().host };
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer() });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
    delete globalThis.crucibleShell;
  });
  return dom.container.firstElementChild;
}

test('in a window too short to stack the cards, the card and Properties take turns and both keep a title row', testContext => {
  const root = mountSized(testContext, { width: 1280, height: 720 });
  const agentButton = () => root.querySelector('.crucible-studio-agent').querySelector('.crucible-studio-dock-head').querySelectorAll('button')[0];
  const propertiesButton = () => root.querySelectorAll('button').find(button => /^(Minimize|Expand) Properties$/.test(button.getAttribute('aria-label') ?? ''));
  assert.equal(root.dataset.agentTight, 'true');
  assert.equal(root.dataset.agentCollapsed, 'false', 'the card stays in the column as a title row');
  assert.equal(root.dataset.agentMinimized, 'true');
  assert.equal(root.dataset.inspectorMinimized, 'false');
  assert.equal(agentButton().getAttribute('aria-label'), 'Expand Agent');
  agentButton().click();
  assert.equal(root.dataset.agentMinimized, 'false', 'the card takes the room');
  assert.equal(root.dataset.inspectorMinimized, 'true', 'Properties folds to its title row');
  assert.equal(agentButton().getAttribute('aria-label'), 'Minimize Agent');
  assert.equal(propertiesButton().getAttribute('aria-label'), 'Expand Properties');
  propertiesButton().click();
  assert.equal(root.dataset.agentMinimized, 'true', 'opening Properties folds the card to its title row');
  assert.equal(root.dataset.inspectorMinimized, 'false');
});

test('a turn taken in a short window is not saved over the minimized preference', testContext => {
  const saved = new Map();
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const dom = installStudioDom();
  dom.container.clientWidth = 1280;
  dom.container.clientHeight = 720;
  globalThis.crucibleShell = { agentChat: createSampleHost().host };
  const studio = createStudio(dom.container, { recipe: RECIPE, renderer: createFakeRenderer(), storage });
  testContext.after(() => {
    studio.dispose();
    dom.uninstall();
    delete globalThis.crucibleShell;
  });
  const root = dom.container.firstElementChild;
  root.querySelector('.crucible-studio-agent').querySelector('.crucible-studio-dock-head').querySelectorAll('button')[0].click();
  const savedText = saved.get('crucible-studio-preferences');
  const savedPreferences = savedText ? JSON.parse(savedText) : {};
  assert.notEqual(savedPreferences.agentMinimized, true);
  assert.notEqual(savedPreferences.propertiesMinimized, true);
});

test('in a tall window the card stacks under Properties', testContext => {
  const root = mountSized(testContext, { width: 1280, height: 1080 });
  assert.equal(root.dataset.agentTight, 'false');
  assert.equal(root.dataset.agentCollapsed, 'false');
  assert.equal(root.dataset.inspectorCollapsed, 'false');
});

test('the card is marked while a notice shows, so the stylesheet can keep four rows of the list', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  assert.equal(ui.card().dataset.notice, 'false');
  sample.emit({ type: 'notice', kind: 'error', message: 'Not reachable' });
  assert.equal(ui.card().dataset.notice, 'true');
});

function statusParts(ui) {
  const query = selector => ui.root.querySelector(selector);
  return {
    row: query('.crucible-studio-agent-status'),
    ring: query('.crucible-studio-agent-usage'),
    arc: query('.crucible-studio-agent-ring-arc'),
    tip: query('.crucible-studio-agent-usage-tip'),
    items: () => ui.root.querySelectorAll('.crucible-studio-agent-status-item').map(item => [item.dataset.field, item.textContent]),
    document: ui.root.ownerDocument,
  };
}

test('a status event keeps the model, effort and mode as trimmed text and drops the rest', () => {
  assert.deepEqual(parseAgentChatEvent({ type: 'status', model: '  Fable 5.2 ', effort: 'high', mode: 'Plan', extra: 1, usage: { used: 1, limit: 2 } }), { type: 'status', model: 'Fable 5.2', effort: 'high', mode: 'Plan' });
  assert.deepEqual(parseAgentChatEvent({ type: 'status', model: 7, effort: '   ', mode: null }), { type: 'status' });
  assert.equal(parseAgentChatEvent({ type: 'status', model: 'm'.repeat(100) }).model.length, AGENT_STATUS_LIMITS.valueLength);
});

test('a usage event holds used between 0 and the limit, gives the credits left and parses the reset time', () => {
  const usage = parseAgentChatEvent({ type: 'usage', used: 38, limit: 50, unit: ' tokens ', resetsAt: '2026-12-01T12:00:00Z', extra: 1 });
  assert.deepEqual(usage, { type: 'usage', used: 38, remaining: 12, limit: 50, unit: 'tokens', resetsAt: Date.parse('2026-12-01T12:00:00Z') });
  assert.equal(parseAgentChatEvent({ type: 'usage', used: 3, limit: 50 }).unit, 'credits');
  assert.equal(parseAgentChatEvent({ type: 'usage', used: 3, limit: 50, resetsAt: 1796126400000 }).resetsAt, 1796126400000);
  assert.deepEqual([parseAgentChatEvent({ type: 'usage', used: 80, limit: 50 }).used, parseAgentChatEvent({ type: 'usage', used: 80, limit: 50 }).remaining], [50, 0], 'above the limit is clamped');
  assert.equal(parseAgentChatEvent({ type: 'usage', used: -4, limit: 50 }).remaining, 50, 'below zero is clamped');
  assert.equal(parseAgentChatEvent({ type: 'usage', used: 3, limit: 50, resetsAt: 'someday' }).resetsAt, undefined);
});

test('a usage whose numbers are not finite, or whose limit is not above zero, is ignored', testContext => {
  const invalid = [{ used: '12', limit: 50 }, { used: 12, limit: 0 }, { used: 12, limit: -5 }, { used: Number.NaN, limit: 50 }, { used: 5, limit: Infinity }, { limit: 50 }, { used: 5 }, {}];
  for (const fields of invalid) {
    assert.deepEqual(parseAgentChatEvent({ type: 'usage', ...fields }), { type: 'usage' }, JSON.stringify(fields));
  }
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  sample.emit({ type: 'usage', used: 10, limit: 50 });
  sample.emit({ type: 'usage', used: 'lots', limit: 50 });
  assert.equal(statusParts(ui).ring.dataset.level, 'plenty', 'the ring stays as it was');
  assert.equal(statusParts(ui).ring.getAttribute('aria-label'), '40 of 50 credits left');
});

test('the levels follow the share used: plenty under 50%, half to 80%, low to 100%, empty at 100%', () => {
  assert.equal(agentUsageLevel({ used: 49.9, limit: 100 }), 'plenty');
  assert.equal(agentUsageLevel({ used: 50, limit: 100 }), 'half');
  assert.equal(agentUsageLevel({ used: 79.9, limit: 100 }), 'half');
  assert.equal(agentUsageLevel({ used: 80, limit: 100 }), 'low');
  assert.equal(agentUsageLevel({ used: 99.9, limit: 100 }), 'low');
  assert.equal(agentUsageLevel({ used: 100, limit: 100 }), 'empty');
});

test('without a status or usage the card has no row and no ring', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  assert.equal(parts.row.hidden, true);
  assert.deepEqual(parts.items(), []);
  assert.equal(parts.ring.hidden, true);
});

test('a usage alone shows the ring with no row, and a status alone shows the row with no ring', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  sample.emit({ type: 'usage', used: 10, limit: 50 });
  assert.equal(parts.ring.hidden, false);
  assert.equal(parts.row.hidden, true);
  sample.emit({ type: 'status', model: 'Fable 5.2' });
  assert.equal(parts.ring.hidden, false, 'a status leaves the ring alone');
  sample.emit({ type: 'status' });
  assert.equal(parts.ring.hidden, false);
  assert.equal(parts.row.hidden, true);
});

test('a partial status shows only the values the host gave, in the order model, effort, mode', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  sample.emit({ type: 'status', mode: 'Plan', model: 'Fable 5.2' });
  assert.deepEqual(parts.items(), [['model', 'Fable 5.2'], ['mode', 'Plan']]);
  assert.equal(parts.ring.hidden, true, 'no usage, no ring');
  sample.emit({ type: 'status', effort: 'high' });
  assert.deepEqual(parts.items(), [['effort', 'high']], 'the newest status replaces the whole one');
  sample.emit({ type: 'status' });
  assert.equal(parts.row.hidden, true);
});

test('the ring shows the share left at each level and names it for a screen reader', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  const cases = [
    [{ used: 10, limit: 50 }, 'plenty', '80', '40 of 50 credits left'],
    [{ used: 25, limit: 50 }, 'half', '50', '25 of 50 credits left'],
    [{ used: 40, limit: 50 }, 'low', '20', '10 of 50 credits left'],
    [{ used: 50, limit: 50, unit: 'tokens' }, 'empty', '0', '0 of 50 tokens left'],
  ];
  for (const [usage, level, fill, name] of cases) {
    sample.emit({ type: 'usage', ...usage });
    assert.equal(parts.ring.hidden, false);
    assert.equal(parts.ring.dataset.level, level);
    assert.equal(parts.arc.style['--studio-agent-ring-fill'], fill);
    assert.equal(parts.ring.getAttribute('aria-label'), name);
  }
  assert.equal(parts.ring.textContent, '0%', 'low and empty carry the share as text a look can show');
});

test('a usage that arrives during a run updates the ring and the run goes on', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  sample.emit({ type: 'usage', used: 20, limit: 50 });
  ui.type('Hello');
  ui.pressEnter();
  assert.equal(ui.sendButton().textContent, 'Stop');
  sample.emit({ type: 'usage', used: 42, limit: 50 });
  assert.equal(parts.ring.dataset.level, 'low');
  assert.equal(ui.sendButton().textContent, 'Stop');
  sample.emit({ type: 'done' });
  assert.equal(parts.ring.dataset.level, 'low', 'an outcome does not clear the usage');
});

test('the popover shows the numbers and the reset day on hover or focus and closes on Esc and on leaving', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  sample.emit({ type: 'usage', used: 38, limit: 50, resetsAt: '2026-12-01T12:00:00Z' });
  assert.match(parts.ring.getAttribute('aria-label'), /^12 of 50 credits left\. Resets \d+ Dec$/);
  assert.equal(parts.tip.popoverOpen, false);
  dispatch(parts.ring, 'pointerenter');
  assert.equal(parts.tip.popoverOpen, true);
  assert.match(parts.tip.textContent, /12 of 50 credits left/);
  assert.match(parts.tip.textContent, /Resets \d+ Dec/);
  dispatch(parts.ring, 'pointerleave');
  assert.equal(parts.tip.popoverOpen, false);
  parts.ring.focus();
  assert.equal(parts.tip.popoverOpen, true, 'keyboard focus opens it');
  dispatch(parts.document, 'keydown', { key: 'Escape' });
  assert.equal(parts.tip.popoverOpen, false, 'Esc closes it');
  dispatch(parts.ring, 'focusout');
  dispatch(parts.ring, 'focusin');
  assert.equal(parts.tip.popoverOpen, true, 'focusing again opens it again');
});

test('the popover shows the coin before the numbers, hidden from a screen reader, and has no reset line without a time', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const parts = statusParts(ui);
  sample.emit({ type: 'usage', used: 38, limit: 50 });
  dispatch(parts.ring, 'pointerenter');
  assert.equal(parts.tip.textContent, '12 of 50 credits left');
  const coin = parts.tip.querySelector('svg');
  assert.equal(coin.getAttribute('aria-hidden'), 'true');
  assert.equal(coin.querySelector('path').getAttribute('d'), STUDIO_ICON_PATHS.creditToken);
  assert.equal(parts.tip.querySelector('.crucible-studio-agent-usage-line').firstElementChild, coin);
});

test('the action button of a quota notice carries the coin and the other notices do not', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  sample.emit({ type: 'notice', kind: 'quota', message: 'No credits left', actionLabel: 'Buy credits', action: () => {} });
  const quotaButton = ui.notices().querySelector('button');
  assert.equal(quotaButton.textContent, 'Buy credits');
  assert.equal(quotaButton.querySelector('svg').querySelector('path').getAttribute('d'), STUDIO_ICON_PATHS.creditToken);
  sample.emit({ type: 'notice', kind: 'error', message: 'Not reachable', actionLabel: 'Try again', action: () => {} });
  const errorRow = ui.notices().querySelectorAll('.crucible-studio-agent-notice').find(row => row.dataset.kind === 'error');
  assert.equal(errorRow.querySelector('button').querySelectorAll('svg').length, 0);
});

test('a quota-warning notice has the warning triangle, the exhausted quota notice an empty ring and an unknown kind is skipped', testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  const markOf = kind => ui.notices().querySelectorAll('.crucible-studio-agent-notice').find(row => row.dataset.kind === kind).querySelector('svg').querySelector('path').getAttribute('d');
  sample.emit({ type: 'notice', kind: 'quota-warning', message: 'Credits are running low', actionLabel: 'Buy credits', action: () => {} });
  sample.emit({ type: 'notice', kind: 'quota', message: 'No credits left' });
  sample.emit({ type: 'notice', kind: 'error', message: 'Not reachable' });
  const marks = [markOf('quota-warning'), markOf('quota'), markOf('error')];
  assert.equal(marks[0], STUDIO_ICON_PATHS.warning);
  assert.equal(marks[1], STUDIO_ICON_PATHS.usageEmpty);
  assert.equal(marks[2], STUDIO_ICON_PATHS.error);
  assert.equal(new Set(marks).size, 3, 'three shapes');
  assert.equal(ui.notices().querySelectorAll('.crucible-studio-agent-notice').length, 3);
  sample.emit({ type: 'notice', kind: 'weather', message: 'Rain' });
  assert.equal(ui.notices().querySelectorAll('.crucible-studio-agent-notice').length, 3, 'an unknown kind is skipped');
});

async function failRunWith(ui, sample, properties) {
  ui.type('Make it blue');
  ui.pressEnter();
  sample.emit({ type: 'error', message: 'The agent stopped', ...properties });
  sample.endRun();
  await new Promise(resolve => setImmediate(resolve));
}

const retryButton = ui => ui.root.querySelectorAll('.crucible-studio-agent-retry button')[0];

for (const retryFree of [undefined, false, 'true', 1]) {
  test(`a retryFree of ${JSON.stringify(retryFree)} shows no retry button`, async testContext => {
    const sample = createSampleHost();
    const ui = mountWithHost(testContext, { host: sample.host });
    await failRunWith(ui, sample, { retryFree });
    assert.equal(retryButton(ui), undefined);
  });
}

test('a retryFree of true shows Try again with the word Free, and the status icon stays in front', async testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  await failRunWith(ui, sample, { retryFree: true });
  assert.equal(retryButton(ui).textContent, 'Try again');
  assert.equal(ui.root.querySelector('.crucible-studio-agent-retry-hint').textContent, 'Free');
  assert.equal(ui.rows().at(-1).dataset.outcome, 'failed');
  assert.equal(ui.rows().at(-1).querySelector('svg').querySelector('path').getAttribute('d'), STUDIO_ICON_PATHS.error);
});

test('a free retry sends the last text again when the host has no retry, and the button goes away', async testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  await failRunWith(ui, sample, { retryFree: true });
  dispatch(retryButton(ui), 'click');
  assert.deepEqual(sample.record.sent, ['Make it blue', 'Make it blue']);
  assert.equal(retryButton(ui), undefined, 'removed once pressed');
  assert.equal(ui.sendButton().textContent, 'Stop', 'a run is going');
});

test('a free retry calls the retry method of the host when it has one, and a new run removes the offer', async testContext => {
  const sample = createSampleHost();
  let retryCalls = 0;
  sample.host.retry = () => {
    retryCalls += 1;
    return new Promise(() => {});
  };
  const ui = mountWithHost(testContext, { host: sample.host });
  await failRunWith(ui, sample, { retryFree: true });
  dispatch(retryButton(ui), 'click');
  assert.equal(retryCalls, 1);
  assert.deepEqual(sample.record.sent, ['Make it blue'], 'send is not called again');
});

test('a new run removes the retry offer', async testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  await failRunWith(ui, sample, { retryFree: true });
  assert.ok(retryButton(ui));
  ui.type('Something else');
  ui.pressEnter();
  assert.equal(retryButton(ui), undefined);
});

test('a host with a retry that is not a function gets no card', () => {
  assert.deepEqual(agentChatHostProblems({ send() {}, stop() {}, subscribe() {}, retry: 'again' }), ['crucibleShell.agentChat.retry must be a function.']);
  assert.deepEqual(agentChatHostProblems({ send() {}, stop() {}, subscribe() {}, retry() {} }), []);
});

test('the card asks the host for status, usage and the quota-warning notice in the one subscribe call', testContext => {
  const sample = createSampleHost();
  const asked = [];
  const subscribe = sample.host.subscribe;
  sample.host.subscribe = (listener, ...rest) => {
    asked.push(rest);
    return subscribe(listener);
  };
  mountWithHost(testContext, { host: sample.host });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], [{ events: ['status', 'usage'], noticeKinds: ['quota-warning'] }]);
  assert.equal(asked[0][0], AGENT_SUBSCRIBE_OPTIONS);
  assert.equal(Object.isFrozen(AGENT_SUBSCRIBE_OPTIONS.events) && Object.isFrozen(AGENT_SUBSCRIBE_OPTIONS.noticeKinds), true);
});

test('a done that is free to repeat offers the retry under the reply, on the latest outcome only', async testContext => {
  const sample = createSampleHost();
  const ui = mountWithHost(testContext, { host: sample.host });
  ui.type('Make it blue');
  ui.pressEnter();
  sample.emit({ type: 'text', text: 'Done, it is blue.' });
  sample.emit({ type: 'done', retryFree: 'yes' });
  assert.equal(retryButton(ui), undefined, 'only an exact true counts');
  sample.emit({ type: 'done', retryFree: true });
  assert.equal(retryButton(ui).textContent, 'Try again');
  assert.equal(ui.root.querySelector('.crucible-studio-agent-retry-hint').textContent, 'Free');
  assert.equal(ui.root.querySelectorAll('.crucible-studio-agent-retry').length, 1);
  sample.emit({ type: 'done' });
  assert.equal(retryButton(ui), undefined, 'a newer outcome without the offer takes it away');
  sample.emit({ type: 'done', retryFree: true });
  dispatch(retryButton(ui), 'click');
  assert.deepEqual(sample.record.sent, ['Make it blue', 'Make it blue']);
  assert.equal(retryButton(ui), undefined);
});
