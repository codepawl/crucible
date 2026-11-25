// Checks the description and the files of a pull request against CONTRIBUTING.md. Pure: it reads no network and no disk,
// so tests call it with plain objects. The `PR metadata` workflow (.github/workflows/pr-metadata.yml) runs it on the base branch.
//
// Input:  { pr: { body, title, author, authorAssociation, labels, milestone, draft, lookApproved }, files: [{ filename, additions, deletions }] }
//         lookApproved is true when hold:look-approval was added and the owner removed it later. The pictures were then
//         reviewed, so the look change needs no picture in the description and no new hold label.
// Output: { contributorFixes: [{ id, message, docsAnchor }], maintainerTodos: [string], addLabels: [string], removeLabels: [string] }
//
// A contributor fix is something the author can change. Labels and the milestone are the maintainer's job, so a gap there
// becomes a maintainer todo and the `needs-triage` label, and never counts against the author.

import { addedLinesFromPatch, findOutsideNames, findOutsideNamesInBody } from './check-outside-names.mjs';

export const LOOK_HOLD_LABEL = 'hold:look-approval';
export const NEEDS_TRIAGE_LABEL = 'needs-triage';
export const NEEDS_AUTHOR_LABEL = 'status:needs-author';
export const NEEDS_OWNER_DECISION_LABEL = 'needs-owner-decision';

const OWNER_LOGIN = 'anxuanng';
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const shippedPathPattern = /^(src|bin|packages|skills)\//;
// Only skills and the file that defines the MCP tool schemas need a bench table. Detail text in src/agent-scene-capabilities.js
// is not a schema, and the tool cost gate already covers schema growth.
const toolOrSkillPathPattern = /^(skills\/|scripts\/mcp-server\.mjs$)/;
const lightPathPattern = /^(docs\/|\.github\/|tests\/|changes\/)|\.md$/;
// A look change touches shaders, lighting, materials, the default render or a post step. A name part must stand alone, so
// "flight" and "highlight" do not match "light".
const lookNamePattern = /(^|[-_/.])(shaders?|glsl|lights?|lighting|materials?|environment|shadows?|tone|tonemap|fog|sky|post|bloom|ssao|taa|exposure)(?=$|[-_/.])/i;
const lookRootPattern = /^(src|packages)\//;
// A maintainer who changed a look path without changing a pixel (a compile fix, a refactor, a test) says so in one line.
const lookUnchangedPattern = /\b(?:the )?look is unchanged\b|\bno look change\b|\bpixels? (?:are |is )?unchanged\b/i;

