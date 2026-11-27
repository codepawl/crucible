// Fails when a tracked source file binds a variable, function or parameter to a one-letter or abbreviated name.
// Usage: npm run check:names
// Covers JavaScript (const/let/var, destructuring, function, arrow, method and catch parameters) and Python
// (assignments, def names, def parameters, for targets).
// The house rule: descriptive full names. Only loop indices i j k n, coordinates x y z u v, t, w h, colour channels r g b a and _
// may stay short, and tmp, cfg, res, obj, buf, idx, msg, el, cb, fn are never allowed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED_SHORT_NAMES = new Set(['i', 'j', 'k', 'n', 'x', 'y', 'z', 'u', 'v', 't', 'w', 'h', 'r', 'g', 'b', 'a', '_']);
const ABBREVIATIONS = new Set(['tmp', 'cfg', 'res', 'obj', 'buf', 'idx', 'msg', 'el', 'cb', 'fn']);

const SCANNED_PATH = /^(src|scripts|bin|bench|tests)\/|^packages\/[^/]+\/src\//;
const JAVASCRIPT_FILE = /\.(js|mjs|ts)$/;
const PYTHON_FILE = /\.py$/;
const PYTHON_PATH = /^(src|scripts|bench|tests)\//;
const SKIPPED_PATH = /\.min\.|(^|\/)(vendor|dist|generated|node_modules)\/|\.generated\./;

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_CHARACTER = /[\w$]/;
const IDENTIFIER_AT_START = /^[A-Za-z_$][\w$]*/;
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'of', 'in', 'delete', 'void', 'throw', 'else', 'do', 'yield', 'await', 'new']);
const NOT_A_METHOD_NAME = new Set(['if', 'for', 'while', 'switch', 'with', 'function', 'return', 'typeof', 'await', 'void', 'delete', 'new', 'super']);
const CLOSING_FOR = { '(': ')', '[': ']', '{': '}' };
const OPENERS = '([{';
const CLOSERS = ')]}';

function isDisallowed(name) {
  if (ABBREVIATIONS.has(name)) return true;
  return /^[A-Za-z]$/.test(name) && !ALLOWED_SHORT_NAMES.has(name);
}

function lineOf(text, index) {
  let line = 1;
  for (let position = 0; position < index; position++) {
    if (text.charCodeAt(position) === 10) line++;
  }
  return line;
}

function blankKeepingNewlines(text) {
  return text.replace(/[^\n]/g, ' ');
}

