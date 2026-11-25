import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FILE_NAME_STEM_LIMIT,
  cleanTypedFileStem,
  extensionOf,
  openNameEditor,
  splitFileName,
  validateFileStem,
  validateNodeLabel,
  validateShotName,
} from '../src/studio-name-editor.js';
import { dispatch, installStudioDom } from './support/studio-dom.mjs';

const SUFFIX = '.scene.json';

test('a file name splits into the name part and its type, which keeps its case (#3344)', () => {
  assert.deepEqual(splitFileName('untitled.scene.json'), { stem: 'untitled', suffix: '.scene.json' });
  assert.deepEqual(splitFileName('scene.json'), { stem: 'scene', suffix: '.json' });
  assert.deepEqual(splitFileName('Room.SCENE.JSON'), { stem: 'Room', suffix: '.SCENE.JSON' });
  assert.deepEqual(splitFileName('model.glb'), { stem: 'model', suffix: '.glb' });
  assert.deepEqual(splitFileName('v1.2.scene.json'), { stem: 'v1.2', suffix: '.scene.json' });
  assert.deepEqual(splitFileName('plain'), { stem: 'plain', suffix: '.scene.json' }, 'no file context: the default type');
});

test('only a known type, or the extension the file came with, is a type: "Scene 1.5" and "my.scene" keep their dots (#3344)', () => {
  assert.deepEqual(splitFileName('Scene 1.5'), { stem: 'Scene 1.5', suffix: '.scene.json' });
  assert.deepEqual(splitFileName('my.scene'), { stem: 'my.scene', suffix: '.scene.json' });
  assert.deepEqual(splitFileName('notes.txt'), { stem: 'notes.txt', suffix: '.scene.json' });
  assert.deepEqual(splitFileName('notes.txt', '.txt'), { stem: 'notes', suffix: '.txt' }, 'the file came with .txt');
  assert.deepEqual(splitFileName('my.scene', '.scene'), { stem: 'my', suffix: '.scene' });
  assert.deepEqual(splitFileName('Scene 1.5', '.5'), { stem: 'Scene 1', suffix: '.5' }, 'a host that really gave .5 decides');
  assert.equal(extensionOf('a.glb'), '.glb');
  assert.equal(extensionOf('a.txt'), '.txt');
  assert.equal(extensionOf('plain'), '');
});

test('direction controls and zero-width characters are refused with a reason, in file names and labels (#3344)', () => {
  const hidden = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const code of hidden) {
    const typed = `a${String.fromCharCode(code)}b`;
    assert.equal(validateFileStem(typed, SUFFIX).ok, false, code.toString(16));
    assert.match(validateFileStem(typed, SUFFIX).reason, /zero-width/);
    assert.equal(validateNodeLabel(typed).ok, false, code.toString(16));
  }
  // A right-to-left override that would make "gnp.scene" read as a different type.
  assert.equal(validateFileStem(`scene${String.fromCharCode(0x202e)}nosj.`, SUFFIX).ok, false);
  assert.equal(validateFileStem('plain text', SUFFIX).ok, true);
});

test('a type typed at the end of the name never changes or doubles the saved type (#3344)', () => {
  for (const typed of ['a.glb', 'a.scene.json', 'a.json', 'A.SCENE.JSON', 'a.scene.json.json', ' a .glb ']) {
    const checked = validateFileStem(typed, SUFFIX);
    assert.equal(checked.ok, true, typed);
    assert.equal(`${checked.value}${SUFFIX}`.toLowerCase(), 'a.scene.json', typed);
  }
  assert.equal(validateFileStem('v1.2', SUFFIX).value, 'v1.2', 'other dots belong to the name');
  assert.equal(validateFileStem('a.txt', SUFFIX).value, 'a.txt', 'another extension is part of the name, the type stays');
  assert.equal(cleanTypedFileStem('a.png', '.png'), 'a', 'the file own type is dropped too');
});

test('a trailing dot, only dots, empty and spaces-only names are refused with a reason (#3344)', () => {
  for (const typed of ['a.', '.', '...', '', '   ', '.json', '.scene.json']) {
    const checked = validateFileStem(typed, SUFFIX);
    assert.equal(checked.ok, false, JSON.stringify(typed));
    assert.ok(checked.reason.length > 0);
  }
});