const linkedIssuePattern = /\b(?:closes|close|closed|fixes|fix|fixed|resolves|resolve|resolved|part of):?\s+(?:#\d+|https:\/\/github\.com\/codepawl\/crucible\/issues\/\d+)/i;
const localPathPatterns = [
  /[A-Za-z]:\\+(?:Users|Documents and Settings)\\/i,
  /(?:^|[\s`"'(=])\/home\/[A-Za-z0-9._-]+/,
  /(?:^|[\s`"'(=])\/Users\/[A-Za-z0-9._-]+/,
];
const imagePattern = /!\[[^\]]*\]\([^)]+\)|<img\b|github\.com\/user-attachments\//i;
// Accepts the natural ways to say "I cannot run the bench": no login, no access, cannot run it, a maintainer runs it.
const benchOptOutPattern = /(?:\bno|\bwithout|not have|n't have|\bcannot|can't|can not|\bunable to)\b[^.\n]*\b(?:claude code|bench)\b|\bmaintainers?\b[^.\n]*\b(?:run|runs|running)\b[^.\n]*\bbench|\bbench\b[^.\n]*\bmaintainers?\b[^.\n]*\brun/i;
// A body that says the tool schemas did not change needs no bench table.
const schemasUnchangedPattern = /\bschemas?\b[^.\n]*\b(?:unchanged|not changed|did not change|do not change|don't change|are the same|stay the same)\b|\bno (?:tool )?schema changes?\b|\bunchanged\b[^.\n]*\bschemas?\b/i;
const checkedHeadings = ['How I checked it', 'Ran', 'Checks', 'Checked', 'Tests', 'Verification', 'How I tested it'];
// Pictures, a clip link, numbers from old to new, or one line saying there is nothing to see or measure.
const evidenceHeadings = ['Evidence', 'Before and after', 'Look change'];
const fencedBlockPattern = /```/;
const commandLinePattern = /^\s*(?:[$>]\s*)?(?:npm|node|npx)\s+\S/m;

// One pass can leave a new comment behind: '<!<!-- x -->-- y -->' becomes '<!-- y -->'. Repeat until nothing changes.
function stripHtmlComments(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    current = previous.replace(/<!--[\s\S]*?-->/g, '');
  } while (current !== previous);
  return current;
}

// The text under "## <heading>" up to the next "## " heading, or null when the section is missing.
export function sectionOf(body, heading) {
  const lines = stripHtmlComments(body).split(/\r?\n/);
  const wanted = heading.toLowerCase();
  const start = lines.findIndex(line => /^##\s+/.test(line) && line.replace(/^##\s+/, '').trim().toLowerCase() === wanted);
  if (start === -1) return null;
  const collected = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) break;
    collected.push(lines[index]);
  }
  return collected.join('\n');
}

function hasContent(sectionText) {
  if (sectionText === null) return false;
  const meaningful = sectionText
    .split('\n')
    .filter(line => !/^\s*[-*]\s+\[ \]/.test(line))
    .join('\n')
    .trim();
  return meaningful.length >= 10;
}

// The checks are described when a section under an equivalent heading has content, or the body shows a fenced block or a command line.
function describesChecks(body, visibleBody) {
  if (checkedHeadings.some(heading => hasContent(sectionOf(body, heading)))) return true;
  return fencedBlockPattern.test(visibleBody) || commandLinePattern.test(visibleBody);
}

// Evidence is a picture anywhere in the description, or content under an evidence heading.
function showsEvidence(body, visibleBody) {
  if (imagePattern.test(visibleBody)) return true;
  return evidenceHeadings.some(heading => hasContent(sectionOf(body, heading)));
}

function normalizePath(path) {
  return path.replace(/\\/g, '/');
}

// Only a maintainer's word counts: outside pull requests that touch a look path always wait for the owner.
export function statesLookUnchanged(pr) {
  const author = (pr.author ?? '').toLowerCase();
  const trusted = author === OWNER_LOGIN || TRUSTED_ASSOCIATIONS.has(pr.authorAssociation ?? '');
  return trusted && lookUnchangedPattern.test(stripHtmlComments(pr.body ?? ''));
}

// The owner looks at the pictures when a look path changed, the look is not approved yet, and no maintainer said the
// pixels stay the same.
function needsLookReview(pr, files) {
  return !pr.lookApproved && !statesLookUnchanged(pr) && files.some(isLookFile);
}

export function isLookPath(path) {
  const normalized = normalizePath(path);
  return lookRootPattern.test(normalized) && lookNamePattern.test(normalized);
}

// A changed line that cannot alter what renders: blank, a comment, a throw, an error constructor, braces, the head of an if
// or for that guards input, or a plain JS `const` local. GLSL declarations (`const float`) and assignments are not on the list.
const guardLinePatterns = [
  /^$/,
  /^(\/\/|\/?\*)/,
  /\bthrow\b/,
  /\bnew\s+\w*Error\b/,
  /^[{}()\]);,]+$/,
  /^(\}\s*)?(else\s+)?if\s*\(.*\)\s*\{?$/,
  /^for\s*\(.*\)\s*\{?$/,
  /^const\s+(?!(?:float|int|vec\d|mat\d|bool|uint)\b)[\w$]+\s*=\s*[^`]*;$/,
];
const throwLinePattern = /\bthrow\b|\bnew\s+\w*Error\b/;

