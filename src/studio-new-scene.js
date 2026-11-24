// The two dialogs behind File > New scene: the chooser of the starting scene and the question about unsaved changes. They
// are built on the first use, so none of this code is in the entry that mounts Studio.
import { STUDIO_TEMPLATES } from './studio-templates.js';
import { TEMPLATE_THUMBNAIL_URLS } from './studio-template-thumbnails.js';

/** The starting scenes in the order the chooser shows them: the blank one first, then the ready ones. */
export function chooserTemplateKeys() {
  const readyKeys = Object.keys(STUDIO_TEMPLATES).filter(key => key !== 'empty');
  return ['empty', ...readyKeys];
}

const ARROW_KEYS = Object.freeze(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

function cardColumnCount(documentReference, grid) {
  const template = documentReference.defaultView?.getComputedStyle?.(grid)?.gridTemplateColumns;
  const columns = typeof template === 'string' ? template.split(' ').filter(Boolean).length : 1;
  return Math.max(1, columns);
}

export function createNewSceneDialogs({ documentReference, createElement, createIcon }) {
  const cards = chooserTemplateKeys().map(templateKey => {
    const thumbnail = createElement(documentReference, 'img', { alt: '', width: 320, height: 200, attributes: { decoding: 'async' } });
    const card = createElement(
      documentReference,
      'button',
      { type: 'button', className: 'crucible-studio-new-card', dataset: { template: templateKey } },
      createElement(documentReference, 'span', { className: 'crucible-studio-new-thumb' }, thumbnail),
      createElement(documentReference, 'span', { className: 'crucible-studio-new-name', textContent: STUDIO_TEMPLATES[templateKey].label }),
    );
    return { templateKey, card, thumbnail };
  });
  const cardGrid = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-new-cards', attributes: { role: 'group', 'aria-label': 'Starting scene' } },
    ...cards.map(item => item.card),
  );
  const closeButton = createElement(
    documentReference,
    'button',
    { type: 'button', className: 'crucible-studio-new-close', attributes: { 'aria-label': 'Close', title: 'Close' } },
    createIcon(documentReference, 'close'),
  );
  const chooser = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-new-dialog', attributes: { 'aria-labelledby': 'crucible-studio-new-title', closedby: 'any' } },
    createElement(
      documentReference,
      'div',
      { className: 'crucible-studio-new-head' },
      createElement(documentReference, 'h2', { id: 'crucible-studio-new-title', textContent: 'New scene' }),
      closeButton,
    ),
    cardGrid,
  );

  // One click or Enter on a card starts it; the arrow keys move between cards the way the grid is laid out.
  for (const { templateKey, card } of cards) {
    card.addEventListener('click', () => chooser.close(templateKey));
  }
  closeButton.addEventListener('click', () => chooser.close(''));
  cardGrid.addEventListener('keydown', event => {
    if (!ARROW_KEYS.includes(event.key)) return;
    const buttons = cards.map(item => item.card);
    const current = buttons.indexOf(documentReference.activeElement);
    if (current < 0) return;
    const columns = cardColumnCount(documentReference, cardGrid);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.min(buttons.length - 1, Math.max(0, current + step));
    event.preventDefault();
    buttons[target].focus();
  });

  // A second call while a dialog is open gets the same answer instead of leaving one promise that never settles.
  let pendingChoice = null;
  let pendingQuestion = null;

  /** Opens the chooser. Resolves to the key of the chosen starting scene, or null when the person cancelled. */
  function chooseTemplate() {
    pendingChoice ??= new Promise(resolve => {
      for (const { templateKey, thumbnail } of cards) {
        if (!thumbnail.src) thumbnail.src = TEMPLATE_THUMBNAIL_URLS[templateKey];
      }
      chooser.returnValue = '';
      chooser.addEventListener('close', () => {
        pendingChoice = null;
        resolve(chooser.returnValue || null);
      }, { once: true });
      chooser.showModal();
      cards[0].card.focus();
    });
    return pendingChoice;
  }

  const unsavedHeading = createElement(
    documentReference,
    'h2',
    { id: 'crucible-studio-unsaved-title' },
    createIcon(documentReference, 'warning'),
    createElement(documentReference, 'span', { textContent: 'Unsaved changes' }),
  );
  const unsavedMessage = createElement(documentReference, 'p', { className: 'crucible-studio-confirm-message' });
  const cancelButton = createElement(documentReference, 'button', { type: 'button', textContent: 'Cancel' });
  // The buttons follow the setup dialog: the lesser choice at the left edge, then Cancel, then the one filled primary button.
  const discardButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-skip', textContent: 'Discard' });
  const saveButton = createElement(documentReference, 'button', { type: 'button', className: 'crucible-studio-setup-primary', textContent: 'Save' });
  const confirm = createElement(
    documentReference,
    'dialog',
    { className: 'crucible-studio-confirm-dialog', attributes: { role: 'alertdialog', 'aria-labelledby': 'crucible-studio-unsaved-title', closedby: 'any' } },
    unsavedHeading,
    unsavedMessage,
    createElement(documentReference, 'div', { className: 'crucible-studio-dialog-actions crucible-studio-setup-actions' }, discardButton, cancelButton, saveButton),
  );
  cancelButton.addEventListener('click', () => confirm.close('cancel'));
  discardButton.addEventListener('click', () => confirm.close('discard'));
  saveButton.addEventListener('click', () => confirm.close('save'));

  /** Asks what to do with the scene being left. Resolves to 'save', 'discard' or 'cancel' (also for Escape). */
  function askUnsavedChanges(fileName) {
    pendingQuestion ??= new Promise(resolve => {
      unsavedMessage.textContent = `${fileName} has changes that are not saved.`;
      confirm.returnValue = '';
      confirm.addEventListener('close', () => {
        pendingQuestion = null;
        resolve(['save', 'discard'].includes(confirm.returnValue) ? confirm.returnValue : 'cancel');
      }, { once: true });
      confirm.showModal();
      saveButton.focus();
    });
    return pendingQuestion;
  }

  return { chooseTemplate, askUnsavedChanges, dialogs: [chooser, confirm] };
}
