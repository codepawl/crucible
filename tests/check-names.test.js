import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findAbbreviatedNames, findAbbreviatedPythonNames, isScannedPath } from '../scripts/check-names.mjs';

// Built from parts so this file itself holds no short declarations for the name check to flag.
const declare = (keyword, name) => `${keyword} ${name} = 1;`;

test('one-letter and abbreviated declarations are flagged with their line', () => {
  const lines = [declare('const', 'total'), declare('const', 'c'), declare('let', 'tmp'), `${'function'} fn() {}`, declare('var', 'obj')];
  assert.deepEqual(findAbbreviatedNames(lines.join('\n')), [
    { line: 2, name: 'c' },
    { line: 3, name: 'tmp' },
    { line: 4, name: 'fn' },
    { line: 5, name: 'obj' },
  ]);
});

test('loop indices, coordinates, colour channels and underscore stay allowed', () => {
  const allowedNames = ['i', 'j', 'x', 't', 'r', '_', '$'];
  const text = allowedNames.map(name => declare('const', name)).join('\n');
  assert.deepEqual(findAbbreviatedNames(text), []);
});

test('comments and longer names that contain an abbreviation are not flagged', () => {
  const lines = [`// ${declare('const', 'c')}`, '/**', ` * ${declare('let', 'tmp')}`, ' */', declare('const', 'message'), declare('const', 'index')];
  assert.deepEqual(findAbbreviatedNames(lines.join('\n')), []);
});

test('only tracked source folders are scanned, minus generated and vendor files', () => {
  assert.equal(isScannedPath('src/cloth.js'), true);
  assert.equal(isScannedPath('packages/blender-addon/src/a.js'), true);
  assert.equal(isScannedPath(String.raw`scripts\drive.mjs`), true);
  assert.equal(isScannedPath('src/vendor/lib.js'), false);
  assert.equal(isScannedPath('src/bundle.min.js'), false);
  assert.equal(isScannedPath('docs/example.js'), false);
  assert.equal(isScannedPath('src/readme.md'), false);
});

const namesIn = text => findAbbreviatedNames(text).map(finding => finding.name);
const pythonNamesIn = text => findAbbreviatedPythonNames(text).map(finding => finding.name);

test('destructuring bindings are flagged one by one, with defaults, renames and rest', () => {
  assert.deepEqual(namesIn('const [a, b, c, d] = quad;'), ['c', 'd']);
  assert.deepEqual(namesIn('const { foo: s, bar, baz: { deep: m } } = source;'), ['s', 'm']);
  assert.deepEqual(namesIn('const [first, , e = 4, ...f] = list;'), ['e', 'f']);
  assert.deepEqual(namesIn('for (const [key, e] of entries) {}'), ['e']);
  assert.deepEqual(namesIn('let first = 1, c = 2;'), ['c']);
  assert.deepEqual(namesIn('const { source: [first, d] } = holder;'), ['d']);
});

test('function, arrow, method and catch parameters are flagged', () => {
  assert.deepEqual(namesIn('function place(nx, d, weight) {}'), ['d']);
  assert.deepEqual(namesIn('const sum = (s, m) => s + m;'), ['s', 'm']);
  assert.deepEqual(namesIn('items.map(p => p.name);'), ['p']);
  assert.deepEqual(namesIn('const run = async e => e;'), ['e']);
  assert.deepEqual(namesIn('const place = function (p) {};'), ['p']);
  assert.deepEqual(namesIn('function f([first, c], { size: s } = {}, ...rest) {}'), ['f', 'c', 's']);
  assert.deepEqual(namesIn('class Box {\n  static build(c) {}\n  async load(d, count) {}\n  get size() {}\n}'), ['c', 'd']);
  assert.deepEqual(namesIn('class Box {\n  [sym](d, e) {}\n  static async *[Symbol.iterator](m) {}\n}\nconst lookup = { [key](s) {} };'), ['d', 'e', 'm', 's']);
  assert.deepEqual(namesIn('try {} catch (e) {}'), ['e']);
  assert.deepEqual(namesIn('const lookup = { find(c) { return c; } };'), ['c']);
});