// Replaces comments, strings, template text and regex literals with spaces (newlines kept, so line numbers hold).
// `${...}` expressions inside templates stay as code.
function maskJavaScript(text) {
  const output = [];
  const templateBraceDepths = [];
  let index = 0;
  let lastSignificant = '';
  let lastWord = '';
  let insideTemplate = false;

  const emitMasked = (from, to) => {
    output.push(blankKeepingNewlines(text.slice(from, to)));
  };

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];

    if (insideTemplate) {
      let end = index;
      while (end < text.length && text[end] !== '`' && !(text[end] === '$' && text[end + 1] === '{')) {
        end += text[end] === '\\' ? 2 : 1;
      }
      emitMasked(index, end);
      if (end >= text.length) break;
      if (text[end] === '`') {
        output.push(' ');
        insideTemplate = false;
        lastSignificant = 'a';
        lastWord = '';
        index = end + 1;
      } else {
        output.push('  ');
        templateBraceDepths.push(0);
        insideTemplate = false;
        lastSignificant = '{';
        lastWord = '';
        index = end + 2;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      let end = text.indexOf('\n', index);
      if (end === -1) end = text.length;
      emitMasked(index, end);
      index = end;
      continue;
    }
    if (character === '/' && next === '*') {
      let end = text.indexOf('*/', index + 2);
      end = end === -1 ? text.length : end + 2;
      emitMasked(index, end);
      index = end;
      continue;
    }
    if (character === '"' || character === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== character && text[end] !== '\n') {
        end += text[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + 1, text.length);
      emitMasked(index, end);
      lastSignificant = 'a';
      lastWord = '';
      index = end;
      continue;
    }
    if (character === '`') {
      output.push(' ');
      insideTemplate = true;
      index++;
      continue;
    }
    if (character === '/') {
      const regexAllowed = lastSignificant === '' || !/[\w$)\]}]/.test(lastSignificant) || KEYWORDS_BEFORE_REGEX.has(lastWord);
      if (regexAllowed) {
        let end = index + 1;
        let insideClass = false;
        while (end < text.length && text[end] !== '\n') {
          const regexCharacter = text[end];
          if (regexCharacter === '\\') {
            end += 2;
            continue;
          }
          if (regexCharacter === '[') insideClass = true;
          else if (regexCharacter === ']') insideClass = false;
          else if (regexCharacter === '/' && !insideClass) break;
          end++;
        }
        end++;
        while (end < text.length && /[a-z]/.test(text[end])) end++;
        emitMasked(index, end);
        lastSignificant = 'a';
        lastWord = '';
        index = end;
        continue;
      }
    }
    if (character === '{' && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1]++;
    } else if (character === '}' && templateBraceDepths.length > 0) {
      if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
        templateBraceDepths.pop();
        output.push(' ');
        insideTemplate = true;
        index++;
        continue;
      }
      templateBraceDepths[templateBraceDepths.length - 1]--;
    }

    output.push(character);
    if (!/\s/.test(character)) {
      lastSignificant = character;
      if (IDENTIFIER_CHARACTER.test(character)) {
        lastWord = IDENTIFIER_CHARACTER.test(text[index - 1] ?? '') ? lastWord + character : character;
      } else {
        lastWord = '';
      }
    }
    index++;
  }
  return output.join('');
}

