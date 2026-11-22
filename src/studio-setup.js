// The first-run setup dialog: five steps of choice cards (theme, performance, modelling, keys, working with an agent) that
// change the live Studio behind it, one step a page. It is built from the preferences Studio already keeps, so nothing
// here is saved anywhere new.
import { KEYMAP_PRESET_IDS, KEYMAP_PRESETS, keyLabel, resolveKeymapPreset } from './studio-keymap.js';
import { STUDIO_PREFERENCE_CHOICES } from './studio-preferences.js';
import { STUDIO_TOOLS } from './studio-templates.js';

const THEME_CHOICES = Object.freeze([
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]);

const PERFORMANCE_CHOICES = Object.freeze([
  { value: 'automatic', label: 'Automatic', icon: 'tierAutomatic' },
  { value: 'light', label: 'Light', icon: 'tierLight' },
  { value: 'balanced', label: 'Balanced', icon: 'tierBalanced' },
  { value: 'sharp', label: 'Sharp', icon: 'tierSharp' },
]);

const MODELLING_ROWS = Object.freeze([
  { name: 'moveSnapStep', label: 'Move snap', icon: 'translate', describe: value => `${value} m` },
  { name: 'rotateSnapDegrees', label: 'Rotate snap', icon: 'rotate', describe: value => `${value}°` },
  { name: 'gizmoSize', label: 'Handle size', icon: 'handle', describe: capitalize },
  { name: 'startWorkspace', label: 'Open in', icon: 'panels', describe: capitalize },
]);

// Each keymap shows the logo of the program whose keys it follows and four of its real keys: the three tools and Frame.
const KEYMAP_LOGOS = Object.freeze({ crucible: 'brandBlender', maya: 'brandMaya', cinema4d: 'brandCinema4d' });
const KEYMAP_SAMPLE_KEYS = Object.freeze([
  { icon: 'translate', actionId: 'tool.translate' },
  { icon: 'rotate', actionId: 'tool.rotate' },
  { icon: 'scale', actionId: 'tool.scale' },
  { icon: 'frame', actionId: 'view.frame' },
]);

// The icons Studio's own workspace tabs use, so a chip shows the workspace it opens.
const WORKSPACE_ICONS = Object.freeze({ build: 'node', look: 'material', animate: 'play' });

// What the rail of a miniature holds, grouped as the real rail groups them: the tools, the scene edits, the switches.
const MINIATURE_RAIL_GROUPS = Object.freeze([STUDIO_TOOLS, ['add', 'undo', 'redo'], ['grid', 'panels']]);

let setupInstanceCount = 0;

function capitalize(word) {
  return word[0].toUpperCase() + word.slice(1);
}

function formatRatio(pixelRatio) {
  return `${Number(pixelRatio.toFixed(2))}x`;
}

/**
 * A miniature of the real Studio chrome in one theme, made of the real Studio classes so the real stylesheet draws it:
 * the top bar, the tool rail with its icons, the viewport as a plain block and the two panel cards as empty surfaces.
 * It is a Studio root of its own with data-theme set, so the theme's tokens resolve again on that element and its
 * --studio-* colours follow the theme it shows, whatever theme the Studio around the dialog is in.
 */
function createStudioMiniature(documentReference, createElement, createIcon, theme, half = null) {
  const railGroups = MINIATURE_RAIL_GROUPS.map(iconNames => createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-group' },
    ...iconNames.map(iconName => createElement(
      documentReference,
      'button',
      { type: 'button', dataset: { icon: iconName }, attributes: { tabindex: '-1', 'aria-pressed': iconName === 'select' ? 'true' : null } },
      createIcon(documentReference, iconName),
    )),
  ));
  const rail = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-toolbar crucible-studio-island' },
    railGroups[0],
    railGroups[1],
    createElement(documentReference, 'div', { className: 'crucible-studio-toolbar-rule' }),
    railGroups[2],
  );
  const cards = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-side' },
    createElement(documentReference, 'div', { className: 'crucible-studio-dock crucible-studio-outliner' }),
    createElement(documentReference, 'div', { className: 'crucible-studio-dock crucible-studio-inspector' }),
  );
  const miniature = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio crucible-studio-miniature', dataset: { theme, floating: 'false' } },
    createElement(documentReference, 'div', { className: 'crucible-studio-viewport' }),
    createElement(documentReference, 'header', { className: 'crucible-studio-menubar' }),
    rail,
    cards,
  );
  if (half) {
    miniature.dataset.half = half;
  }
  return miniature;
}

