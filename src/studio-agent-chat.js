// The Agent card of Studio: a conversation a host app fills. The host (the desktop app, for one) hands over
// `globalThis.crucibleShell.agentChat`; this file shows what that object reports and calls its methods, and holds no model
// client, no key and makes no network call. Without a host there is no card.
//
// The host object has `send(text)` (a promise that settles when the run ends), `stop()` and `subscribe(listener)` (returns the
// function that unsubscribes). The listener gets plain events; `parseAgentChatEvent` checks each one at this boundary.

export const AGENT_CHAT_LIMITS = Object.freeze({
  messageCount: 200,
  personTextLength: 4000,
  replyTextLength: 20000,
  labelLength: 120,
  nodeIdLength: 200,
  noticeTextLength: 300,
  actionLabelLength: 40,
});

export const AGENT_NOTICE_KINDS = Object.freeze(['signedOut', 'quota', 'error']);
const NOTICE_ICONS = Object.freeze({ signedOut: 'lock', quota: 'warning', error: 'error' });
const OUTCOME_ICONS = Object.freeze({ done: 'check', stopped: 'stop', failed: 'error' });
const STEP_ICON = 'agent';
const OUTCOME_TEXT = Object.freeze({ done: 'Done', stopped: 'Stopped' });
const STICK_TO_BOTTOM_PIXELS = 24;
const HOST_METHODS = Object.freeze(['send', 'stop', 'subscribe']);

function boundedText(event, field, longest, { required = true } = {}) {
  const value = event[field];
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`Agent chat event "${event.type}" needs ${field} as a non-empty string; got ${JSON.stringify(value)}.`);
  }
  if (value.length > longest) {
    throw new RangeError(`Agent chat event "${event.type}" has a ${field} of ${value.length} characters; the most is ${longest}. Send it in shorter pieces.`);
  }
  return value;
}

function parseNotice(event) {
  if (!AGENT_NOTICE_KINDS.includes(event.kind)) {
    throw new RangeError(`Agent chat notice kind ${JSON.stringify(event.kind)} is not known. Use one of ${AGENT_NOTICE_KINDS.join(', ')}.`);
  }
  const notice = { type: 'notice', kind: event.kind, message: boundedText(event, 'message', AGENT_CHAT_LIMITS.noticeTextLength) };
  const actionLabel = boundedText(event, 'actionLabel', AGENT_CHAT_LIMITS.actionLabelLength, { required: false });
  if (actionLabel !== undefined) {
    if (typeof event.action !== 'function') {
      throw new TypeError(`Agent chat notice "${event.kind}" has an actionLabel but no action function to call when the button is pressed.`);
    }
    notice.actionLabel = actionLabel;
    notice.action = event.action;
  }
  return notice;
}

/**
 * The event as Studio keeps it, or an error that says what was wrong. Unknown fields are dropped.
 * The events: text, step, done, stopped, error and notice (see docs/studio.md, "Agent chat").
 */
export function parseAgentChatEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError(`An agent chat event is an object such as { type: 'text', text: 'Hello' }; got ${JSON.stringify(event)}.`);
  }
  switch (event.type) {
    case 'text':
      return { type: 'text', text: boundedText(event, 'text', AGENT_CHAT_LIMITS.replyTextLength) };
    case 'step':
      return {
        type: 'step',
        label: boundedText(event, 'label', AGENT_CHAT_LIMITS.labelLength),
        nodeId: boundedText(event, 'nodeId', AGENT_CHAT_LIMITS.nodeIdLength, { required: false }),
      };
    case 'done':
    case 'stopped':
      return { type: event.type };
    case 'error':
      return { type: 'error', message: boundedText(event, 'message', AGENT_CHAT_LIMITS.noticeTextLength) };
    case 'notice':
      return parseNotice(event);
    default:
      throw new RangeError(`Unknown agent chat event type ${JSON.stringify(event.type)}. Use one of text, step, done, stopped, error, notice.`);
  }
}

/** The problems of a host's `agentChat` object, or an empty list when it can fill the card. */
export function agentChatHostProblems(host) {
  if (host === undefined || host === null) {
    return [];
  }
  if (typeof host !== 'object') {
    return [`crucibleShell.agentChat must be an object with ${HOST_METHODS.join(', ')}; got ${typeof host}.`];
  }
  return HOST_METHODS.filter(method => typeof host[method] !== 'function').map(method => `crucibleShell.agentChat.${method} must be a function.`);
}