// Index of the bracket that closes the one at `openIndex`, or -1.
function matchingCloser(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index++) {
    if (OPENERS.includes(code[index])) depth++;
    else if (CLOSERS.includes(code[index])) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Index of the bracket that opens the one at `closeIndex`, or -1.
function matchingOpener(code, closeIndex) {
  let depth = 0;
  for (let index = closeIndex; index >= 0; index--) {
    if (CLOSERS.includes(code[index])) depth++;
    else if (OPENERS.includes(code[index])) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// Splits `text` at commas that sit outside every bracket pair. Each part keeps its start offset.
function splitTopLevel(text, baseIndex) {
  const parts = [];
  let depth = 0;
  let partStart = 0;
  for (let index = 0; index <= text.length; index++) {
    const character = text[index];
    if (index === text.length || (character === ',' && depth === 0)) {
      parts.push({ text: text.slice(partStart, index), start: baseIndex + partStart });
      partStart = index + 1;
    } else if (OPENERS.includes(character)) depth++;
    else if (CLOSERS.includes(character)) depth--;
  }
  return parts;
}

// First index of `target` outside every bracket pair, ignoring `=>` and comparison operators when looking for '='.
function topLevelIndexOf(text, target) {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (OPENERS.includes(character)) depth++;
    else if (CLOSERS.includes(character)) depth--;
    else if (depth === 0 && character === target) {
      if (target !== '=') return index;
      const before = text[index - 1];
      const after = text[index + 1];
      if (after !== '=' && after !== '>' && before !== '=' && before !== '!' && before !== '<' && before !== '>') return index;
    }
  }
  return -1;
}

// Pushes every name bound by a binding pattern or a single identifier: `a`, `[a, [b]]`, `{ key: value, other = 1, ...rest }`.
function collectBindings(patternText, baseIndex, found) {
  const leading = patternText.length - patternText.trimStart().length;
  const text = patternText.trim();
  const start = baseIndex + leading;
  if (text === '') return;
  if (text[0] === '[' || text[0] === '{') {
    const closeIndex = matchingCloser(text, 0);
    if (closeIndex === -1) return;
    const inner = text.slice(1, closeIndex);
    for (const part of splitTopLevel(inner, start + 1)) {
      let elementText = part.text;
      let elementStart = part.start;
      const defaultIndex = topLevelIndexOf(elementText, '=');
      if (defaultIndex !== -1) elementText = elementText.slice(0, defaultIndex);
      if (text[0] === '{') {
        const colonIndex = topLevelIndexOf(elementText, ':');
        if (colonIndex !== -1) {
          elementStart += colonIndex + 1;
          elementText = elementText.slice(colonIndex + 1);
        }
      }
      collectBindings(elementText.replace(/^(\s*)\.\.\./, '$1   '), elementStart, found);
    }
    return;
  }
  const match = IDENTIFIER_AT_START.exec(text.replace(/^\.\.\.\s*/, ''));
  if (match) found.push({ name: match[0], index: start + text.indexOf(match[0]) });
}

function collectParameters(code, openIndex, found) {
  const closeIndex = matchingCloser(code, openIndex);
  if (closeIndex === -1) return;
  const inner = code.slice(openIndex + 1, closeIndex);
  for (const part of splitTopLevel(inner, openIndex + 1)) {
    const defaultIndex = topLevelIndexOf(part.text, '=');
    const bindingText = defaultIndex === -1 ? part.text : part.text.slice(0, defaultIndex);
    collectBindings(bindingText, part.start, found);
  }
}

// After a `const`, `let` or `var`: reads the declarators `a = 1, [b, c] = pair, { d } = e` until the statement or for-head ends.
function collectDeclarators(code, startIndex, found) {
  let index = startIndex;
  while (index < code.length) {
    while (index < code.length && /\s/.test(code[index])) index++;
    if (code[index] === '[' || code[index] === '{') {
      const closeIndex = matchingCloser(code, index);
      if (closeIndex === -1) return;
      collectBindings(code.slice(index, closeIndex + 1), index, found);
      index = closeIndex + 1;
    } else {
      const match = IDENTIFIER_AT_START.exec(code.slice(index, index + 80));
      if (!match) return;
      found.push({ name: match[0], index });
      index += match[0].length;
    }
    index = skipInitializer(code, index);
    if (code[index] !== ',') return;
    index++;
  }
}

// Moves past one declarator's type annotation and initializer. Stops on a top-level comma, `;`, closing bracket, `of`/`in` or a statement break.
function skipInitializer(code, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < code.length; index++) {
    const character = code[index];
    if (OPENERS.includes(character)) depth++;
    else if (CLOSERS.includes(character)) {
      if (depth === 0) return index;
      depth--;
    } else if (depth === 0 && (character === ',' || character === ';')) return index;
    else if (depth === 0 && IDENTIFIER_START.test(character) && !IDENTIFIER_CHARACTER.test(code[index - 1] ?? ' ')) {
      const word = /^[\w$]+/.exec(code.slice(index, index + 20))[0];
      if (word === 'of' || word === 'in') return index;
      index += word.length - 1;
    } else if (depth === 0 && character === '\n') {
      if (!continuesAcrossNewline(code, index)) return index;
    }
  }
  return code.length;
}

function continuesAcrossNewline(code, newlineIndex) {
  let before = newlineIndex - 1;
  while (before >= 0 && /\s/.test(code[before])) before--;
  let after = newlineIndex + 1;
  while (after < code.length && /\s/.test(code[after])) after++;
  const previous = code[before] ?? '';
  const following = code[after] ?? '';
  return /[,=+\-*/&|?:(<>.%^!~]/.test(previous) || /[.?:+\-*/&|,=<>%^]/.test(following);
}

// True when the name at `nameIndex` sits where a method definition starts: after `{ } ; ,` or the file start,
// allowing the `static`, `async`, `get`, `set` modifiers and a generator `*` in between.
function startsMethodDefinition(code, nameIndex) {
  let index = nameIndex - 1;
  for (;;) {
    while (index >= 0 && /\s/.test(code[index])) index--;
    if (index >= 0 && code[index] === '*') {
      index--;
      continue;
    }
    let wordStart = index;
    while (wordStart >= 0 && IDENTIFIER_CHARACTER.test(code[wordStart])) wordStart--;
    const modifier = code.slice(wordStart + 1, index + 1);
    if (!['static', 'async', 'get', 'set'].includes(modifier)) break;
    index = wordStart;
  }
  return index < 0 || '{};,'.includes(code[index]);
}

function collectMethodParameters(code, openIndex, found) {
  const closeIndex = matchingCloser(code, openIndex);
  if (closeIndex === -1) return;
  let afterIndex = closeIndex + 1;
  while (afterIndex < code.length && /\s/.test(code[afterIndex])) afterIndex++;
  if (code[afterIndex] === '{') collectParameters(code, openIndex, found);
}

function findJavaScriptBindings(code) {
  const found = [];

  for (const match of code.matchAll(/(?<![.\w$])(?:const|let|var)\b(?!\s*[:=,;)])/g)) {
    collectDeclarators(code, match.index + match[0].length, found);
  }

  for (const match of code.matchAll(/(?<![.\w$])function\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>(]*>)?\s*\(/g)) {
    if (match[1]) found.push({ name: match[1], index: match.index + match[0].indexOf(match[1], 8) });
    collectParameters(code, match.index + match[0].length - 1, found);
  }

  for (const match of code.matchAll(/=>/g)) {
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(code[before])) before--;
    if (code[before] === ')') {
      const openIndex = matchingOpener(code, before);
      if (openIndex !== -1) collectParameters(code, openIndex, found);
    } else if (before >= 0 && IDENTIFIER_CHARACTER.test(code[before])) {
      let wordStart = before;
      while (wordStart > 0 && IDENTIFIER_CHARACTER.test(code[wordStart - 1])) wordStart--;
      found.push({ name: code.slice(wordStart, before + 1), index: wordStart });
    }
  }

  for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (NOT_A_METHOD_NAME.has(name) || !startsMethodDefinition(code, match.index)) continue;
    collectMethodParameters(code, match.index + match[0].length - 1, found);
  }

  for (const match of code.matchAll(/\]\s*\(/g)) {
    const keyOpenIndex = matchingOpener(code, match.index);
    if (keyOpenIndex === -1 || !startsMethodDefinition(code, keyOpenIndex)) continue;
    collectMethodParameters(code, match.index + match[0].length - 1, found);
  }

  return found;
}