test('comparators, coordinates and descriptive parameters stay legal', () => {
  assert.deepEqual(namesIn('list.sort((a, b) => a - b);'), []);
  assert.deepEqual(namesIn('const [r, g, b, a] = colour;'), []);
  assert.deepEqual(namesIn('function move(x, y, z, t, n) {}'), []);
  assert.deepEqual(namesIn('const [firstVertex, secondVertex] = pair;'), []);
  assert.deepEqual(namesIn('const total = (first, second) => first + second;'), []);
  assert.deepEqual(namesIn('try {} catch (error) {}'), []);
});

test('strings, comments, templates, regex literals and calls are not mistaken for bindings', () => {
  assert.deepEqual(namesIn("const text = 'const [a, b, c, d] = x; function f(s) {}';"), []);
  assert.deepEqual(namesIn('const text = `(s, m) => ${count}`;'), []);
  assert.deepEqual(namesIn('const text = `${items.map(c => c)}`;'), ['c']);
  assert.deepEqual(namesIn('// const [c, d] = pair;\n/* function f(s, m) {} */'), []);
  assert.deepEqual(namesIn('const pattern = /(c, d) => const e/g;\nconst ratio = total / count / 2;'), []);
  assert.deepEqual(namesIn('if (c) { call(d, e); }\nwhile (s) {}\nfoo(c, d);'), []);
  assert.deepEqual(namesIn('const result = condition ? first : second;\nlabel: for (const item of items) {}'), []);
});

test('reported lines follow multi-line parameter lists and declarations', () => {
  const text = 'function place(\n  vertex,\n  d,\n) {}\nconst [\n  first,\n  c,\n] = pair;';
  assert.deepEqual(findAbbreviatedNames(text), [{ line: 3, name: 'd' }, { line: 7, name: 'c' }]);
});

test('python assignments, def names, def parameters and for targets are flagged', () => {
  assert.deepEqual(pythonNamesIn('c = 1\ntotal = 2\nd, e = pair\n'), ['c', 'd', 'e']);
  assert.deepEqual(pythonNamesIn('def build(self, p, count=3, *rest, s: int = 4, **options):\n    pass\n'), ['p', 's']);
  assert.deepEqual(pythonNamesIn('def f(x):\n    return x\n'), ['f']);
  assert.deepEqual(pythonNamesIn('for c, d in pairs:\n    pass\nvalues = [m for m in items]\n'), ['c', 'd', 'm']);
  assert.deepEqual(pythonNamesIn('s: int = 1\ntotal += 2\nobj = None\n'), ['s', 'obj']);
  assert.deepEqual(pythonNamesIn('def long_signature(\n    first,\n    d,\n):\n    pass\n'), ['d']);
});

test('python allowed short names, attributes, keyword arguments, strings and comments stay legal', () => {
  assert.deepEqual(pythonNamesIn('i = 0\nx, y, z = point\nfor t in times:\n    pass\n'), []);
  assert.deepEqual(pythonNamesIn('self.c = 1\ntable[d] = 2\nitem.e, other.f = pair\n'), []);
  assert.deepEqual(pythonNamesIn('call(\n    c=1,\n    d=2,\n)\nif c == d:\n    pass\n'), []);
  assert.deepEqual(pythonNamesIn('# c = 1\ntext = "c = 1; def f(d):"\n"""\nd = 2\n"""\n'), []);
  assert.deepEqual(pythonNamesIn('def build(self, first, second=None):\n    return first == second\n'), []);
});

test('python files under src, scripts, bench and tests are scanned', () => {
  assert.equal(isScannedPath('scripts/blender-cloth.py'), true);
  assert.equal(isScannedPath('bench/reference/score.py'), true);
  assert.equal(isScannedPath('docs/example.py'), false);
  assert.equal(isScannedPath('src/vendor/lib.py'), false);
});

test('check-names CLI reports a missing file cleanly without a raw stack', () => {
  const script = join(import.meta.dirname, '..', 'scripts', 'check-names.mjs');
  const result = spawnSync(process.execPath, [script, 'missing-file-for-check-names.js'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Source file not found: missing-file-for-check-names\.js/);
  assert.doesNotMatch(result.stderr, /\bat\s+/);
});