/** The messages of one conversation, the run in progress and the notices. It never touches the page. */
export function createAgentConversation() {
  let messages = [];
  let notices = [];
  let running = false;
  let nextId = 1;

  function push(message) {
    messages.push({ id: nextId, ...message });
    nextId += 1;
    messages = messages.slice(-AGENT_CHAT_LIMITS.messageCount);
  }

  function appendReplyText(text) {
    const last = messages.at(-1);
    if (last?.kind === 'reply') {
      last.text = (last.text + text).slice(0, AGENT_CHAT_LIMITS.replyTextLength);
    } else {
      push({ kind: 'reply', text });
    }
  }

  function putNotice(notice) {
    notices = [...notices.filter(existing => existing.kind !== notice.kind), notice];
  }

  return {
    get messages() { return messages; },
    get notices() { return notices; },
    get running() { return running; },
    /** The person's message starts a run and clears the notices of the one before. */
    addPersonMessage(text) {
      push({ kind: 'person', text: text.slice(0, AGENT_CHAT_LIMITS.personTextLength) });
      notices = [];
      running = true;
    },
    /** Applies one parsed event and returns the node it names, if it names one. */
    apply(event) {
      if (event.type === 'text') {
        appendReplyText(event.text);
      } else if (event.type === 'step') {
        push({ kind: 'step', text: event.label });
        return event.nodeId ?? null;
      } else if (event.type === 'notice') {
        putNotice(event);
      } else {
        push({ kind: 'outcome', outcome: event.type === 'error' ? 'failed' : event.type, text: event.message ?? OUTCOME_TEXT[event.type] });
        running = false;
      }
      return null;
    },
    finishRun() { running = false; },
    clearNotice(kind) { notices = notices.filter(notice => notice.kind !== kind); },
  };
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, AGENT_CHAT_LIMITS.noticeTextLength) || 'The agent stopped with an error.';
}

/**
 * Builds the card for a host that offers a chat, or returns null: no host, or a host that cannot fill the card
 * (the reason goes to the console). `onStep(nodeId)` lets Studio point its agent cursor at the object a step names.
 * The caller puts `dock` in the panel column and keeps the minimize button in step with the preference.
 */
