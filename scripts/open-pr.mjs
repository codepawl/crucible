// Opens a pull request that passes the `PR metadata` check on its first run.
// Usage: node scripts/open-pr.mjs --title <text> --body-file <file> [--labels a,b] [--milestone <name>] [--base main]
//                                 [--evidence <files...>] [--dry-run]
// Steps: run the metadata checks locally on the body and the changed files, make sure the branch is pushed, run one
// `gh pr create`, push evidence for the new number and insert it under "## Evidence", then read the body back.
// --dry-run runs the local checks and prints the commands and the final body; it writes nothing on the network.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPullRequest } from './pr-metadata-check.mjs';
import { formatReport, pushEvidence } from './push-evidence.mjs';

const USAGE = 'Usage: node scripts/open-pr.mjs --title <text> --body-file <file> [--labels a,b] [--milestone <name>] [--base main] [--evidence <files...>] [--dry-run]';
const EVIDENCE_HEADING = '## Evidence';
const PLACEHOLDER_PR_NUMBER = '<pr>';
const CLIP_EXTENSIONS = ['.mp4', '.webm'];

export function parseArguments(argv) {
  const options = { title: '', bodyFile: '', labels: [], milestone: '', base: 'main', evidence: [], dryRun: false };
  const needValue = (flag, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value. ${USAGE}`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--title') {
      options.title = needValue(argument, index);
      index += 1;
    } else if (argument === '--body-file') {
      options.bodyFile = needValue(argument, index);
      index += 1;
    } else if (argument === '--labels') {
      options.labels = needValue(argument, index).split(',').map(label => label.trim()).filter(Boolean);
      index += 1;
    } else if (argument === '--milestone') {
      options.milestone = needValue(argument, index);
      index += 1;
    } else if (argument === '--base') {
      options.base = needValue(argument, index);
      index += 1;
    } else if (argument === '--evidence') {
      while (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        options.evidence.push(argv[index + 1]);
        index += 1;
      }
      if (options.evidence.length === 0) throw new Error(`--evidence needs at least one picture or clip. ${USAGE}`);
    } else {
      throw new Error(`Unknown argument "${argument}". ${USAGE}`);
    }
  }
  if (!options.title.trim()) throw new Error(`Pass --title "<imperative sentence> (#<issue>)". ${USAGE}`);
  if (!options.bodyFile) throw new Error(`Pass --body-file <file> with the description. ${USAGE}`);
  return options;
}

// A body of "-" is what a failed `gh pr create --body-file -` leaves behind, so refuse it before anything is created.
export function validateBody(body) {
  const trimmed = body.trim();
  if (trimmed === '' || trimmed === '-') {
    throw new Error('The description is empty or "-". Write the description to a file (what changed, "Closes #N", "## How I checked it", "## Evidence") and pass it with --body-file.');
  }
}

export function evidenceMarkdown(links) {
  return links
    .map(({ name, url }) => {
      if (!url) return `- ${name}`;
      const isClip = CLIP_EXTENSIONS.some(extension => name.toLowerCase().endsWith(extension));
      return isClip ? `- [${name}](${url})` : `![${name}](${url})`;
    })
    .join('\n');
}

// Appends the evidence to an existing "## Evidence" section, or adds the section at the end.
export function insertEvidence(body, markdown) {
  const lines = body.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const start = lines.findIndex(line => /^##\s+Evidence\s*$/i.test(line));
  if (start === -1) return `${lines.join('\n')}\n\n${EVIDENCE_HEADING}\n\n${markdown}\n`;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const before = lines.slice(0, end).join('\n').replace(/\n+$/, '');
  const after = lines.slice(end).join('\n');
  return `${before}\n\n${markdown}\n${after ? `\n${after}\n` : ''}`;
}

function normalizeBody(text) {
  return text.replace(/\r\n/g, '\n').trim();
}

export function formatFindings(findings) {
  return findings.map(({ id, message }) => `- ${id}: ${message}`).join('\n');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

export function defaultServices(cwd = process.cwd()) {
  return {
    git: args => run('git', args, cwd),
    gh: args => run('gh', args, cwd),
    pushEvidence: options => pushEvidence({ ...options, cwd }),
    writeTempBody: text => {
      const folder = mkdtempSync(join(tmpdir(), 'open-pr-'));
      process.once('exit', () => rmSync(folder, { recursive: true, force: true }));
      const path = join(folder, 'body.md');
      writeFileSync(path, text);
      return path;
    },
    readFile: path => (existsSync(resolve(cwd, path)) ? readFileSync(resolve(cwd, path), 'utf8') : null),
  };
}

export function createCommandArguments({ title, bodyFile, labels, milestone, base }) {
  const args = ['pr', 'create', '--title', title, '--body-file', bodyFile, '--base', base];
  if (labels.length > 0) args.push('--label', labels.join(','));
  if (milestone) args.push('--milestone', milestone);
  return args;
}

function commandLine(args) {
  return `gh ${args.map(argument => (/[\s"]/.test(argument) ? JSON.stringify(argument) : argument)).join(' ')}`;
}

function changedFiles(services, base) {
  const names = services.git(['diff', '--name-only', `origin/${base}...HEAD`]);
  return names.split('\n').filter(Boolean).map(filename => ({ filename, additions: 0, deletions: 0 }));
}

// Pushes the branch unless the remote already has this exact commit. Returns whether a push was (or would be) made.
function ensureBranchPushed(services, dryRun) {
  const branch = services.git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'HEAD') throw new Error('HEAD is detached. Check out the branch to open the pull request from, such as 1805-open-pr.');
  const head = services.git(['rev-parse', 'HEAD']);
  const remote = services.git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  if (remote.split(/\s+/)[0] === head) return { branch, pushed: false };
  if (!dryRun) services.git(['push', '-u', 'origin', 'HEAD']);
  return { branch, pushed: true };
}

export function openPullRequest(options, services = defaultServices()) {
  const log = [];
  const rawBody = services.readFile(options.bodyFile);
  if (rawBody === null) throw new Error(`Body file not found: ${options.bodyFile}. Pass the path of the description file with --body-file.`);
  validateBody(rawBody);

  const previewLinks = options.evidence.length > 0
    ? services.pushEvidence({ prNumber: PLACEHOLDER_PR_NUMBER, files: options.evidence, dryRun: true }).links
    : [];
  const checkedBody = options.evidence.length > 0 ? insertEvidence(rawBody, evidenceMarkdown(previewLinks)) : rawBody;

  const files = changedFiles(services, options.base);
  if (files.length === 0) throw new Error(`No changed files against origin/${options.base}. Commit your change on this branch first.`);
  const report = checkPullRequest({
    pr: { body: checkedBody, title: options.title, author: '', labels: options.labels, milestone: options.milestone || null },
    files,
  });
  if (report.contributorFixes.length > 0) {
    throw new Error(`The metadata check would fail on ${report.contributorFixes.length} finding(s). Fix the description and run again:\n${formatFindings(report.contributorFixes)}`);
  }

  const branchState = ensureBranchPushed(services, options.dryRun);
  const createArguments = createCommandArguments(options);
  if (options.dryRun) {
    log.push(`git push -u origin HEAD  (${branchState.pushed ? 'needed' : 'branch already pushed, skipped'})`);
    log.push(commandLine(createArguments));
    if (options.evidence.length > 0) {
      log.push(`node scripts/push-evidence.mjs ${PLACEHOLDER_PR_NUMBER} ${options.evidence.join(' ')}`);
      log.push(`gh pr edit ${PLACEHOLDER_PR_NUMBER} --body-file <final body>`);
    }
    return { dryRun: true, log, finalBody: checkedBody, url: null };
  }

  const url = services.gh(createArguments).split('\n').pop().trim();
  const prNumber = (/\/pull\/(\d+)/.exec(url) ?? [])[1];
  if (!prNumber) throw new Error(`gh pr create did not print a pull request URL (got "${url}"). Check the pull request on GitHub.`);

  let finalBody = rawBody;
  if (options.evidence.length > 0) {
    const pushed = services.pushEvidence({ prNumber: Number(prNumber), files: options.evidence });
    log.push(formatReport(pushed));
    finalBody = insertEvidence(rawBody, evidenceMarkdown(pushed.links));
    services.gh(['pr', 'edit', prNumber, '--body-file', services.writeTempBody(finalBody)]);
  }

  const storedBody = JSON.parse(services.gh(['pr', 'view', prNumber, '--json', 'body'])).body ?? '';
  if (normalizeBody(storedBody) !== normalizeBody(finalBody)) {
    throw new Error(`The body of ${url} does not match the file that was sent (stored ${storedBody.length} characters, sent ${finalBody.length}). Open the pull request and fix the description with gh pr edit ${prNumber} --body-file <file>.`);
  }
  log.push(`Opened ${url}`);
  return { dryRun: false, log, finalBody, url };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = openPullRequest(options);
    console.log(result.log.join('\n'));
    if (result.dryRun) console.log(`\nFinal body:\n\n${result.finalBody}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