// The cards are built empty and filled with their miniatures the first time the dialog opens, once, so Studio's start
// costs nothing for a dialog that may never be shown. The miniatures are inert and hidden from assistive technology.
function createThemePreview(documentReference, createElement) {
  const preview = createElement(documentReference, 'span', { className: 'crucible-studio-setup-preview', attributes: { 'aria-hidden': 'true' } });
  preview.inert = true;
  return preview;
}

function fillThemePreview(documentReference, createElement, createIcon, preview, theme) {
  const miniatures = theme === 'system'
    ? [createStudioMiniature(documentReference, createElement, createIcon, 'light', 'left'), createStudioMiniature(documentReference, createElement, createIcon, 'dark', 'right')]
    : [createStudioMiniature(documentReference, createElement, createIcon, theme)];
  preview.append(...miniatures);
}

export function createStudioSetup({
  documentReference,
  createElement,
  createIcon,
  readPreferences,
  changePreferences,
  describeHardware,
  viewportSettingsForTier,
  agentPromptText,
  copyAgentPrompt,
  onClose,
}) {
  setupInstanceCount += 1;
  const instanceId = setupInstanceCount;
  const radios = [];
  let stepIndex = 0;
  let previewsFilled = false;
  const themePreviews = [];

  // One radio per card, so the arrow keys, Tab and a screen reader work without any script. The radio sits invisibly
  // over the card; the card shows a check mark when chosen, so the choice is never shown by colour alone.
  function createChoiceCard({ groupName, preferenceName, value, preview, iconName, label, details = [] }) {
    const radio = createElement(documentReference, 'input', { type: 'radio', name: `crucible-studio-setup-${instanceId}-${groupName}`, value: String(value) });
    radio.dataset.setup = preferenceName;
    radio.addEventListener('change', () => {
      if (radio.checked) {
        changePreferences({ [preferenceName]: STUDIO_PREFERENCE_CHOICES[preferenceName].find(choice => String(choice) === radio.value) });
      }
    });
    radios.push(radio);
    const labelRow = createElement(
      documentReference,
      'span',
      { className: 'crucible-studio-setup-card-name' },
      ...(iconName ? [createIcon(documentReference, iconName)] : []),
      createElement(documentReference, 'span', { className: 'crucible-studio-setup-card-label', textContent: label }),
    );
    return createElement(
      documentReference,
      'label',
      { className: 'crucible-studio-setup-card' },
      radio,
      ...(preview ? [preview] : []),
      labelRow,
      ...details,
      createElement(documentReference, 'span', { className: 'crucible-studio-setup-check' }, createIcon(documentReference, 'check')),
    );
  }

  function createCardGroup(groupLabel, cards, className = '') {
    return createElement(
      documentReference,
      'div',
      { className: `crucible-studio-setup-cards ${className}`.trim(), attributes: { role: 'radiogroup', 'aria-label': groupLabel } },
      ...cards,
    );
  }

  const themeCards = THEME_CHOICES.map(({ value, label }) => {
    const preview = createThemePreview(documentReference, createElement);
    themePreviews.push({ preview, theme: value });
    return createChoiceCard({ groupName: 'theme', preferenceName: 'theme', value, label, preview });
  });

  // Each tier card shows what the tier gives on this screen: the pixel ratio and the anti-aliasing samples.
  const performanceFacts = [];
  function createFacts(tier) {
    const ratio = createElement(documentReference, 'span', { className: 'crucible-studio-setup-fact' });
    const antiAliasing = createElement(documentReference, 'span', { className: 'crucible-studio-setup-fact' });
    performanceFacts.push({ tier, ratio, antiAliasing });
    return createElement(documentReference, 'span', { className: 'crucible-studio-setup-facts' }, ratio, antiAliasing);
  }
  // Automatic gives no numbers of its own: it names the tier it picks here and the hardware that decided it.
  const automaticPick = createElement(documentReference, 'span', { className: 'crucible-studio-setup-facts' });
  const hardwareLine = createElement(documentReference, 'span', { className: 'crucible-studio-setup-card-detail' });
  const performanceCards = PERFORMANCE_CHOICES.map(({ value, label, icon }) => {
    const automatic = value === 'automatic';
    return createChoiceCard({
      groupName: 'performance',
      preferenceName: 'performance',
      value,
      label,
      iconName: icon,
      details: automatic ? [automaticPick, hardwareLine] : [createFacts(value)],
    });
  });

  const modellingRows = MODELLING_ROWS.map(({ name, label, icon, describe }) => {
    const cards = STUDIO_PREFERENCE_CHOICES[name].map(value => createChoiceCard({
      groupName: name,
      preferenceName: name,
      value,
      label: describe(value),
      iconName: name === 'startWorkspace' ? WORKSPACE_ICONS[value] : null,
      preview: name === 'gizmoSize' ? createElement(documentReference, 'span', { className: 'crucible-studio-setup-handle', dataset: { size: value } }) : null,
    }));
    return createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-setup-row' },
      createElement(
        documentReference,
        'span',
        { className: 'crucible-studio-setup-row-label' },
        createIcon(documentReference, icon),
        createElement(documentReference, 'span', { textContent: label }),
      ),
      createCardGroup(label, cards, 'crucible-studio-setup-chips'),
    );
  });

  // Each key cap is read from the resolved keymap, so a card never shows a key the preset does not have.
  function createKeycaps(presetId) {
    const presetKeymap = resolveKeymapPreset(presetId);
    return createElement(
      documentReference,
      'span',
      { className: 'crucible-studio-setup-keycaps' },
      ...KEYMAP_SAMPLE_KEYS.map(({ icon, actionId }) => createElement(
        documentReference,
        'span',
        { className: 'crucible-studio-setup-keycap' },
        createIcon(documentReference, icon),
        createElement(documentReference, 'kbd', { textContent: keyLabel(presetKeymap, actionId) }),
      )),
    );
  }
  const keymapCards = KEYMAP_PRESET_IDS.map(presetId => createChoiceCard({
    groupName: 'keymap',
    preferenceName: 'keymap',
    value: presetId,
    label: KEYMAP_PRESETS[presetId].label,
    iconName: KEYMAP_LOGOS[presetId],
    details: [createKeycaps(presetId)],
  }));

  // The agent step shows the prompt itself, and the button copies it.
  const promptBlock = createElement(documentReference, 'textarea', {
    className: 'crucible-studio-setup-prompt',
    readOnly: true,
    rows: 5,
    attributes: { 'aria-label': 'Prompt for the agent' },
  });
  const copyPromptButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-action' });
  function showCopied(copied) {
    copyPromptButton.replaceChildren(
      createIcon(documentReference, copied ? 'check' : 'agent'),
      createElement(documentReference, 'span', { textContent: copied ? 'Copied' : 'Copy an agent prompt' }),
    );
  }
  showCopied(false);
  copyPromptButton.addEventListener('click', async () => {
    showCopied(await copyAgentPrompt());
  });

  const groups = [
    { title: 'Theme', stepName: 'Theme', icon: 'theme', content: [createCardGroup('Theme', themeCards, 'crucible-studio-setup-cards-theme')] },
    { title: 'Performance', stepName: 'Performance', icon: 'speed', content: [createCardGroup('Performance', performanceCards, 'crucible-studio-setup-cards-wide')] },
    { title: 'Modelling', stepName: 'Modelling', icon: 'node', content: modellingRows },
    { title: 'Keys', stepName: 'Keys', icon: 'keyboard', content: [createCardGroup('Keys', keymapCards, 'crucible-studio-setup-cards-keys')] },
    { title: 'Work with an AI agent', stepName: 'AI agent', icon: 'agent', content: [createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-setup-agent' },
      createElement(documentReference, 'span', { className: 'crucible-studio-setup-agent-mark' }, createIcon(documentReference, 'chat')),
      promptBlock,
      copyPromptButton,
    )] },
  ];
  const sections = groups.map(({ title, content }, index) => createElement(
    documentReference,
    'section',
    { className: 'crucible-studio-setup-group', dataset: { fill: String(content.length === 1) }, attributes: { 'aria-labelledby': `crucible-studio-setup-${instanceId}-title-${index}` } },
    createElement(documentReference, 'h3', { id: `crucible-studio-setup-${instanceId}-title-${index}`, textContent: title }),
    ...content,
  ));

  const stepButtons = groups.map(({ stepName, icon }, index) => {
    const button = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-setup-step' },
      createIcon(documentReference, icon),
      createElement(documentReference, 'span', { textContent: stepName }),
    );
    button.addEventListener('click', () => {
      stepIndex = index;
      showStep();
      focusDialog();
    });
    return button;
  });
  const stepRow = createElement(documentReference, 'div', { className: 'crucible-studio-setup-steps' }, ...stepButtons);
  const skipButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-skip', textContent: 'Skip' });
  const backButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Back' });
  const nextButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-primary', textContent: 'Next' });
  const doneButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-primary', textContent: 'Done' });

  const dialog = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-setup-dialog', tabIndex: -1, attributes: { 'aria-labelledby': `crucible-studio-setup-${instanceId}-heading` } },
    createElement(documentReference, 'h2', { id: `crucible-studio-setup-${instanceId}-heading`, textContent: 'Set up Studio' }),
    stepRow,
    createElement(documentReference, 'div', { className: 'crucible-studio-setup-body' }, ...sections),
    createElement(documentReference, 'div', { className: 'crucible-studio-dialog-actions crucible-studio-setup-actions' }, skipButton, backButton, nextButton, doneButton),
  );
  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
    onClose();
  });

  function showStep() {
    const lastStep = stepIndex === groups.length - 1;
    sections.forEach((section, index) => {
      // Every step sits in one grid cell, so the dialog is as tall as the tallest and never jumps; a step that is not shown is invisible and inert.
      section.inert = index !== stepIndex;
    });
    stepButtons.forEach((button, index) => {
      button.dataset.current = String(index === stepIndex);
      if (index === stepIndex) {
        button.setAttribute('aria-current', 'step');
      } else {
        button.removeAttribute('aria-current');
      }
    });
    backButton.hidden = stepIndex === 0;
    nextButton.hidden = lastStep;
    doneButton.hidden = !lastStep;
  }

  // Focus rests on the dialog itself, so no control opens with a focus ring and the first Tab lands on the first control.
  function focusDialog() {
    dialog.focus();
  }

  skipButton.addEventListener('click', () => dialog.close());
  doneButton.addEventListener('click', () => dialog.close());
  backButton.addEventListener('click', () => {
    stepIndex = Math.max(0, stepIndex - 1);
    showStep();
    focusDialog();
  });
  nextButton.addEventListener('click', () => {
    stepIndex = Math.min(groups.length - 1, stepIndex + 1);
    showStep();
    focusDialog();
  });

  /** Shows the chosen preferences in the cards, what each tier gives on this screen and the hardware found. */
  function refresh() {
    const preferences = readPreferences();
    for (const radio of radios) {
      const chosen = String(preferences[radio.dataset.setup]) === radio.value;
      radio.checked = chosen;
      radio.parentNode.dataset.selected = String(chosen);
    }
    const { tier: detectedTier, summary } = describeHardware();
    for (const { tier, ratio, antiAliasing } of performanceFacts) {
      const { pixelRatio, samples } = viewportSettingsForTier(tier);
      ratio.textContent = formatRatio(pixelRatio);
      antiAliasing.textContent = `AA ${samples}x`;
    }
    automaticPick.textContent = `${capitalize(detectedTier)} on this machine`;
    hardwareLine.textContent = summary;
    hardwareLine.title = summary;
    promptBlock.value = agentPromptText();
    showCopied(false);
  }

  function fillPreviewsOnce() {
    if (previewsFilled) {
      return;
    }
    previewsFilled = true;
    for (const { preview, theme } of themePreviews) {
      fillThemePreview(documentReference, createElement, createIcon, preview, theme);
    }
  }

  function open() {
    fillPreviewsOnce();
    stepIndex = 0;
    refresh();
    showStep();
    if (!dialog.open) {
      dialog.showModal();
    }
    focusDialog();
  }

  return { dialog, open, refresh };
}
