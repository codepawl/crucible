// The reverse import graph of the repository's JavaScript: which files import or re-export a given file, followed transitively (#3403).
// test:affected and the light CI mode use it to pick every test that reaches a changed file through any chain of static imports.
// Edges are relative static imports and re-exports plus relative script paths written as literals (`new URL('./b.js', import.meta.url)`).
// Package-name imports (`@codepawlhq/crucible/...`, `@codepawlhq/cook`) and `import()` of a template literal are not resolved:
// the name match in test-affected.mjs is the only cover for a test that reaches a change that way.
// A path in a comment counts as an edge too (comments are not stripped, which is faster and only ever selects more tests).
// Each file is read once per graph. localFilesNamedBy (importSpecifiers plus the path literals) lists its edges, the way the browser-test detector resolves them; only specifiers that end in a script extension count.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localFilesNamedBy, resolveLocalFile } from './browser-tests.mjs';
import { repositoryRoot } from './test-run.mjs';

export const GRAPH_FOLDERS = ['tests', 'src', 'scripts', 'bin', 'packages'];
const SCRIPT_FILE = /\.(m?js|cjs)$/;

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function listScriptFiles(folder) {
  const found = [];
  const visit = relativeDirectory => {
    for (const entry of readdirSync(join(folder, relativeDirectory), { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (SCRIPT_FILE.test(entry.name)) found.push(relativePath);
    }
  };
  for (const graphFolder of GRAPH_FOLDERS) {
    if (existsSync(join(folder, graphFolder))) visit(graphFolder);
  }
  return found;
}

/**
 * Reads every script file under tests/, src/, scripts/, bin/ and packages/ once and links each to the files that import it.
 * Returns { files, sourceOf(path), importersOf(path), reachedFrom(paths) }; `reachedFrom` lists the given files and every file
 * that reaches one of them through imports or re-exports.
 */
export function buildImportGraph(folder = repositoryRoot) {
  const files = listScriptFiles(folder);
  const sources = new Map(files.map(path => [path, readFileSync(join(folder, path), 'utf8')]));
  const fileExists = path => sources.has(path);
  const importers = new Map();
  for (const [importerPath, sourceText] of sources) {
    const importedPaths = localFilesNamedBy(sourceText, importerPath, fileExists);
    for (const importedPath of importedPaths) {
      if (!importers.has(importedPath)) importers.set(importedPath, new Set());
      importers.get(importedPath).add(importerPath);
    }
  }
  const importersOf = path => [...(importers.get(path) ?? [])];
  function reachedFrom(paths) {
    const reached = new Set(paths.map(toPosix));
    const queue = [...reached];
    while (queue.length > 0) {
      for (const importer of importersOf(queue.shift())) {
        if (reached.has(importer)) continue;
        reached.add(importer);
        queue.push(importer);
      }
    }
    return reached;
  }
  return { files, sourceOf: path => sources.get(path) ?? null, importersOf, reachedFrom };
}
