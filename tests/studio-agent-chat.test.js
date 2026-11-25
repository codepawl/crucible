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
  assert.throws(() => parseAgentChatEvent({ type: 'shout' }), /Unknown agent chat event type "shout"/);
  assert.throws(() => parseAgentChatEvent({ type: 'text', text: '' }), /needs text as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'text', text: 7 }), /needs text as a non-empty string/);
  assert.throws(() => parseAgentChatEvent({ type: 'step', label: 'x'.repeat(AGENT_CHAT_LIMITS.labelLength + 1) }), /most is 120/);
  assert.throws(() => parseAgentChatEvent({ type: 'step', label: 'Moved', nodeId: 4 }), /needs nodeId/);
  assert.throws(() => parseAgentChatEvent({ type: 'notice', kind: 'weather', message: 'Rain' }), /kind "weather" is not known/);
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

test('in a window too short to stack Scene, Properties and the card, the card takes turns with Properties', testContext => {
  const root = mountSized(testContext, { width: 1280, height: 720 });
  const viewMenu = () => root.querySelector('#crucible-studio-pop-view');
  assert.equal(root.dataset.agentTight, 'true');
  assert.equal(root.dataset.agentCollapsed, 'true', 'it starts closed, as in a compact window');
  assert.equal(root.dataset.inspectorCollapsed, 'false');
  byText(viewMenu(), 'Agent').click();
  assert.equal(root.dataset.agentCollapsed, 'false');
  assert.equal(root.dataset.inspectorCollapsed, 'true', 'the card takes Properties place');
  byText(viewMenu(), 'Agent').click();
  assert.equal(root.dataset.inspectorCollapsed, 'false', 'Properties comes back when the card leaves');
  byText(viewMenu(), 'Agent').click();
  byText(viewMenu(), 'Properties').click();
  assert.equal(root.dataset.agentCollapsed, 'true', 'showing Properties puts the card away');
  assert.equal(root.dataset.inspectorCollapsed, 'false');
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
