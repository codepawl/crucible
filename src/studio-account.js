// The Account section of Settings. Studio holds no token and makes no network call: a host page that offers sign-in
// hands over `globalThis.crucibleShell.account`, and this file only shows what that object reports and calls the
// functions it gives. The contract is written in docs/studio.md ("Account").

import { leadWithActionIcon } from './studio-icons.js';

export const ACCOUNT_CHANGED_EVENT = 'crucible-shell:account-changed';

/** The icon each action of Settings leads with. Done only closes the dialog, so it has none. No two share one. */
export const STUDIO_SETTINGS_ACTION_ICONS = Object.freeze({
  signIn: 'signIn',
  signOut: 'signOut',
  buyCredits: 'buyMore',
  manageBilling: 'card',
  runSetup: 'play',
  reset: 'reset',
});

const FALLBACK_SIGN_IN_ERROR = 'Sign in did not finish.';
const FALLBACK_ACTION_ERROR = 'That did not work.';
const FALLBACK_BILLING_ERROR = 'Billing could not be opened.';
const MESSAGE_LENGTH_LIMIT = 200;

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A message from the host as plain text of at most 200 characters, or null when it has none. */
function boundedMessage(value) {
  const text = textOrNull(value);
  return text === null ? null : text.slice(0, MESSAGE_LENGTH_LIMIT).trim();
}

/** Whether the host says someone is signed in. A plain boolean or a promise of one; a rejection counts as signed out. */
async function readSignedIn(source) {
  try {
    return Boolean(await Promise.resolve(source.isSignedIn()));
  } catch {
    return false;
  }
}

/** The state from `isSignedIn()`, and the optional fields from `get()` only while someone is signed in. Without `isSignedIn`, `get()` reports it all. */
async function readAccount(account) {
  if (typeof account.isSignedIn !== 'function') {
    return normalizeAccountInfo(await account.get());
  }
  const signedIn = await readSignedIn(account);
  const fields = signedIn && typeof account.get === 'function' ? normalizeAccountInfo(await account.get()) : normalizeAccountInfo(null);
  return { ...fields, signedIn };
}

/** What the host's account object reports, with every field checked: a wrong type counts as missing. */
export function normalizeAccountInfo(report) {
  return {
    signedIn: report?.signedIn === true,
    name: textOrNull(report?.name),
    email: textOrNull(report?.email),
    remainingText: textOrNull(report?.remainingText),
    planText: textOrNull(report?.planText),
  };
}

/**
 * The host's account object as one shape: { read, signIn, signOut, buyCredits, manageBilling }, the last three missing
 * when the host has no such function. `account.isSignedIn()` (a boolean or a promise of one) gives the state, `account.get()`
 * the optional fields. The older `builtInAgent` ({ isSignedIn(), signIn() }) gives state and sign in only.
 * Returns null when the page offers neither, so Settings shows no Account section.
 */
export function resolveAccountHost(shell) {
  const account = shell?.account;
  if (account && (typeof account.get === 'function' || typeof account.isSignedIn === 'function')) {
    const call = name => (typeof account[name] === 'function' ? () => account[name]() : null);
    return {
      read: () => readAccount(account),
      signIn: call('signIn'),
      signOut: call('signOut'),
      buyCredits: call('buyCredits'),
      manageBilling: call('manageBilling'),
    };
  }
  const agent = shell?.builtInAgent;
  if (agent && typeof agent.isSignedIn === 'function') {
    return {
      read: async () => ({ ...normalizeAccountInfo(null), signedIn: await readSignedIn(agent) }),
      signIn: typeof agent.signIn === 'function' ? () => agent.signIn() : null,
      signOut: null,
      buyCredits: null,
      manageBilling: null,
    };
  }
  return null;
}

function initialOf(info) {
  const source = info.name ?? info.email ?? '';
  return Array.from(source)[0]?.toUpperCase() ?? '';
}