export function createAgentChatCard({ documentReference, createElement, createIcon, createIconButton, watchScrollFade, host, onStep, onMinimize }) {
  const problems = agentChatHostProblems(host);
  if (!host || problems.length > 0) {
    if (problems.length > 0) console.warn(`Studio shows no Agent card. ${problems.join(' ')}`);
    return null;
  }
  const conversation = createAgentConversation();
  const rendered = new Map();

  const minimizeButton = createIconButton(documentReference, 'minimize', 'Minimize Agent', { attributes: { 'aria-expanded': 'true' } });
  minimizeButton.addEventListener('click', onMinimize);
  const list = createElement(documentReference, 'div', { className: 'crucible-studio-agent-list crucible-studio-scroll', attributes: { role: 'log', 'aria-label': 'Conversation' } });
  watchScrollFade(list);
  const emptyMark = createElement(documentReference, 'div', { className: 'crucible-studio-agent-empty', attributes: { 'aria-hidden': 'true' } }, createIcon(documentReference, 'chat'));
  const noticeArea = createElement(documentReference, 'div', { className: 'crucible-studio-agent-notices', attributes: { role: 'status' } });
  const field = createElement(documentReference, 'textarea', {
    className: 'crucible-studio-agent-field',
    rows: 1,
    maxLength: AGENT_CHAT_LIMITS.personTextLength,
    placeholder: 'Ask for a change',
    attributes: { 'aria-label': 'Message to the agent' },
  });
  const sendButton = createElement(documentReference, 'button', { type: 'submit', className: 'crucible-studio-agent-send crucible-studio-primary-btn' });
  const form = createElement(documentReference, 'form', { className: 'crucible-studio-agent-compose' }, field, sendButton);
  const dock = createElement(
    documentReference,
    'aside',
    { className: 'crucible-studio-dock crucible-studio-agent', attributes: { 'aria-label': 'Agent' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-dock-head' },
      createElement(documentReference, 'span', { className: 'crucible-studio-dock-title' }, createIcon(documentReference, 'chat'), createElement(documentReference, 'span', { textContent: 'Agent' })),
      createElement(documentReference, 'span', { className: 'crucible-studio-spacer' }),
      minimizeButton,
    ),
    list,
    noticeArea,
    form,
  );

  function createMessageRow(message) {
    const selectable = message.kind === 'person' || message.kind === 'reply' ? ' crucible-studio-selectable' : '';
    const row = createElement(documentReference, 'div', { className: `crucible-studio-agent-message crucible-studio-agent-${message.kind}${selectable}`, dataset: { kind: message.kind } });
    if (message.kind === 'step' || message.kind === 'outcome') {
      const iconName = message.kind === 'step' ? STEP_ICON : OUTCOME_ICONS[message.outcome];
      if (message.outcome) row.dataset.outcome = message.outcome;
      row.append(createIcon(documentReference, iconName), createElement(documentReference, 'span', { className: 'crucible-studio-agent-line' }));
    }
    return row;
  }

  function writeText(row, text) {
    const target = row.querySelector('.crucible-studio-agent-line') ?? row;
    target.textContent = text;
  }

  function syncMessages() {
    const kept = new Set(conversation.messages.map(message => message.id));
    for (const [id, entry] of rendered) {
      if (!kept.has(id)) {
        entry.row.remove();
        rendered.delete(id);
      }
    }
    for (const message of conversation.messages) {
      let entry = rendered.get(message.id);
      if (!entry) {
        entry = { row: createMessageRow(message), text: null };
        rendered.set(message.id, entry);
        emptyMark.remove();
        list.append(entry.row);
      }
      if (entry.text !== message.text) {
        entry.text = message.text;
        writeText(entry.row, message.text);
      }
    }
    const empty = conversation.messages.length === 0;
    list.dataset.empty = empty ? 'true' : 'false';
    if (empty && !list.contains(emptyMark)) list.append(emptyMark);
  }

  function createNoticeRow(notice) {
    const row = createElement(documentReference, 'div', { className: 'crucible-studio-agent-notice', dataset: { kind: notice.kind } },
      createIcon(documentReference, NOTICE_ICONS[notice.kind]),
      createElement(documentReference, 'span', { className: 'crucible-studio-agent-notice-text', textContent: notice.message }));
    if (notice.actionLabel) {
      const button = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-primary-btn', textContent: notice.actionLabel });
      button.addEventListener('click', () => {
        conversation.clearNotice(notice.kind);
        render();
        runHostCall(() => notice.action());
      });
      row.append(button);
    }
    return row;
  }

  function syncComposer() {
    const running = conversation.running;
    dock.dataset.running = running ? 'true' : 'false';
    sendButton.type = running ? 'button' : 'submit';
    if (running) sendButton.dataset.actionIcon = 'stop';
    else delete sendButton.dataset.actionIcon;
    // Not a span: a primary button hides the spans inside it in a compact window.
    const label = createElement(documentReference, 'strong', { textContent: running ? 'Stop' : 'Send' });
    sendButton.replaceChildren(...(running ? [createIcon(documentReference, 'stop')] : []), label);
  }

  function render() {
    const stuckToBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= STICK_TO_BOTTOM_PIXELS;
    syncMessages();
    if (stuckToBottom) list.scrollTop = list.scrollHeight;
    noticeArea.replaceChildren(...conversation.notices.map(createNoticeRow));
    noticeArea.hidden = conversation.notices.length === 0;
    dock.dataset.notice = conversation.notices.length > 0 ? 'true' : 'false';
    syncComposer();
  }

  // A host that throws must not break Studio: its failure shows in the card like any other error.
  function runHostCall(call) {
    try {
      const result = call();
      result?.catch?.(error => receive({ type: 'error', message: errorText(error) }));
    } catch (error) {
      receive({ type: 'error', message: errorText(error) });
    }
  }

  function receive(event) {
    let parsed;
    try {
      parsed = parseAgentChatEvent(event);
    } catch (error) {
      parsed = { type: 'notice', kind: 'error', message: `The host sent an agent event Studio could not read. ${errorText(error)}`.slice(0, AGENT_CHAT_LIMITS.noticeTextLength) };
    }
    const nodeId = conversation.apply(parsed);
    render();
    if (nodeId) onStep(nodeId);
  }

  async function sendMessage() {
    const text = field.value.trim();
    if (!text || conversation.running) return;
    field.value = '';
    conversation.addPersonMessage(text);
    render();
    try {
      await host.send(text);
    } catch (error) {
      receive({ type: 'error', message: errorText(error) });
    }
    conversation.finishRun();
    render();
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    sendMessage();
  });
  sendButton.addEventListener('click', () => {
    if (conversation.running) runHostCall(() => host.stop());
  });
  field.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendMessage();
  });

  const unsubscribe = host.subscribe(receive);
  render();
  return {
    dock,
    minimizeButton,
    dispose() {
      if (typeof unsubscribe === 'function') unsubscribe();
    },
  };
}

