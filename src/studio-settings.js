// The Settings dialog: a short list of sections down the left, the chosen section's rows beside it. Each section has an
// icon at its title, so a person finds a place by its picture. The Account section exists only when the host page
// offers an account (studio-account.js).
import { KEYMAP_PRESETS } from './studio-keymap.js';
import { STUDIO_PREFERENCE_CHOICES } from './studio-preferences.js';
import { createAccountSection, STUDIO_SETTINGS_ACTION_ICONS } from './studio-account.js';
import { leadWithActionIcon } from './studio-icons.js';

const capitalised = value => value[0].toUpperCase() + value.slice(1);
const MOTION_LABELS = Object.freeze({ system: 'Follow system', reduced: 'Reduced' });
const ZOOM_LABELS = Object.freeze({ normal: 'Normal', inverted: 'Inverted' });

// A row is [preference, label, how a choice reads]; a preference without choices is a switch.
export const STUDIO_SETTING_SECTIONS = Object.freeze([
  {
    id: 'interface',
    title: 'Interface',
    icon: 'panels',
    rows: [
      ['theme', 'Theme', capitalised],
      ['startWorkspace', 'Open in', capitalised],
      ['panelsFloating', 'Floating panels'],
      ['motion', 'Motion', value => MOTION_LABELS[value]],
    ],
  },
  {
    id: 'viewport',
    title: 'Viewport',
    icon: 'camera',
    rows: [
      ['performance', 'Performance', capitalised],
      ['gridVisible', 'Grid'],
      ['readoutVisible', 'Camera and size readout'],
      ['viewWidgetVisible', 'Axis widget'],
      ['agentCursorVisible', 'Agent cursor'],
      ['gizmoSize', 'Handle size', capitalised],
      ['zoomDirection', 'Zoom direction', value => ZOOM_LABELS[value]],
    ],
  },
  {
    id: 'editing',
    title: 'Editing',
    icon: 'translate',
    rows: [
      ['moveSnapStep', 'Move snap step', value => `${value} m`],
      ['rotateSnapDegrees', 'Rotate snap angle', value => `${value}°`],
    ],
  },
  {
    id: 'keys',
    title: 'Keys',
    icon: 'keyboard',
    rows: [['keymap', 'Preset', value => KEYMAP_PRESETS[value].label]],
  },
]);

/**
 * Builds the dialog. `onChange(name, value)` writes one preference, `onReset()` returns every preference to its default,
 * `onRunSetup()` and `onOpenShortcuts()` open the dialogs of those names. Returns the dialog, a map of preference to its
 * control, `open()` and `dispose()`.
 */
export function createStudioSettings({ documentReference, createElement, createIcon, shell, onChange, onReset, onRunSetup, onOpenShortcuts }) {
  const controls = new Map();
  const account = createAccountSection({ documentReference, createElement, createIcon, shell });

  function createRow([name, label, describeChoice]) {
    const choices = STUDIO_PREFERENCE_CHOICES[name];
    const control = choices
      ? createElement(documentReference, 'select', {}, ...choices.map(choice => createElement(documentReference, 'option', { value: String(choice), textContent: describeChoice(choice) })))
      : createElement(documentReference, 'input', { type: 'checkbox' });
    control.dataset.setting = name;
    control.addEventListener('change', () => {
      onChange(name, choices ? choices.find(choice => String(choice) === control.value) : control.checked);
    });
    controls.set(name, control);
    return createElement(documentReference, 'label', { className: 'crucible-studio-setting' }, createElement(documentReference, 'span', { textContent: label }), control);
  }

  function createShortcutsRow() {
    const button = createElement(documentReference, 'button', { type: 'button', textContent: 'Show', attributes: { 'aria-label': 'Show keyboard shortcuts' } });
    button.addEventListener('click', onOpenShortcuts);
    return createElement(documentReference, 'div', { className: 'crucible-studio-setting' }, createElement(documentReference, 'span', { textContent: 'Shortcuts' }), button);
  }

  const sections = STUDIO_SETTING_SECTIONS.map(section => ({
    ...section,
    body: [...section.rows.map(createRow), ...(section.id === 'keys' ? [createShortcutsRow()] : [])],
  }));
  if (account) {
    sections.push({ id: 'account', title: 'Account', icon: 'account', body: [account.element] });
  }

  const navButtons = new Map();
  const panes = new Map();
  for (const section of sections) {
    const button = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-settings-section', dataset: { section: section.id } },
      createIcon(documentReference, section.icon),
      createElement(documentReference, 'span', { textContent: section.title }),
    );
    button.setAttribute('aria-label', section.title);
    button.addEventListener('click', () => showSection(section.id));
    navButtons.set(section.id, button);
    panes.set(section.id, createElement(
      documentReference,
      'section',
      { className: 'crucible-studio-settings-pane', dataset: { section: section.id }, attributes: { 'aria-labelledby': `crucible-studio-settings-${section.id}-title` } },
      createElement(documentReference, 'h3', { id: `crucible-studio-settings-${section.id}-title` }, createIcon(documentReference, section.icon), createElement(documentReference, 'span', { textContent: section.title })),
      createElement(documentReference, 'div', { className: 'crucible-studio-settings-rows' }, ...section.body),
    ));
  }

  function showSection(sectionId) {
    for (const [id, pane] of panes) {
      const current = id === sectionId;
      pane.dataset.current = String(current);
      navButtons.get(id).dataset.current = String(current);
      navButtons.get(id).setAttribute('aria-current', current ? 'true' : 'false');
    }
  }
  showSection(sections[0].id);

  const settingsHeading = createElement(documentReference, 'h2', { id: 'crucible-studio-settings-title', textContent: 'Settings' });
  settingsHeading.prepend(createIcon(documentReference, 'settings'));
  const resetButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Reset' });
  leadWithActionIcon(resetButton, createIcon(documentReference, STUDIO_SETTINGS_ACTION_ICONS.reset), STUDIO_SETTINGS_ACTION_ICONS.reset);
  resetButton.addEventListener('click', onReset);
  const setupButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-settings-quiet', textContent: 'Run setup again' });
  leadWithActionIcon(setupButton, createIcon(documentReference, STUDIO_SETTINGS_ACTION_ICONS.runSetup), STUDIO_SETTINGS_ACTION_ICONS.runSetup);
  setupButton.addEventListener('click', onRunSetup);
  const dialog = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-settings-dialog', tabIndex: -1, attributes: { 'aria-labelledby': 'crucible-studio-settings-title', closedby: 'any' } },
    settingsHeading,
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-settings-body' },
      createElement(documentReference, 'nav', { className: 'crucible-studio-settings-nav', attributes: { 'aria-label': 'Settings sections' } }, ...navButtons.values()),
      createElement(documentReference, 'div', { className: 'crucible-studio-settings' }, ...panes.values()),
    ),
    createElement(
      documentReference,
      'form',
      { method: 'dialog', className: 'crucible-studio-dialog-actions' },
      setupButton,
      resetButton,
      createElement(documentReference, 'button', { type: 'submit', value: 'close', className: 'crucible-studio-dialog-primary', textContent: 'Done' }),
    ),
  );
  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
  });

  return {
    dialog,
    controls,
    account,
    showSection,
    // Every opening looks the same: the first section, with focus on the dialog itself, so no control carries a focus ring and the
    // first Tab lands on the first section in the list (the way the setup dialog opens).
    open() {
      account?.refresh();
      showSection(sections[0].id);
      dialog.showModal();
      dialog.focus();
    },
    dispose() {
      account?.dispose();
    },
  };
}