/** The Account section body, or null when the host offers no account. `dispose` removes its listener on `document`. */
export function createAccountSection({ documentReference, createElement, createIcon, shell }) {
  const host = resolveAccountHost(shell);
  if (!host) {
    return null;
  }
  let phase = 'loading';
  let info = normalizeAccountInfo(null);
  let errorText = '';
  let latestRead = 0;
  const element = createElement(documentReference, 'div', { className: 'crucible-studio-account', dataset: { phase } });

  const text = (className, content) => createElement(documentReference, 'span', { className, textContent: content });
  const iconWithText = (iconName, content, className) => createElement(documentReference, 'div', { className }, createIcon(documentReference, iconName), text('', content));

  function statusRow() {
    const states = {
      loading: ['tierAutomatic', 'Checking account'],
      waiting: ['tierAutomatic', 'Waiting for sign-in to finish'],
      'signed-out': ['lock', 'Signed out'],
      'signed-in': ['check', 'Signed in'],
    };
    const [iconName, label] = states[phase];
    return iconWithText(iconName, label, 'crucible-studio-account-status');
  }

  function whoRow() {
    if (!info.name && !info.email) {
      return null;
    }
    const lines = [info.name, info.email].filter(Boolean).map((line, index) => text(index === 0 ? 'crucible-studio-account-name' : 'crucible-studio-account-email', line));
    return createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-account-who' },
      createElement(documentReference, 'span', { className: 'crucible-studio-account-avatar', textContent: initialOf(info), attributes: { 'aria-hidden': 'true' } }),
      createElement(documentReference, 'div', { className: 'crucible-studio-account-lines' }, ...lines),
    );
  }

  function valueRow(label, value, iconName = null) {
    const valueElement = text('crucible-studio-account-value', value);
    if (iconName) valueElement.prepend(createIcon(documentReference, iconName));
    return createElement(documentReference, 'div', { className: 'crucible-studio-setting' }, text('', label), valueElement);
  }

  function actionButton(label, iconName, run, fallbackError, { disabled = false } = {}) {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: label, disabled });
    leadWithActionIcon(button, createIcon(documentReference, iconName), iconName);
    button.addEventListener('click', () => run().catch(error => {
      errorText = boundedMessage(error?.message) ?? fallbackError;
      render();
    }));
    return button;
  }

  async function signIn() {
    phase = 'waiting';
    errorText = '';
    render();
    try {
      await host.signIn();
    } catch (error) {
      errorText = boundedMessage(error?.message) ?? FALLBACK_SIGN_IN_ERROR;
    }
    await refresh({ keepError: true });
  }

  /** Billing resolves with { opened, reason? }; `opened: false` shows the reason the way a failed action shows its message. */
  async function openBilling() {
    errorText = '';
    const outcome = await host.manageBilling();
    if (outcome?.opened === false) {
      errorText = boundedMessage(outcome.reason) ?? FALLBACK_BILLING_ERROR;
      render();
    }
  }

  async function runThenRefresh(action) {
    errorText = '';
    await action();
    await refresh();
  }

  function actionRow() {
    const buttons = [];
    if (phase === 'signed-in') {
      if (host.signOut) buttons.push(actionButton('Sign out', STUDIO_SETTINGS_ACTION_ICONS.signOut, () => runThenRefresh(host.signOut), FALLBACK_ACTION_ERROR));
      if (host.buyCredits) buttons.push(actionButton('Buy more', STUDIO_SETTINGS_ACTION_ICONS.buyCredits, async () => host.buyCredits(), FALLBACK_ACTION_ERROR));
      if (host.manageBilling) buttons.push(actionButton('Manage billing', STUDIO_SETTINGS_ACTION_ICONS.manageBilling, openBilling, FALLBACK_ACTION_ERROR));
    } else if (host.signIn && phase !== 'loading') {
      buttons.push(actionButton(phase === 'waiting' ? 'Waiting' : 'Sign in', STUDIO_SETTINGS_ACTION_ICONS.signIn, signIn, FALLBACK_SIGN_IN_ERROR, { disabled: phase === 'waiting' }));
    }
    return buttons.length ? createElement(documentReference, 'div', { className: 'crucible-studio-account-actions' }, ...buttons) : null;
  }

  function render() {
    element.dataset.phase = phase;
    const signedIn = phase === 'signed-in';
    const rows = [statusRow(), signedIn ? whoRow() : null];
    if (signedIn && info.remainingText) rows.push(valueRow('Left to use', info.remainingText, 'creditToken'));
    if (signedIn && info.planText) rows.push(valueRow('Plan', info.planText));
    if (errorText) {
      const problem = iconWithText('warning', errorText, 'crucible-studio-account-error');
      problem.setAttribute('role', 'alert');
      rows.push(problem);
    }
    rows.push(actionRow());
    element.replaceChildren(...rows.filter(Boolean));
  }

  /** Asks the host again who is signed in. A slower answer to an earlier ask is dropped. */
  async function refresh({ keepError = false, showLoading = false } = {}) {
    const ticket = latestRead + 1;
    latestRead = ticket;
    if (showLoading) {
      phase = 'loading';
      errorText = '';
      render();
    }
    try {
      const reported = await host.read();
      if (ticket !== latestRead) return;
      info = reported;
      phase = info.signedIn ? 'signed-in' : 'signed-out';
      if (!keepError) errorText = '';
    } catch (error) {
      if (ticket !== latestRead) return;
      info = normalizeAccountInfo(null);
      phase = 'signed-out';
      errorText = boundedMessage(error?.message) ?? 'The account could not be read.';
    }
    render();
  }

  const onAccountChanged = () => refresh();
  documentReference.addEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged);
  render();
  refresh();
  return {
    element,
    refresh,
    /** Drops an answer that is still on its way, so Settings closing before the host replies changes nothing. */
    discardPending: () => { latestRead += 1; },
    dispose: () => documentReference.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged),
  };
}