/** The stylesheet of the card, added to Studio's own. Colours, fonts and spacing come from the --studio tokens. */
export const AGENT_CHAT_CSS = `
/* The card at the foot of the column. Its floors (232 px, 288 px with a notice) keep four whole rows in the list; Scene keeps 192 px and
   Properties 240 px beside it. When the window is too short for all three the card and Properties take turns, each keeping its title row (studio.js). */
.crucible-studio-side > .crucible-studio-dock.crucible-studio-agent {
  flex: 0 1 var(--studio-agent-height, 240px);
  min-block-size: 232px;
  max-block-size: 55%;
  inline-size: var(--studio-properties-width, 284px);
}
.crucible-studio-side > .crucible-studio-dock.crucible-studio-agent[data-notice="true"] { min-block-size: 288px; }
.crucible-studio[data-agent-tight="true"] .crucible-studio-side > .crucible-studio-dock.crucible-studio-agent {
  flex: 1 1 0;
  max-block-size: none;
}
.crucible-studio[data-agent-minimized="true"] .crucible-studio-side > .crucible-studio-dock.crucible-studio-agent {
  flex: 0 0 auto;
  min-block-size: 0;
}
.crucible-studio[data-agent-minimized="true"] .crucible-studio-agent > :not(.crucible-studio-dock-head) { display: none; }
.crucible-studio[data-agent-minimized="true"] .crucible-studio-agent > .crucible-studio-dock-head { padding-block-end: 8px; }
.crucible-studio[data-agent-collapsed="false"]:not([data-agent-minimized="true"]):not([data-compact="true"]) .crucible-studio-side > .crucible-studio-outliner {
  flex-shrink: 1;
  min-block-size: 192px;
}
.crucible-studio[data-floating="false"][data-agent-collapsed="false"]:not([data-agent-minimized="true"]):not([data-agent-tight="true"]):not([data-compact="true"]):not([data-scene-sized="true"]):not([data-outliner-minimized="true"]) .crucible-studio-side > .crucible-studio-outliner {
  flex-basis: 30%;
}
.crucible-studio[data-agent-collapsed="false"]:not([data-agent-minimized="true"]):not([data-compact="true"]):not([data-inspector-minimized="true"]) .crucible-studio-side > .crucible-studio-inspector {
  min-block-size: 240px;
}
.crucible-studio[data-agent-collapsed="true"] .crucible-studio-agent { display: none; }
/* With only this card in the column, the axis widget still stands left of it. */
.crucible-studio[data-outliner-collapsed="true"][data-inspector-collapsed="true"][data-history-collapsed="true"][data-agent-collapsed="false"] {
  --studio-gizmo-clear: calc(var(--studio-properties-width, 284px) + var(--studio-edge));
}
.crucible-studio[data-compact="true"] .crucible-studio-agent {
  inset-block-start: auto;
  inset-block-end: 72px;
  inset-inline: calc(var(--studio-edge) * 2 + var(--studio-rail)) var(--studio-edge);
  inline-size: auto;
  max-block-size: min(var(--studio-agent-height, 240px), 60%);
  z-index: 6;
}
/* The card's own edge: dragging the top edge up makes it taller. */
.crucible-studio-grip-agent-height {
  position: absolute;
  inset-inline: 0;
  inset-block-start: 0;
  block-size: 8px;
  cursor: ns-resize;
  z-index: 3;
}
.crucible-studio-grip-agent-height::after {
  inset-inline: 14px;
  inset-block-start: 2px;
  block-size: 2px;
}
.crucible-studio[data-agent-minimized="true"] .crucible-studio-grip-agent-height,
.crucible-studio[data-agent-tight="true"] .crucible-studio-grip-agent-height { display: none; }
/* The list clips at its own box. The fade of the scroll cue is the padding wide, so no glyph is cut half way under the title. */
.crucible-studio-agent-list {
  --studio-scroll-fade: var(--studio-space-8);
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: var(--studio-space-8);
  min-block-size: 128px;
  padding: var(--studio-space-8) var(--studio-space-12);
  overflow-y: auto;
}
.crucible-studio-agent-list[data-empty="true"] { justify-content: center; align-items: center; }
.crucible-studio-agent-empty { color: var(--studio-muted); }
.crucible-studio-agent-empty .crucible-studio-icon { inline-size: 32px; block-size: 32px; }
.crucible-studio-agent-message {
  flex: none;
  min-inline-size: 0;
  font-size: 13px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.crucible-studio-agent-person {
  align-self: flex-end;
  max-inline-size: 88%;
  padding: var(--studio-space-8) var(--studio-space-12);
  border-radius: 8px;
  background: color-mix(in srgb, var(--studio-text) 8%, transparent);
}
/* Quiet, but over 4.5:1 on the panel in both themes: the text colour thinned toward the panel. */
.crucible-studio-agent-step,
.crucible-studio-agent-outcome {
  display: flex;
  align-items: center;
  gap: var(--studio-space-8);
  color: color-mix(in srgb, var(--studio-text) 76%, var(--studio-panel));
  font-size: 12px;
  white-space: nowrap;
}
.crucible-studio-agent-send strong { font-weight: inherit; }
.crucible-studio-agent-line { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; }
.crucible-studio-agent-outcome[data-outcome="done"] .crucible-studio-icon { color: var(--studio-ok); }
.crucible-studio-agent-outcome[data-outcome="failed"] .crucible-studio-icon { color: var(--studio-warning); }
.crucible-studio-agent-notices {
  display: grid;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8) var(--studio-space-12);
}
.crucible-studio-agent-notices[hidden] { display: none; }
.crucible-studio-agent-notice {
  display: flex;
  align-items: center;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8);
  border-radius: 8px;
  background: color-mix(in srgb, var(--studio-text) 8%, transparent);
  font-size: 12px;
}
.crucible-studio-agent-notice-text { flex: 1 1 auto; min-inline-size: 0; overflow-wrap: anywhere; }
/* A button on the notice's own surface needs a stronger fill than one on the panel to read as a button. */
.crucible-studio-agent button.crucible-studio-primary-btn {
  flex: none;
  padding-inline: var(--studio-space-12);
  background: color-mix(in srgb, var(--studio-text) 7%, transparent);
}
.crucible-studio-agent-notice button.crucible-studio-primary-btn {
  min-block-size: 28px;
  background: color-mix(in srgb, var(--studio-text) 14%, transparent);
}
.crucible-studio-agent-compose {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8) var(--studio-space-12);
}
.crucible-studio-agent button.crucible-studio-agent-send { min-block-size: 36px; }
/* Send is the card's one primary action, filled the way the primary button of a dialog is; Stop keeps the quiet wash. */
.crucible-studio-agent button.crucible-studio-agent-send:not([data-action-icon]) {
  background: var(--studio-text);
  color: var(--studio-bg);
}
@media (hover: hover) {
  .crucible-studio-agent button.crucible-studio-agent-send:not([data-action-icon]):not([aria-disabled="true"]):not([aria-pressed="true"]):hover {
    background: color-mix(in srgb, var(--studio-text) 86%, var(--studio-bg));
  }
}
/* Named with its element so it outranks the rule every Studio textarea shares. */
.crucible-studio-agent textarea.crucible-studio-agent-field {
  flex: 1 1 auto;
  min-inline-size: 0;
  min-block-size: 36px;
  max-block-size: 96px;
  padding: var(--studio-space-8);
  border: 1px solid var(--studio-border);
  border-radius: var(--studio-radius-control);
  background: var(--studio-surface);
  font-size: 13px;
  line-height: 18px;
  resize: none;
  field-sizing: content;
}
.crucible-studio-agent textarea.crucible-studio-agent-field::placeholder {
  color: color-mix(in srgb, var(--studio-text) 76%, var(--studio-surface));
  opacity: 1;
}
`;
