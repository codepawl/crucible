// Rename in place, as Blender does: a name becomes a small text field where it is shown. Enter keeps the new name, Escape
// cancels, and a clicked-away or tabbed-away field keeps a valid name and drops an invalid one. The rules for each kind of
// name are plain functions at the top; the field itself is `openNameEditor` below.

/** The types of a scene file, longest first. The type of the open file is kept on save and never edited. */
export const FILE_NAME_SUFFIXES = Object.freeze(['.scene.json', '.json', '.glb']);
/** The type a name gets when it has none we know and no file it came from. */
export const DEFAULT_FILE_SUFFIX = '.scene.json';
export const FILE_NAME_STEM_LIMIT = 120;
export const NODE_LABEL_LIMIT = 256;
export const SHOT_NAME_LIMIT = 24;

const characterRange = (first, last) => `${String.fromCharCode(first)}-${String.fromCharCode(last)}`;
// Line breaks (including the two Unicode ones) become spaces: a name is one line.
const LINE_BREAKS = new RegExp(`[\r\n${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
// Direction controls and zero-width characters: they can make the visible name, or its type, say something else than the bytes.
const HIDDEN_CHARACTERS = new RegExp(`[${characterRange(0x200b, 0x200f)}${characterRange(0x202a, 0x202e)}${characterRange(0x2066, 0x2069)}${String.fromCharCode(0xfeff)}]`);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const FILE_NAME_FORBIDDEN = /[\\/:*?"<>|]/;
const WINDOWS_DEVICE_NAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const SHOT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const OTHER_EXTENSION = /\.[A-Za-z0-9]{1,10}$/;
const HIDDEN_REASON = 'Hidden direction or zero-width characters are not allowed.';

function refuse(reason) {
  return { ok: false, value: '', reason };
}

function accept(value) {
  return { ok: true, value, reason: '' };
}

function knownSuffixOf(name) {
  const lowerName = name.toLowerCase();
  return FILE_NAME_SUFFIXES.find(suffix => lowerName.endsWith(suffix)) ?? '';
}

/** The type of a file name a host gave us: a known type, else its last extension, else none. */
export function extensionOf(fileName) {
  const name = String(fileName ?? '');
  const known = knownSuffixOf(name);
  if (known) return name.slice(name.length - known.length);
  const other = OTHER_EXTENSION.exec(name);
  return other && other.index > 0 ? other[0] : '';
}

/**
 * Splits `a.scene.json` into the name part `a` and the type `.scene.json`. Only a known type, or `contextSuffix` (the
 * extension of the file the name came from), is a type; "Scene 1.5" has none, so it gets the default one and keeps its dot.
 */
export function splitFileName(fileName, contextSuffix = '') {
  const name = String(fileName ?? '');
  const lowerName = name.toLowerCase();
  const suffixes = [...FILE_NAME_SUFFIXES, contextSuffix.toLowerCase()].filter(Boolean);
  const suffix = suffixes.filter(candidate => lowerName.endsWith(candidate)).sort((first, second) => second.length - first.length)[0];
  if (suffix) {
    return { stem: name.slice(0, name.length - suffix.length), suffix: name.slice(name.length - suffix.length) };
  }
  return { stem: name, suffix: DEFAULT_FILE_SUFFIX };
}

/**
 * What the person typed, ready to check: line breaks become spaces, the ends are trimmed, and any type typed at the end
 * (a known one, or the file's own) is dropped, so the saved type is always the original one. Other dots stay in the name.
 */
export function cleanTypedFileStem(text, suffix = '') {
  let value = String(text ?? '').replace(LINE_BREAKS, ' ').trim();
  const strippable = [...FILE_NAME_SUFFIXES, suffix.toLowerCase()].filter(Boolean);
  let stripped = true;
  while (stripped) {
    stripped = false;
    const lowerValue = value.toLowerCase();
    for (const candidate of strippable) {
      if (lowerValue.endsWith(candidate)) {
        value = value.slice(0, value.length - candidate.length).trim();
        stripped = true;
        break;
      }
    }
  }
  return value;
}

/** Checks the name part of a file name. `value` is the cleaned name part, to which the caller adds the original type. */
export function validateFileStem(text, suffix = '') {
  const value = cleanTypedFileStem(text, suffix);
  if (value === '') return refuse('Enter a name.');
  if (HIDDEN_CHARACTERS.test(value)) return refuse(HIDDEN_REASON);
  if (CONTROL_CHARACTERS.test(value)) return refuse('No control characters.');
  if (FILE_NAME_FORBIDDEN.test(value)) return refuse('Not allowed: \\ / : * ? " < > |');
  if (value.endsWith('.')) return refuse('A name cannot end with a dot.');
  const firstSegment = value.split('.')[0].trimEnd();
  if (WINDOWS_DEVICE_NAME.test(firstSegment)) return refuse(`${firstSegment.toUpperCase()} is a reserved name on Windows.`);
  if (value.length > FILE_NAME_STEM_LIMIT) return refuse(`Use ${FILE_NAME_STEM_LIMIT} characters or fewer.`);
  return accept(value);
}

/** Checks a label. Labels may repeat: the node id is the key, so only the label changes. */
export function validateNodeLabel(text) {
  const value = String(text ?? '').replace(LINE_BREAKS, ' ').trim();
  if (value === '') return refuse('Enter a name.');
  if (HIDDEN_CHARACTERS.test(value)) return refuse(HIDDEN_REASON);
  if (value.length > NODE_LABEL_LIMIT) return refuse(`Use ${NODE_LABEL_LIMIT} characters or fewer.`);
  return accept(value);
}

/** Checks a shot name: the recipe keys shots by name, so it follows the shot rule and may not be taken. */
export function validateShotName(text, takenNames = []) {
  const value = String(text ?? '').replace(LINE_BREAKS, ' ').trim().replace(/\s+/g, '-');
  if (value === '') return refuse('Enter a name.');
  if (value.length > SHOT_NAME_LIMIT || !SHOT_NAME_PATTERN.test(value)) return refuse(`Use 1 to ${SHOT_NAME_LIMIT} letters, digits, - or _.`);
  if (takenNames.includes(value)) return refuse('A shot with this name already exists.');
  return accept(value);
}

// A host may reject with an Error, a string, null or anything else; the person always gets a sentence.
function describeFailure(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' && message.trim() ? message : 'The rename failed.';
}

let editorCounter = 0;

/**
 * Replaces `anchor` with a text field until the name is kept or cancelled.
 *
 * - `validate(text)` returns `{ ok, value, reason }`; while `ok` is false the reason shows with a mark and Enter keeps it open.
 * - `onCommit(value)` applies the name; it may return a promise and may resolve `{ error }` (for example a host that says the
 *   name is taken): the editor then stays open and shows it. Any rejection counts as an error too. While it is pending the
 *   field is read-only and busy, and Escape and a click away do nothing.
 * - `isStale()` says the thing being renamed is gone; the editor then closes without applying anything.
 * - `suffix` is shown after the field as plain text. It is not part of the field, so it cannot be edited.
 * - `coverOnly` leaves the anchor on screen and hides only its label, for a field laid over a row; `onOpen(editor)` then places it.
 * - `onClose({ committed, trigger })` runs once, after the field is gone; `trigger` is `enter`, `escape`, `blur` or `cancel`.
 *
 * Every key stays inside the field so Studio's own shortcuts never fire while a name is typed.
 */
export function openNameEditor({ documentReference, createElement, createIcon, anchor, text, suffix = '', label, validate, onCommit, onClose, onOpen, isStale, className = '', placement = 'below', coverOnly = false }) {
  editorCounter += 1;
  const errorIdentifier = `crucible-studio-name-error-${editorCounter}`;
  let closed = false;
  let committing = false;
  let composing = false;
  let blurredWhileComposing = false;

  const input = createElement(documentReference, 'input', {
    type: 'text',
    value: text,
    className: 'crucible-studio-name-input',
    spellcheck: false,
    attributes: { 'aria-label': label, autocomplete: 'off', 'aria-describedby': errorIdentifier },
  });
  // The mirror holds the same text, so the field is as wide as its text between the minimum and maximum of the stylesheet.
  const mirror = createElement(documentReference, 'span', { className: 'crucible-studio-name-mirror', textContent: `${text}​`, attributes: { 'aria-hidden': 'true' } });
  const errorMessage = createElement(documentReference, 'span', { className: 'crucible-studio-name-error-text' });
  const errorElement = createElement(
    documentReference,
    'span',
    { className: 'crucible-studio-name-error', id: errorIdentifier, hidden: true, attributes: { role: 'alert' } },
    createIcon(documentReference, 'warning'),
    errorMessage,
  );
  const children = [createElement(documentReference, 'span', { className: 'crucible-studio-name-field' }, mirror, input)];
  if (suffix) children.push(createElement(documentReference, 'span', { className: 'crucible-studio-name-suffix', textContent: suffix }));
  children.push(errorElement);
  const element = createElement(
    documentReference,
    'span',
    { className: `crucible-studio-name-editor ${className}`.trim(), dataset: { placement, busy: 'false', invalid: 'false' } },
    ...children,
  );

  function showError(reason) {
    errorMessage.textContent = reason;
    errorElement.hidden = !reason;
    input.setAttribute('aria-invalid', reason ? 'true' : 'false');
    element.dataset.invalid = reason ? 'true' : 'false';
  }

  function setBusy(busy) {
    input.readOnly = busy;
    input.setAttribute('aria-busy', busy ? 'true' : 'false');
    element.dataset.busy = busy ? 'true' : 'false';
  }

  function close(committed, trigger) {
    if (closed) return;
    closed = true;
    element.remove();
    delete anchor.dataset.renaming;
    onClose?.({ committed, trigger });
  }

  async function commit(trigger) {
    if (closed || committing) return;
    if (isStale?.()) {
      close(false, 'cancel');
      return;
    }
    const checked = validate(input.value);
    if (!checked.ok) {
      if (trigger === 'blur') {
        close(false, 'blur');
        return;
      }
      showError(checked.reason);
      input.focus();
      return;
    }
    committing = true;
    setBusy(true);
    let outcome;
    try {
      outcome = await onCommit(checked.value);
    } catch (error) {
      outcome = { error: describeFailure(error) };
    } finally {
      committing = false;
      setBusy(false);
    }
    if (closed) return;
    if (outcome?.error) {
      if (trigger === 'blur') {
        close(false, 'blur');
        return;
      }
      showError(outcome.error);
      input.focus();
      return;
    }
    close(true, trigger);
  }

  input.addEventListener('keydown', event => {
    // A key in the field is never a shortcut of the page.
    event.stopPropagation();
    // Enter that confirms an IME candidate reports isComposing, or keyCode 229 in browsers that do not.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commit('enter');
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!committing) close(false, 'escape');
    }
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    // A click away ended the composition: the name is final now, so the click away is answered now.
    if (blurredWhileComposing) {
      blurredWhileComposing = false;
      commit('blur');
    }
  });
  input.addEventListener('input', () => {
    const singleLine = input.value.replace(LINE_BREAKS, ' ');
    if (singleLine !== input.value) input.value = singleLine;
    mirror.textContent = `${input.value}​`;
    const checked = validate(input.value);
    showError(checked.ok ? '' : checked.reason);
  });
  input.addEventListener('blur', () => {
    if (composing) {
      blurredWhileComposing = true;
      return;
    }
    commit('blur');
  });
  for (const eventName of ['click', 'dblclick', 'pointerdown', 'keyup', 'contextmenu']) {
    element.addEventListener(eventName, event => event.stopPropagation());
  }

  anchor.dataset.renaming = coverOnly ? 'label' : 'true';
  anchor.parentNode.insertBefore(element, anchor);
  const handle = {
    element,
    input,
    get isOpen() { return !closed; },
    get isBusy() { return committing; },
    // True when the thing being renamed is gone. A rename that is being applied is never stale: its own change may cause it.
    isStale() { return !committing && Boolean(isStale?.()); },
    // A list rebuilt the row the field sat in: the name is answered as a click away is, kept if valid and dropped if not.
    closeIfDetached() {
      if (!closed && !committing && !anchor.isConnected) commit('blur');
    },
    cancel() {
      if (!committing) close(false, 'cancel');
    },
  };
  onOpen?.(handle);
  input.focus();
  input.select();
  return handle;
}