test('characters a file system forbids, device names and long names are refused (#3344)', () => {
  for (const typed of ['a\\b', 'a/b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0007b', 'a\u0000b']) {
    assert.equal(validateFileStem(typed, SUFFIX).ok, false, JSON.stringify(typed));
  }
  for (const typed of ['con', 'PRN', 'Aux', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9', 'con.v2', 'CON.scene.json']) {
    const checked = validateFileStem(typed, SUFFIX);
    assert.equal(checked.ok, false, typed);
    assert.match(checked.reason, /reserved/);
  }
  for (const typed of ['COM0', 'console', 'lpt10', 'a.con']) assert.equal(validateFileStem(typed, SUFFIX).ok, true, typed);
  assert.equal(validateFileStem('x'.repeat(FILE_NAME_STEM_LIMIT), SUFFIX).ok, true);
  assert.equal(validateFileStem('x'.repeat(FILE_NAME_STEM_LIMIT + 1), SUFFIX).ok, false);
});

test('pasted text with a new line becomes one line and keeps the type (#3344)', () => {
  const checked = validateFileStem('first\nsecond\r\nthird', SUFFIX);
  assert.equal(checked.ok, true);
  assert.equal(checked.value, 'first second third');
});

test('node labels trim, may repeat, and refuse empty or very long text (#3344)', () => {
  assert.deepEqual(validateNodeLabel('  Table  '), { ok: true, value: 'Table', reason: '' });
  assert.equal(validateNodeLabel('   ').ok, false);
  assert.equal(validateNodeLabel('x'.repeat(257)).ok, false);
  assert.equal(validateNodeLabel('x'.repeat(256)).ok, true);
});

test('shot names follow the recipe rule and refuse a taken name (#3344)', () => {
  assert.equal(validateShotName('close up', []).value, 'close-up');
  assert.equal(validateShotName('wide', ['wide', 'tall']).ok, false);
  assert.match(validateShotName('wide', ['wide']).reason, /already exists/);
  assert.equal(validateShotName('a.b', []).ok, false);
  assert.equal(validateShotName('x'.repeat(25), []).ok, false);
  assert.equal(validateShotName('', []).ok, false);
});

function mountEditor(context, options = {}) {
  const dom = installStudioDom();
  context.after(() => dom.uninstall());
  const documentReference = dom.document;
  const createElement = (doc, tag, properties = {}, ...children) => {
    const element = doc.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
      if (key === 'attributes') for (const [name, attribute] of Object.entries(value)) element.setAttribute(name, String(attribute));
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else element[key] = value;
    }
    element.append(...children);
    return element;
  };
  const createIcon = doc => doc.createElement('svg');
  const parent = documentReference.createElement('div');
  documentReference.body.append(parent);
  const anchor = documentReference.createElement('button');
  parent.append(anchor);
  const closed = [];
  const committed = [];
  const editor = openNameEditor({
    documentReference,
    createElement,
    createIcon,
    anchor,
    text: 'room',
    suffix: SUFFIX,
    label: 'Rename scene',
    validate: text => validateFileStem(text, SUFFIX),
    onCommit: value => {
      committed.push(value);
      return options.commit ? options.commit(value) : options.commitResult;
    },
    onClose: detail => closed.push(detail),
    isStale: options.isStale,
  });
  const type = text => {
    editor.input.value = text;
    dispatch(editor.input, 'input');
  };
  const press = key => dispatch(editor.input, 'keydown', { key });
  return { editor, anchor, parent, closed, committed, type, press, documentReference };
}

test('the editor shows the field, the fixed type and a labelled input; Enter keeps a valid name (#3344)', async context => {
  const { editor, anchor, parent, closed, committed, type, press } = mountEditor(context);
  assert.equal(anchor.dataset.renaming, 'true');
  assert.equal(editor.input.getAttribute('aria-label'), 'Rename scene');
  assert.equal(editor.element.querySelector('.crucible-studio-name-suffix').textContent, SUFFIX);
  assert.equal(editor.input.selected, true, 'the text starts selected');
  type('lounge.glb');
  press('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, ['lounge']);
  assert.deepEqual(closed, [{ committed: true, trigger: 'enter' }]);
  assert.equal(anchor.dataset.renaming, undefined);
  assert.equal(parent.querySelector('.crucible-studio-name-editor'), null);
});

test('Escape cancels without applying and a later blur does nothing (#3344)', async context => {
  const { editor, closed, committed, type, press } = mountEditor(context);
  type('other');
  press('Escape');
  dispatch(editor.input, 'blur');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, []);
  assert.deepEqual(closed, [{ committed: false, trigger: 'escape' }]);
});

test('an invalid name shows a reason, keeps the editor open and is announced; blur then drops it (#3344)', async context => {
  const { editor, closed, committed, type, press } = mountEditor(context);
  const error = editor.element.querySelector('.crucible-studio-name-error');
  assert.equal(error.hidden, true);
  type('bad|name');
  assert.equal(error.hidden, false);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(editor.input.getAttribute('aria-invalid'), 'true');
  assert.match(error.textContent, /Not allowed/);
  press('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.isOpen, true);
  assert.deepEqual(committed, []);
  dispatch(editor.input, 'blur');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, [{ committed: false, trigger: 'blur' }], 'a half-typed invalid name is never applied');
  assert.deepEqual(committed, []);
});

test('blur keeps a valid name (#3344)', async context => {
  const { editor, closed, committed, type } = mountEditor(context);
  type('kept');
  dispatch(editor.input, 'blur');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, ['kept']);
  assert.deepEqual(closed, [{ committed: true, trigger: 'blur' }]);
});

