// An inspector dropdown with nothing to choose from shows what is missing and offers to create it, instead of a blank box.

/**
 * Builds the empty state: a dashed slot saying `message` with one `actionLabel` button.
 * `sync(isEmpty)` shows the slot and hides `select` (when given) while the list is empty, and shows the select otherwise.
 */
export function createEmptySelectState({ documentReference, createElement, createIcon, select = null, message, actionLabel, onAction }) {
  const button = createElement(
    documentReference,
    'button',
    { type: 'button', className: 'crucible-studio-empty-action' },
    createIcon(documentReference, 'add'),
    createElement(documentReference, 'span', { textContent: actionLabel }),
  );
  button.addEventListener('click', () => onAction());
  const element = createElement(
    documentReference,
    'div',
    { className: 'crucible-studio-empty-slot', hidden: true, dataset: { emptyState: 'true' } },
    createElement(documentReference, 'span', { textContent: message }),
    button,
  );

  function sync(isEmpty) {
    element.hidden = !isEmpty;
    if (select) {
      select.hidden = isEmpty;
    }
  }

  return { element, sync };
}

// A dashed border on a quiet surface marks a slot with nothing in it; the padding is equal on all four sides.
export const EMPTY_SELECT_CSS = `
.crucible-studio-empty-slot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--studio-space-8);
  padding: var(--studio-space-8);
  border: 1px dashed color-mix(in srgb, var(--studio-text) 30%, transparent);
  border-radius: var(--studio-radius-control);
  color: var(--studio-muted);
}
.crucible-studio-empty-slot[hidden] { display: none; }
.crucible-studio-empty-slot > span { padding-inline-start: var(--studio-space-4); min-inline-size: 0; white-space: nowrap; }
.crucible-studio button.crucible-studio-empty-action {
  flex: none;
  gap: var(--studio-space-4);
  color: var(--studio-text);
  font-weight: 600;
}
.crucible-studio-empty-action .crucible-studio-icon { inline-size: 14px; block-size: 14px; }
`;