// True when the patch only adds a thrown message or input validation: every changed line is on the guard list and at least one
// added line throws. No patch (GitHub omits it for very large diffs) is never guard only, so the file stays a look change.
export function isGuardOnlyPatch(patch) {
  if (typeof patch !== 'string' || patch.length === 0) return false;
  const changed = patch.split(/\r?\n/).filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
  if (changed.length === 0) return false;
  const bodies = changed.map(line => ({ added: line[0] === '+', text: line.slice(1).trim() }));
  const allGuards = bodies.every(({ text }) => guardLinePatterns.some(pattern => pattern.test(text)));
  const addsThrow = bodies.some(({ added, text }) => added && throwLinePattern.test(text));
  return allGuards && addsThrow && constNumbersAreKnown(bodies);
}

const numberPattern = /\b\d+(?:\.\d+)?\b/g;

function numbersIn(text) {
  return (text.match(numberPattern) ?? []).map(Number);
}

// A number on an added `const` line must be 0, 1 or already on a removed line, so tuning a value (1.2 to 1.5) is not hidden
// beside a throw. Renaming an identifier (warmColor to coolColor) still slips through: only numbers are compared.
function constNumbersAreKnown(bodies) {
  const removedNumbers = new Set(bodies.filter(({ added }) => !added).flatMap(({ text }) => numbersIn(text)));
  const addedConstLines = bodies.filter(({ added, text }) => added && /^const\s/.test(text) && !throwLinePattern.test(text));
  return addedConstLines.every(({ text }) => numbersIn(text).every(value => value === 0 || value === 1 || removedNumbers.has(value)));
}

// A look file is one whose name says look and whose changes are not just a message or an input check.
export function isLookFile(file) {
  return isLookPath(file.filename) && !isGuardOnlyPatch(file.patch);
}

// Docs, CI and test only pull requests skip every rule except the local path one.
export function isLightPullRequest(files) {
  return files.length > 0 && files.every(file => {
    const path = normalizePath(file.filename);
    return !shippedPathPattern.test(path) && lightPathPattern.test(path);
  });
}

// Dependabot and other GitHub App accounts cannot fill in a description template, so they get no contributor fixes.
export function isBotAuthor(pr) {
  return (pr.author ?? '').toLowerCase().endsWith('[bot]');
}

// Owner, maintainers, collaborators and bots are never closed by the bot.
export function isAutoCloseExempt(pr) {
  const author = (pr.author ?? '').toLowerCase();
  return author === OWNER_LOGIN
    || isBotAuthor(pr)
    || TRUSTED_ASSOCIATIONS.has(pr.authorAssociation ?? '');
}

function fix(id, message, docsAnchor) {
  return { id, message, docsAnchor };
}

function contributorFixesFor(pr, files, light) {
  const body = pr.body ?? '';
  const visibleBody = stripHtmlComments(body);
  const fixes = [];

  if (localPathPatterns.some(pattern => pattern.test(body))) {
    fixes.push(fix(
      'local-path',
      'The description has a path from your computer. Issues and pull requests are public, so swap it for a path inside the repository, or remove it.',
      'keep-private-data-out',
    ));
  }
  const outsideNames = [
    ...findOutsideNamesInBody(body),
    ...findOutsideNames(files.flatMap(file => addedLinesFromPatch(normalizePath(file.filename), file.patch))),
  ];
  if (outsideNames.length > 0) {
    fixes.push(fix(
      'outside-names',
      outsideNames.map(finding => finding.message).join(' '),
      'keep-outside-names-out',
    ));
  }
  if (light) return fixes;

  if (!linkedIssuePattern.test(visibleBody)) {
    fixes.push(fix(
      'missing-issue-link',
      'Add `Closes #123` to the description. Use `Part of #123` instead when this pull request is one step of a larger issue.',
      'link-the-issue',
    ));
  }
  if (!describesChecks(body, visibleBody)) {
    fixes.push(fix(
      'empty-how-checked',
      'Under **How I checked it** (or **Ran**), paste the commands you ran and what they printed, such as `npm run preflight` and its last lines.',
      'describe-how-you-checked-it',
    ));
  }

  const paths = files.map(file => normalizePath(file.filename));
  const needsNote = paths.some(path => shippedPathPattern.test(path));
  const hasNote = paths.some(path => /^changes\/\d+[^/]*\.md$/.test(path) && !path.endsWith('.size.md'));
  if (needsNote && !hasNote) {
    fixes.push(fix(
      'missing-change-note',
      'Add a file named `changes/<issue>.md` with one changelog bullet, such as ``- `bar` takes a `foo` option (#123)``.',
      'change-notes',
    ));
  }

  const touchesToolOrSkill = paths.some(path => toolOrSkillPathPattern.test(path));
  const hasBenchTable = /^\s*\|\s*:?-{3,}/m.test(visibleBody) && /bench|haiku|sonnet/i.test(visibleBody);
  const benchOptOut = benchOptOutPattern.test(visibleBody) || schemasUnchangedPattern.test(visibleBody);
  if (touchesToolOrSkill && !hasBenchTable && !benchOptOut) {
    fixes.push(fix(
      'missing-bench-table',
      'This changes an MCP tool or a skill, so paste the agent bench table in the description. Without a Claude Code login, write "I have no Claude Code login; a maintainer runs the bench." and a maintainer will run it. If the tool schemas did not change, write "The tool schemas are unchanged."',
      'tool-schema-and-skill-changes',
    ));
  }

  if (needsLookReview(pr, files) && !imagePattern.test(visibleBody)) {
    fixes.push(fix(
      'look-without-image',
      'This changes how a scene looks, so add a before and an after picture to the description.',
      'look-changes',
    ));
  } else if (needsNote && !showsEvidence(body, visibleBody)) {
    fixes.push(fix(
      'missing-evidence',
      'Under **Evidence**, show what changed from old to new: a before and an after picture or clip for what can be seen, or the numbers before and after for what can be measured (speed, size, memory, a score). When nothing can be seen or measured, write one line that says so.',
      'show-the-evidence',
    ));
  }
  return fixes;
}