// Returns { line, name } for each disallowed binding in a JavaScript source text. Pure, so tests can call it without git.
export function findAbbreviatedNames(text) {
  const code = maskJavaScript(text);
  const seen = new Set();
  const findings = [];
  for (const { name, index } of findJavaScriptBindings(code)) {
    if (!isDisallowed(name)) continue;
    const key = `${index}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ line: lineOf(code, index), name, index });
  }
  findings.sort((first, second) => first.index - second.index);
  return findings.map(({ line, name }) => ({ line, name }));
}

// Replaces comments and string contents with spaces (newlines kept). Handles #, ', ", and triple quotes.
function maskPython(text) {
  const output = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '#') {
      let end = text.indexOf('\n', index);
      if (end === -1) end = text.length;
      output.push(blankKeepingNewlines(text.slice(index, end)));
      index = end;
    } else if (character === '"' || character === "'") {
      const triple = text.startsWith(character.repeat(3), index);
      const delimiter = triple ? character.repeat(3) : character;
      let end = index + delimiter.length;
      while (end < text.length && !text.startsWith(delimiter, end)) {
        if (!triple && text[end] === '\n') break;
        end += text[end] === '\\' ? 2 : 1;
      }
      end = Math.min(end + delimiter.length, text.length);
      output.push(blankKeepingNewlines(text.slice(index, end)));
      index = end;
    } else {
      output.push(character);
      index++;
    }
  }
  return output.join('');
}

function pythonNamesIn(targetText, baseIndex, found) {
  // An attribute or subscript target (`self.size`, `table[key]`) binds no new name.
  if (targetText.includes('.') || /\w\s*\[/.test(targetText)) return;
  for (const match of targetText.matchAll(/[A-Za-z_]\w*/g)) {
    found.push({ name: match[0], index: baseIndex + match.index });
  }
}

function findPythonBindings(code) {
  const found = [];

  for (const match of code.matchAll(/\bdef\s+([A-Za-z_]\w*)\s*\(/g)) {
    found.push({ name: match[1], index: match.index + match[0].indexOf(match[1]) });
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = matchingCloser(code, openIndex);
    if (closeIndex === -1) continue;
    const inner = code.slice(openIndex + 1, closeIndex);
    for (const part of splitTopLevel(inner, openIndex + 1)) {
      const parameter = /^(\s*)(?:\*\*?)?\s*([A-Za-z_]\w*)/.exec(part.text);
      if (parameter && parameter[2] !== 'self' && parameter[2] !== 'cls') {
        found.push({ name: parameter[2], index: part.start + parameter[0].length - parameter[2].length });
      }
    }
  }

  for (const match of code.matchAll(/\bfor\s+([^\n]+?)\s+in\b/g)) {
    pythonNamesIn(match[1], match.index + match[0].indexOf(match[1]), found);
  }

  let depth = 0;
  let lineStart = 0;
  const assignment = /^[ \t]*((?:[(\[]\s*)?\*?[A-Za-z_]\w*(?:\s*,\s*\*?[A-Za-z_]\w*)*(?:\s*[)\]])?)\s*(?::[^=\n]*)?(?:[-+*/%|&^@]|\/\/|\*\*|>>|<<)?=(?!=)/;
  for (let index = 0; index <= code.length; index++) {
    if (index === code.length || code[index] === '\n') {
      if (depth === 0) {
        const lineText = code.slice(lineStart, index);
        const match = assignment.exec(lineText);
        if (match) pythonNamesIn(match[1], lineStart + lineText.indexOf(match[1]), found);
      }
      lineStart = index + 1;
    } else if (OPENERS.includes(code[index])) depth++;
    else if (CLOSERS.includes(code[index])) depth = Math.max(0, depth - 1);
  }

  return found;
}

// Returns { line, name } for each disallowed binding in a Python source text.
export function findAbbreviatedPythonNames(text) {
  const code = maskPython(text);
  const seen = new Set();
  const findings = [];
  for (const { name, index } of findPythonBindings(code)) {
    if (!isDisallowed(name)) continue;
    const key = `${index}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ line: lineOf(code, index), name, index });
  }
  findings.sort((first, second) => first.index - second.index);
  return findings.map(({ line, name }) => ({ line, name }));
}

