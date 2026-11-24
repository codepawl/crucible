// Fails when a branch ADDS public text that names outside 3D software (#3401). Public text says what Crucible does, not which
// tool it was compared with or learned from. Only added lines count, so the lines that exist on main are left alone.
// Usage: npm run check:outside-names [-- --base <ref>]      (also a step of `npm run preflight`)
// The pull request metadata check calls the same rules on the files' patches and the description (scripts/pr-metadata-check.mjs).
//
// Scanned: docs/, changes/, README.md and skills/ line by line; src/ only inside comments.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// A name stands alone: not part of a path, file name or longer word, so `packages/<name>-addon` and `<name>.md` links pass.
const START = '(?<![\\w/.-])';
const END = '(?![\\w/-])';
// After a word and a space, not after a full stop, so the English word that opens a sentence ("Unity of style") is not a tool.
const MID_SENTENCE = '(?<=[\\w,;:)] )';

// Names that are also plain English words ("unity", "substance", "cycles") match only in the form the tool is written.
export const OUTSIDE_NAMES = Object.freeze([
  { word: 'Blender', pattern: new RegExp(`${START}blender${END}`, 'i') },
  { word: 'Maya', pattern: new RegExp(`${START}maya${END}`, 'i') },
  { word: 'Cinema 4D', pattern: new RegExp(`${START}cinema 4d${END}`, 'i') },
  { word: 'C4D', pattern: new RegExp(`${START}c4d${END}`, 'i') },
  { word: 'Houdini', pattern: new RegExp(`${START}houdini${END}`, 'i') },
  { word: '3ds Max', pattern: new RegExp(`${START}3ds max${END}`, 'i') },
  { word: 'Unreal', pattern: new RegExp(`${START}Unreal${END}`) },
  { word: 'Unity', pattern: new RegExp(`${MID_SENTENCE}Unity${END}`) },
  { word: 'ZBrush', pattern: new RegExp(`${START}zbrush${END}`, 'i') },
  { word: 'Substance', pattern: new RegExp(`${START}Substance (?:Painter|Designer|3D)${END}`) },
  { word: 'Cycles', pattern: new RegExp(`${START}Cycles (?:renderer|path tracer|render engine)${END}`, 'i') },
  { word: 'Modo', pattern: new RegExp(`${MID_SENTENCE}Modo${END}`) },
  { word: 'SketchUp', pattern: new RegExp(`${START}sketchup${END}`, 'i') },
  { word: 'Marmoset', pattern: new RegExp(`${START}marmoset${END}`, 'i') },
]);

// Exceptions on context. A match passes when its line carries one of these, and each says why.
export const CONTEXT_EXCEPTIONS = Object.freeze([
  {
    reason: 'a keymap preset is named after the program whose keys it copies, and the person picks it by that label in Settings',
    pattern: /\bkey ?maps?\b|\bpresets?\b/i,
  },
  {
    reason: 'an import file format is named by its extension or as a file format, and the user needs it to pick the file',
    pattern: /\.(?:blend|max|c4d|hip|hiplc|hipnc|ma|mb|ztl|skp)\b|\bfile formats?\b/i,
  },
]);

// Whole files kept out of the scan, with the reason. Their job is to name the tool.
export const EXCLUDED_PATHS = Object.freeze({
  'docs/studio-blender-parity.md': 'the compatibility map of Studio against that program, kept on purpose',
  'docs/blender-addon.md': 'the guide of the add-on for that program, whose name is the subject',
});

const WHOLE_LINE_PATH = /^(docs|changes|skills)\/|^README\.md$/;
const COMMENT_ONLY_PATH = /^src\//;
const TEXT_FILE = /\.(md|txt|html|json)$/;
const SOURCE_FILE = /\.(js|mjs|ts)$/;

export function isScannedPath(path) {
  const normalized = path.replace(/\\/g, '/');
  if (normalized in EXCLUDED_PATHS) return false;
  if (WHOLE_LINE_PATH.test(normalized)) return TEXT_FILE.test(normalized);
  return COMMENT_ONLY_PATH.test(normalized) && SOURCE_FILE.test(normalized);
}