test('a host that says the name is taken keeps the editor open with the message (#3344)', async context => {
  const { editor, closed, type, press } = mountEditor(context, { commitResult: { error: 'A file with this name already exists' } });
  type('taken');
  press('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.isOpen, true);
  assert.equal(editor.element.querySelector('.crucible-studio-name-error-text').textContent, 'A file with this name already exists');
  assert.deepEqual(closed, []);
});

test('keys typed in the field never reach the page shortcuts, and an IME composition does not confirm (#3344)', context => {
  const { editor, committed, documentReference } = mountEditor(context);
  const reached = [];
  documentReference.addEventListener('keydown', event => reached.push(event.key));
  for (const key of ['g', 'r', 's', 'Delete', 'a', 'Backspace']) press(editor, key);
  assert.deepEqual(reached, []);
  dispatch(editor.input, 'keydown', { key: 'Enter', isComposing: true });
  assert.deepEqual(committed, []);
  assert.equal(editor.isOpen, true);
});

function press(editor, key) {
  return dispatch(editor.input, 'keydown', { key });
}

test('a rejection of any kind is an error in the field, and the editor can try again (#3344)', async context => {
  for (const rejection of ['The disk is full', null, undefined, new Error('Access denied'), { code: 5 }]) {
    let attempts = 0;
    const { editor, closed, type, press: pressKey } = mountEditor(context, {
      commit: () => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(rejection) : Promise.resolve(null);
      },
    });
    type('again');
    pressKey('Enter');
    await new Promise(resolve => setImmediate(resolve));
    const shown = editor.element.querySelector('.crucible-studio-name-error-text').textContent;
    assert.ok(shown.length > 0, 'a readable message');
    assert.notEqual(shown, 'null');
    if (typeof rejection === 'string') assert.equal(shown, rejection);
    if (rejection instanceof Error) assert.equal(shown, 'Access denied');
    assert.equal(editor.isOpen, true);
    assert.equal(editor.isBusy, false, 'committing is cleared');
    assert.equal(editor.input.readOnly, false);
    pressKey('Enter');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(closed, [{ committed: true, trigger: 'enter' }], 'the second try is accepted');
  }
});

test('while a host rename is pending the field is read-only and busy, and Escape, blur and cancel do not close it (#3344)', async context => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const { editor, closed, committed, type, press: pressKey } = mountEditor(context, { commit: () => pending });
  type('slow');
  pressKey('Enter');
  assert.equal(editor.isBusy, true);
  assert.equal(editor.input.readOnly, true);
  assert.equal(editor.element.dataset.busy, 'true');
  assert.equal(editor.input.getAttribute('aria-busy'), 'true');
  pressKey('Escape');
  dispatch(editor.input, 'blur');
  editor.cancel();
  pressKey('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, ['slow'], 'one rename, not two');
  assert.deepEqual(closed, []);
  assert.equal(editor.isOpen, true);
  settle({ error: 'A file with this name already exists' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.isBusy, false);
  assert.equal(editor.input.readOnly, false);
  assert.equal(editor.element.dataset.busy, 'false');
  assert.equal(editor.element.querySelector('.crucible-studio-name-error-text').textContent, 'A file with this name already exists');
});

test('a pending rename that succeeds closes the field with its result (#3344)', async context => {
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const { editor, closed, type, press: pressKey } = mountEditor(context, { commit: () => pending });
  type('slow');
  pressKey('Enter');
  settle(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(closed, [{ committed: true, trigger: 'enter' }]);
  assert.equal(editor.isOpen, false);
});

test('Enter with keyCode 229 and a blur while composing do not confirm; the composition end answers the blur (#3344)', async context => {
  const { editor, closed, committed, type } = mountEditor(context);
  type('かな');
  dispatch(editor.input, 'keydown', { key: 'Enter', keyCode: 229 });
  assert.deepEqual(committed, []);
  dispatch(editor.input, 'compositionstart');
  dispatch(editor.input, 'blur');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, [], 'no commit on a blur in the middle of a composition');
  assert.equal(editor.isOpen, true);
  dispatch(editor.input, 'compositionend');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, ['かな']);
  assert.deepEqual(closed, [{ committed: true, trigger: 'blur' }]);
});

test('a composition that ends while the field keeps focus does not close it (#3344)', async context => {
  const { editor, committed } = mountEditor(context);
  dispatch(editor.input, 'compositionstart');
  dispatch(editor.input, 'compositionend');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, []);
  assert.equal(editor.isOpen, true);
});

test('a field whose row was taken out of the page answers like a click away (#3344)', async context => {
  const { editor, anchor, closed, committed, type } = mountEditor(context);
  editor.closeIfDetached();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(editor.isOpen, true, 'a row that is still there keeps its field');
  type('kept');
  anchor.remove();
  editor.closeIfDetached();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, ['kept']);
  assert.deepEqual(closed, [{ committed: true, trigger: 'blur' }]);
});

test('a rename of something that is gone closes without applying it (#3344)', async context => {
  let gone = false;
  const { editor, closed, committed, type, press: pressKey } = mountEditor(context, { isStale: () => gone });
  type('late');
  gone = true;
  pressKey('Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(committed, []);
  assert.deepEqual(closed, [{ committed: false, trigger: 'cancel' }]);
  assert.equal(editor.isOpen, false);
});
