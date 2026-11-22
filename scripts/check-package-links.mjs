// Fast stand-in for `npm run check:links:package` that needs no `npm pack`: it lists the files the package ships from
// the "files" list of package.json and checks every relative link of each shipped Markdown or HTML file against that list.
// A guide that does not ship is a broken link for a coding agent reading the package in node_modules.
// Usage: node scripts/check-package-links.mjs [folder]    the repository checkout by default
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { externalPattern, knownGeneratedLinks, linkPattern, linkResolves, skippedFolders } from './check-links.mjs';

const alwaysShippedPattern = /^(package\.json|readme(\.[a-z]+)?|licen[sc]e(\.[a-z]+)?)$/i;
export const SITE_LINK_FIX = 'Use https://crucible.codepawl.com/<guide>.md for guides that do not ship, or add the guide to "files" in package.json.';

function listFolder(folder) {
  const found = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) found.push(...listFolder(path));
    else found.push(path);
  }
  return found;
}

function matchesExclusion(relativePath, exclusion) {
  return relativePath === exclusion || relativePath.startsWith(`${exclusion.replace(/\/$/, '')}/`);
}

// Absolute paths of the files npm would pack, for the plain file and folder entries the "files" list uses.
export function listShippedFiles(root) {
  const entries = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files ?? [];
  const exclusions = entries.filter((entry) => entry.startsWith('!')).map((entry) => entry.slice(1));
  const shipped = new Set();
  for (const name of readdirSync(root)) {
    if (alwaysShippedPattern.test(name)) shipped.add(resolve(root, name));
  }
  for (const entry of entries.filter((candidate) => !candidate.startsWith('!'))) {
    const path = resolve(root, entry);
    if (!existsSync(path)) continue;
    const files = statSync(path).isDirectory() ? listFolder(path) : [path];
    for (const file of files) shipped.add(file);
  }
  for (const file of [...shipped]) {
    const relativePath = relative(root, file).replace(/\\/g, '/');
    if (exclusions.some((exclusion) => matchesExclusion(relativePath, exclusion))) shipped.delete(file);
  }
  return shipped;
}

function isCheckedFile(root, file) {
  const segments = relative(root, file).split(/[\\/]/);
  return /\.(md|html)$/.test(file) && !segments.some((segment) => skippedFolders.has(segment));
}

function parentFolders(root, file) {
  const parents = [];
  for (let folder = resolve(file, '..'); folder.length >= root.length; folder = resolve(folder, '..')) parents.push(folder);
  return parents;
}

// Returns { checked, broken: [{ file, line, link }] } for the links of shipped files that point at a file that does not ship.
export function findUnshippedLinks(root) {
  const shipped = listShippedFiles(root);
  const shippedFolders = new Set([...shipped].flatMap((file) => parentFolders(root, file)));
  const shipsPath = (candidate) => shipped.has(resolve(candidate)) || shippedFolders.has(resolve(candidate));
  const files = [...shipped].filter((file) => isCheckedFile(root, file)).sort();
  const broken = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(linkPattern)) {
      const link = match[1];
      if (externalPattern.test(link) || knownGeneratedLinks.has(link)) continue;
      if (linkResolves(root, file, link, shipsPath)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      broken.push({ file: relative(root, file).replace(/\\/g, '/'), line, link });
    }
  }
  return { checked: files.length, broken };
}

function main() {
  const root = resolve(process.argv[2] ?? process.cwd());
  const { checked, broken } = findUnshippedLinks(root);
  console.log(`${checked} shipped files checked, ${broken.length} links to files the package does not ship`);
  for (const { file, line, link } of broken) console.log(`${file}:${line} links to ${link}, which is not in the package. ${SITE_LINK_FIX}`);
  process.exitCode = broken.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