// The comment part of one source line: a line that is a comment, or the text after a trailing `//`. A line in the middle of
// a block comment starts with `*`. A `//` inside a string such as `https://` has no space before it, so it is not a comment.
export function commentTextOf(sourceLine) {
  const trimmed = sourceLine.trim();
  if (/^(\/\/|\/\*|\*)/.test(trimmed)) return trimmed;
  const trailing = /\s\/\/.*$/.exec(sourceLine);
  return trailing ? trailing[0] : '';
}

function scannedTextOf(path, text) {
  return COMMENT_ONLY_PATH.test(path) ? commentTextOf(text) : text;
}

function findInText(text) {
  const names = OUTSIDE_NAMES.filter(name => name.pattern.test(text));
  if (names.length === 0) return [];
  if (CONTEXT_EXCEPTIONS.some(exception => exception.pattern.test(text))) return [];
  return names.map(name => name.word);
}

function messageFor(place, word) {
  return `${place}: "${word}" names outside 3D software. Describe the behaviour instead of naming the tool; a keymap preset or file format name is allowed in that context.`;
}

// `addedLines` are { path, line, text }. Returns { path, line, word, message } for each name found. Pure.
export function findOutsideNames(addedLines) {
  const findings = [];
  for (const { path, line, text } of addedLines) {
    const normalized = path.replace(/\\/g, '/');
    if (!isScannedPath(normalized)) continue;
    for (const word of findInText(scannedTextOf(normalized, text))) {
      findings.push({ path: normalized, line, word, message: messageFor(`${normalized}:${line}`, word) });
    }
  }
  return findings;
}

// The pull request description, without the HTML comments of the template.
export function findOutsideNamesInBody(body) {
  const visible = (body ?? '').replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ''));
  const findings = [];
  visible.split(/\r?\n/).forEach((text, index) => {
    for (const word of findInText(text)) {
      findings.push({ path: 'description', line: index + 1, word, message: messageFor(`The pull request description, line ${index + 1}`, word) });
    }
  });
  return findings;
}

// The added lines of one file's unified diff, with their line numbers in the new file.
export function addedLinesFromPatch(path, patch) {
  const added = [];
  let line = 0;
  for (const text of (patch ?? '').split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (text.startsWith('+') && !text.startsWith('+++')) {
      added.push({ path, line, text: text.slice(1) });
      line += 1;
    } else if (!text.startsWith('-') && !text.startsWith('\\')) {
      line += 1;
    }
  }
  return added;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

// Added lines of the branch since its merge base: committed and staged edits, then untracked files whole.
export function addedLinesSince(baseRef) {
  const mergeBase = (git(['merge-base', baseRef, 'HEAD']) ?? baseRef).trim();
  const diff = git(['diff', '-U0', '--no-renames', mergeBase, '--', 'docs', 'changes', 'README.md', 'skills', 'src']) ?? '';
  const added = [];
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const path = /^a\/(\S+) b\//.exec(section)?.[1];
    if (path) added.push(...addedLinesFromPatch(path, section));
  }
  const untracked = (git(['ls-files', '--others', '--exclude-standard']) ?? '').split('\n').filter(isScannedPath);
  for (const path of untracked) {
    readFileSync(resolve(root, path), 'utf8').split(/\r?\n/).forEach((text, index) => added.push({ path, line: index + 1, text }));
  }
  return added;
}

function main(args) {
  const flagIndex = args.indexOf('--base');
  const baseRef = flagIndex < 0 ? 'origin/main' : args[flagIndex + 1];
  const findings = findOutsideNames(addedLinesSince(baseRef));
  for (const finding of findings) console.error(finding.message);
  if (findings.length > 0) {
    console.error(`\n${findings.length} added line${findings.length === 1 ? '' : 's'} name outside 3D software (scripts/check-outside-names.mjs).`);
    process.exit(1);
  }
  console.log(`No added public text names outside 3D software (compared with ${baseRef}).`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) main(process.argv.slice(2));
