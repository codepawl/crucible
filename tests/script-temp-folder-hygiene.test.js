import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Smoke and bench scripts run outside the test runner, so the private temp folder of scripts/test-private-temp.mjs does
// not cover them (#2848). A script that makes a scratch folder has to remove it, or say why it keeps it.

const repositoryRoot = join(import.meta.dirname, '..');
const SCRIPT_FOLDERS = ['scripts', 'bench'];
const ALLOWED_TO_CREATE_FOLDERS = new Set(['scripts/scratch-directory.mjs', 'scripts/test-private-temp.mjs']);
const MAKES_A_TEMP_FOLDER = /\bmkdtemp(?:Sync)?\(/;
const REMOVES_OR_EXPLAINS = /\bcreateScratchDirectory\(|\brm\(|\brmSync\(|\brmdir(?:Sync)?\(|keeps-temp:/;

export function scriptFilesUnder(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'results') continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...scriptFilesUnder(path));
    else if (/\.(mjs|js)$/.test(entry.name)) found.push(path);
  }
  return found;
}

export function filesThatLeakTempFolders(files, readSource = (file) => readFileSync(file, 'utf8')) {
  return files.filter((file) => {
    const source = readSource(file);
    return MAKES_A_TEMP_FOLDER.test(source) && !REMOVES_OR_EXPLAINS.test(source);
  });
}

test('the check names a script that makes a temp folder and never removes it', () => {
  const sources = {
    'leaky.mjs': "const dir = await mkdtemp(join(tmpdir(), 'x-'));",
    'scratch.mjs': "const dir = await createScratchDirectory('x-');",
    'removes.mjs': "const dir = mkdtempSync(join(tmpdir(), 'x-')); rmSync(dir, { recursive: true });",
    'keeps.mjs': "// keeps-temp: the folder is the output\nconst dir = mkdtempSync(join(tmpdir(), 'x-'));",
    'none.mjs': 'const value = 1;',
  };
  assert.deepEqual(filesThatLeakTempFolders(Object.keys(sources), (file) => sources[file]), ['leaky.mjs']);
});

test('every smoke and bench script that makes a temp folder removes it', () => {
  const files = SCRIPT_FOLDERS.flatMap((folder) => scriptFilesUnder(join(repositoryRoot, folder)))
    .filter((file) => !ALLOWED_TO_CREATE_FOLDERS.has(relative(repositoryRoot, file).replaceAll('\\', '/')));
  const leaking = filesThatLeakTempFolders(files).map((file) => relative(repositoryRoot, file).replaceAll('\\', '/'));
  assert.deepEqual(
    leaking,
    [],
    `${leaking.join(', ')} make a temp folder and never remove it, so every run fills the OS temp folder. ` +
      "Fix: `import { createScratchDirectory } from '<path>/scripts/scratch-directory.mjs'` and use `await createScratchDirectory('crucible-<name>-')`, " +
      'which removes the folder when the script exits. A script whose folder is its output adds a `// keeps-temp: <reason>` comment.',
  );
});