function maintainerTodosFor(pr, files, contributorFixes) {
  const labels = pr.labels ?? [];
  const todos = [];
  if (!labels.some(label => label.startsWith('goal:'))) todos.push('Set a goal label (goal:capable, goal:light or goal:ai).');
  if (!labels.some(label => ['bug', 'enhancement', 'documentation'].includes(label))) todos.push('Set a type label (bug, enhancement or documentation).');
  if (!pr.milestone) todos.push('Set a milestone.');
  const paths = files.map(file => normalizePath(file.filename));
  if (needsLookReview(pr, files)) todos.push('Look change: only the owner removes hold:look-approval after seeing the pictures.');
  const needsToolBench = paths.some(path => toolOrSkillPathPattern.test(path));
  if (needsToolBench && contributorFixes.length === 0 && benchOptOutPattern.test(pr.body ?? '')) {
    todos.push('Run the agent bench for this pull request (bench/agent-modeling).');
  }
  return todos;
}

export function checkPullRequest({ pr, files }) {
  const labels = pr.labels ?? [];
  const light = isLightPullRequest(files);
  const contributorFixes = isBotAuthor(pr) ? [] : contributorFixesFor(pr, files, light);
  const maintainerTodos = maintainerTodosFor(pr, files, contributorFixes);
  const addLabels = [];
  const removeLabels = [];

  const classificationMissing = maintainerTodos.some(todo => /^Set a/.test(todo));
  if (classificationMissing && !labels.includes(NEEDS_TRIAGE_LABEL)) addLabels.push(NEEDS_TRIAGE_LABEL);
  if (!classificationMissing && labels.includes(NEEDS_TRIAGE_LABEL)) removeLabels.push(NEEDS_TRIAGE_LABEL);

  const needsHold = needsLookReview(pr, files);
  if (needsHold && !labels.includes(LOOK_HOLD_LABEL)) addLabels.push(LOOK_HOLD_LABEL);

  if (!isAutoCloseExempt(pr)) {
    if (contributorFixes.length > 0 && !labels.includes(NEEDS_AUTHOR_LABEL)) addLabels.push(NEEDS_AUTHOR_LABEL);
    if (contributorFixes.length === 0 && labels.includes(NEEDS_AUTHOR_LABEL)) removeLabels.push(NEEDS_AUTHOR_LABEL);
  }
  return { contributorFixes, maintainerTodos, addLabels, removeLabels };
}
