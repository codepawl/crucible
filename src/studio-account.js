// The Account section of Settings. Studio holds no token and makes no network call: a host page that offers sign-in
// hands over `globalThis.crucibleShell.account`, and this file only shows what that object reports and calls the
// functions it gives. The contract is written in docs/studio.md ("Account").

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

/** Puts an action's icon before the label of its button and marks the button; the label stays its accessible name. */
export function leadWithActionIcon(button, icon, iconName) {
  const label = button.ownerDocument.createElement('span');
  label.textContent = button.textContent;
  button.dataset.actionIcon = iconName;
  button.replaceChildren(icon, label);
  return button;
}

const FALLBACK_SIGN_IN_ERROR = 'Sign in did not finish.';
const FALLBACK_ACTION_ERROR = 'That did not work.';

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
 * when the host has no such function. The older `builtInAgent` ({ isSignedIn(), signIn() }) gives state and sign in only.
 * Returns null when the page offers neither, so Settings shows no Account section.
 */
export function resolveAccountHost(shell) {
  const account = shell?.account;
  if (account && typeof account.get === 'function') {
    const call = name => (typeof account[name] === 'function' ? () => account[name]() : null);
    return {
      read: async () => normalizeAccountInfo(await account.get()),
      signIn: call('signIn'),
      signOut: call('signOut'),
      buyCredits: call('buyCredits'),
      manageBilling: call('manageBilling'),
    };
  }
  const agent = shell?.builtInAgent;
  if (agent && typeof agent.isSignedIn === 'function') {
    return {
      read: async () => ({ ...normalizeAccountInfo(null), signedIn: Boolean(await agent.isSignedIn()) }),
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

  function valueRow(label, value) {
    return createElement(documentReference, 'div', { className: 'crucible-studio-setting' }, text('', label), text('crucible-studio-account-value', value));
  }

  function actionButton(label, iconName, run, fallbackError, { disabled = false } = {}) {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: label, disabled });
    leadWithActionIcon(button, createIcon(documentReference, iconName), iconName);
    button.addEventListener('click', () => run().catch(error => {
      errorText = textOrNull(error?.message) ?? fallbackError;
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
      errorText = textOrNull(error?.message) ?? FALLBACK_SIGN_IN_ERROR;
    }
    await refresh({ keepError: true });
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
      if (host.manageBilling) buttons.push(actionButton('Manage billing', STUDIO_SETTINGS_ACTION_ICONS.manageBilling, async () => host.manageBilling(), FALLBACK_ACTION_ERROR));
    } else if (host.signIn && phase !== 'loading') {
      buttons.push(actionButton(phase === 'waiting' ? 'Waiting' : 'Sign in', STUDIO_SETTINGS_ACTION_ICONS.signIn, signIn, FALLBACK_SIGN_IN_ERROR, { disabled: phase === 'waiting' }));
    }
    return buttons.length ? createElement(documentReference, 'div', { className: 'crucible-studio-account-actions' }, ...buttons) : null;
  }

  function render() {
    element.dataset.phase = phase;
    const signedIn = phase === 'signed-in';
    const rows = [statusRow(), signedIn ? whoRow() : null];
    if (signedIn && info.remainingText) rows.push(valueRow('Left to use', info.remainingText));
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
  async function refresh({ keepError = false } = {}) {
    const ticket = latestRead + 1;
    latestRead = ticket;
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
      errorText = textOrNull(error?.message) ?? 'The account could not be read.';
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
    dispose: () => documentReference.removeEventListener(ACCOUNT_CHANGED_EVENT, onAccountChanged),
  };
}