export function isScannedPath(path) {
  const normalized = path.replaceAll('\\', '/');
  if (SKIPPED_PATH.test(normalized)) return false;
  if (PYTHON_FILE.test(normalized)) return PYTHON_PATH.test(normalized);
  return SCANNED_PATH.test(normalized) && JAVASCRIPT_FILE.test(normalized);
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

function readSourceText(filePath) {
  try {
    return readFileSync(resolve(root, filePath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Source file not found: ${filePath}`);
    throw error;
  }
}

function main() {
  const paths = process.argv.length > 2 ? process.argv.slice(2) : trackedFiles().filter(isScannedPath);
  let problemCount = 0;
  for (const path of paths) {
    const text = readSourceText(path);
    const findings = PYTHON_FILE.test(path) ? findAbbreviatedPythonNames(text) : findAbbreviatedNames(text);
    for (const { line, name } of findings) {
      console.error(`${path}:${line}  \`${name}\` is a short name. Rename it to what it holds (for example thirdVertexOffset, not c).`);
      problemCount++;
    }
  }
  if (problemCount > 0) {
    console.error(`${problemCount} short name(s). Allowed short names: i j k n, x y z u v, t, w h, r g b a, _. Never tmp, cfg, res, obj, buf, idx, msg, el, cb, fn.`);
    process.exit(1);
  }
  console.log('check-names: clean');
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-names: ${error.message}`);
    process.exit(1);
  }
}
