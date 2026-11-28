// Self-check and safe repair command for Crucible CLI and MCP setup (`crucible doctor`).
// Must stay standalone from `src/` and `scripts/` because npm tarballs ship only `bin/` and `build/`.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_OPTION_NAMES } from './crucible-mcp-flags.mjs';
import { defaultPacksFolder } from './crucible-pack-folder.mjs';
import packageMetadata from '../package.json' with { type: 'json' };

const MINIMUM_NODE_VERSION = Object.freeze([20, 19, 0]);
const REQUIRED_SKILL_NAMES = Object.freeze(['build-crucible-scene', 'render-crucible-media']);
const OPTIONAL_PACKAGES = Object.freeze(['draco3d', 'three', '@codepawlhq/cook', 'playwright-core']);
const DOCTOR_USAGE = `Usage: crucible doctor [--fix] [--json] [--cwd <path>]

Audits Node.js, Chrome/Chromium + WebGL2, MCP client configs, configured directories,
memory budget, optional packages, and Crucible skills.

Options:
  --fix          Create missing directories, repair broken MCP flags, or write .mcp.json with .bak backup
  --json         Print machine-readable JSON report to stdout
  --cwd <path>   Inspect configs and project folders under this working directory`;

/** Parse `crucible doctor` CLI flags into an options object. */
export function parseDoctorArguments(argumentList) {
  const options = { fix: false, json: false, help: false, cwd: undefined };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (argument === '--fix') options.fix = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--cwd') {
      const value = argumentList[index + 1];
      if (!value || value.startsWith('--')) throw new TypeError('--cwd: pass a directory path after --cwd.');
      options.cwd = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new TypeError(`${argument}: unknown option for crucible doctor. Pass --fix, --json, or --cwd <path>.`);
    } else {
      throw new TypeError(`${argument}: unexpected positional argument for crucible doctor.`);
    }
  }
  return options;
}

function parseSemver(versionText) {
  const match = String(versionText).trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isAtLeastSemver(actual, minimum) {
  if (!actual) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

/** Recommended `--memory` MiB value bounded by Crucible's supported [256..1024] sweet spot and host RAM. */
export function recommendedMemoryMiB(totalMemoryBytes) {
  const totalMemoryMiB = Math.floor(totalMemoryBytes / (1024 * 1024));
  const maximumAllowed = Math.min(4096, Math.max(32, Math.floor(totalMemoryMiB / 2)));
  return Math.min(maximumAllowed, Math.max(256, Math.min(1024, Math.floor(totalMemoryMiB / 16))));
}

function defaultBrowserCandidates(platform, environment) {
  const candidates = [];
  if (environment.CRUCIBLE_BROWSER) candidates.push(environment.CRUCIBLE_BROWSER);
  if (environment.CHROME_PATH) candidates.push(environment.CHROME_PATH);
  if (platform === 'win32') {
    const localApplicationData = environment.LOCALAPPDATA ?? '';
    const programFiles = environment.PROGRAMFILES ?? 'C:\\Program Files';
    const programFilesX86 = environment['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    candidates.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localApplicationData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return candidates.filter(Boolean);
}

function defaultFindBrowser({ platform, environment }) {
  for (const candidate of defaultBrowserCandidates(platform, environment)) {
    if (existsSync(candidate)) return candidate;
  }
  const commands = platform === 'win32' ? ['chrome', 'msedge'] : ['google-chrome', 'chromium', 'chromium-browser'];
  const locator = platform === 'win32' ? 'where' : 'which';
  for (const command of commands) {
    try {
      const output = execFileSync(locator, [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const firstLine = output.split(/\r?\n/).find(line => line.trim());
      if (firstLine && existsSync(firstLine.trim())) return firstLine.trim();
    } catch {
      // Binary not found on PATH.
    }
  }
  return null;
}

function defaultProbeBrowserVersion(executablePath) {
  try {
    const output = execFileSync(executablePath, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return { ok: true, detail: output.trim() };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function mcpClientTargets({ homeDirectory, workingDirectory }) {
  return [
    { client: 'claude-code-user', label: 'Claude Code (~/.claude.json)', configPath: join(homeDirectory, '.claude.json') },
    { client: 'claude-code-project', label: 'Project MCP (.mcp.json)', configPath: join(workingDirectory, '.mcp.json') },
    { client: 'cursor', label: 'Cursor (~/.cursor/mcp.json)', configPath: join(homeDirectory, '.cursor', 'mcp.json') },
    { client: 'gemini-cli', label: 'Gemini CLI (~/.gemini/settings.json)', configPath: join(homeDirectory, '.gemini', 'settings.json') },
    { client: 'antigravity', label: 'Antigravity (~/.gemini/antigravity/mcp_config.json)', configPath: join(homeDirectory, '.gemini', 'antigravity', 'mcp_config.json') },
  ];
}

function isCrucibleServerEntry(serverName, entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (/crucible/i.test(serverName)) return true;
  const commandText = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ');
  return /crucible-mcp/i.test(commandText);
}

function parseMcpServerFlags(argumentsList) {
  const parsed = { unknownFlags: [], missingValues: [], flags: {} };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (typeof token !== 'string' || !token.startsWith('--')) continue;
    if (!MCP_OPTION_NAMES.includes(token)) {
      parsed.unknownFlags.push(token);
      continue;
    }
    const nextValue = argumentsList[index + 1];
    if (nextValue === undefined || String(nextValue).startsWith('--')) {
      parsed.missingValues.push(token);
      continue;
    }
    parsed.flags[token] = String(nextValue);
    index += 1;
  }
  return parsed;
}

function defaultResolvePackage(packageName, baseDirectory) {
  const requireFromBase = createRequire(join(baseDirectory, 'package.json'));
  try {
    const resolvedPath = requireFromBase.resolve(packageName);
    let hasNativeBinary = null;
    if (packageName === '@codepawlhq/cook') {
      const cookPackageDirectory = dirname(requireFromBase.resolve('@codepawlhq/cook/package.json'));
      const buildCandidate = join(cookPackageDirectory, 'build', 'Release');
      const nativeCandidate = join(cookPackageDirectory, 'native');
      hasNativeBinary = existsSync(buildCandidate) || existsSync(nativeCandidate);
    }
    return { installed: true, resolvedPath, hasNativeBinary };
  } catch {
    return { installed: false, resolvedPath: null, hasNativeBinary: false };
  }
}

function checkNodePrerequisite(nodeVersion) {
  const parsed = parseSemver(nodeVersion);
  const ok = isAtLeastSemver(parsed, MINIMUM_NODE_VERSION);
  return {
    id: 'node',
    status: ok ? 'ok' : 'fail',
    title: 'Node.js runtime',
    detail: `v${String(nodeVersion).replace(/^v/, '')}`,
    impact: ok ? null : 'Crucible CLI and MCP require Node.js 20.19.0 or newer.',
    fix: ok ? null : 'Install Node.js 20.19.0 or newer (Node 22+ recommended).',
  };
}

function checkBrowserPrerequisite({ platform, environment, findBrowser, probeBrowserWebGl }) {
  const executablePath = findBrowser({ platform, environment });
  if (!executablePath) {
    return {
      id: 'browser',
      status: 'warn',
      title: 'Chrome or Chromium browser',
      detail: 'No Chrome, Chromium, or Edge binary found automatically.',
      impact: 'Without a Chromium binary, crucible-mcp fails when starting a live preview or render job.',
      fix: 'Install Chrome/Chromium or configure --browser <absolute-path> in your MCP server args.',
    };
  }
  const probe = probeBrowserWebGl(executablePath);
  if (probe?.softwareWebGl) {
    return {
      id: 'browser',
      status: 'warn',
      title: 'Chrome or Chromium browser',
      detail: `${executablePath} (software WebGL fallback detected: ${probe.graphics ?? 'SwiftShader'})`,
      impact: 'Software WebGL runs much slower than hardware GPU rendering.',
      fix: 'Check GPU drivers or launch Chrome without software WebGL overrides.',
    };
  }
  return {
    id: 'browser',
    status: 'ok',
    title: 'Chrome or Chromium browser',
    detail: probe?.detail ? `${executablePath} (${probe.detail})` : executablePath,
    impact: null,
    fix: null,
  };
}

async function readJsonSafely(filePath) {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

function inspectEntryIssues(entry, { recommendedMiB, workingDirectory, packageRoot }) {
  const argumentsList = Array.isArray(entry.args) ? entry.args : [];
  const parsed = parseMcpServerFlags(argumentsList);
  const issues = [];
  if (parsed.unknownFlags.length > 0) {
    issues.push(`Unknown or stale flags: ${parsed.unknownFlags.join(', ')}`);
  }
  if (parsed.missingValues.length > 0) {
    issues.push(`Flags missing values: ${parsed.missingValues.join(', ')}`);
  }
  const backendValue = parsed.flags['--backend'] ?? 'gpu';
  if (backendValue === 'cpu') {
    issues.push('Configured with --backend cpu instead of --backend gpu');
  }
  const memoryValue = parsed.flags['--memory'] !== undefined ? Number(parsed.flags['--memory']) : 192;
  if (!Number.isFinite(memoryValue) || memoryValue < 256) {
    issues.push(`Memory budget (${parsed.flags['--memory'] ?? 'default 192'} MiB) is below recommended ${recommendedMiB} MiB`);
  }
  for (const pathFlag of ['--assets', '--jobs', '--packs', '--audio']) {
    const flagValue = parsed.flags[pathFlag];
    if (flagValue === undefined) continue;
    if (pathFlag === '--packs' && flagValue === 'none') continue;
    if (!isAbsolute(flagValue)) {
      issues.push(`${pathFlag} must be an absolute path (got ${flagValue})`);
    }
  }
  const scriptArgument = argumentsList.find(item => typeof item === 'string' && /crucible-mcp\.mjs$/i.test(item));
  if (scriptArgument && !isAbsolute(scriptArgument) && !scriptArgument.startsWith('@')) {
    const resolvedCandidate = resolve(workingDirectory, scriptArgument);
    if (!existsSync(resolvedCandidate) && packageRoot) {
      issues.push(`MCP entrypoint uses relative path (${scriptArgument})`);
    }
  }
  if (scriptArgument && isAbsolute(scriptArgument) && !existsSync(scriptArgument)) {
    issues.push(`MCP entrypoint missing at ${scriptArgument}`);
  }
  return { parsed, issues };
}

async function checkMcpClients({ homeDirectory, workingDirectory, recommendedMiB, packageRoot }) {
  const targets = mcpClientTargets({ homeDirectory, workingDirectory });
  const discoveredEntries = [];
  const configErrors = [];
  for (const target of targets) {
    if (!existsSync(target.configPath)) continue;
    let parsedJson;
    try {
      parsedJson = await readJsonSafely(target.configPath);
    } catch (error) {
      configErrors.push(`${target.label}: invalid JSON (${error.message})`);
      continue;
    }
    const servers = parsedJson?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [serverName, entry] of Object.entries(servers)) {
      if (!isCrucibleServerEntry(serverName, entry)) continue;
      const inspection = inspectEntryIssues(entry, { recommendedMiB, workingDirectory, packageRoot });
      discoveredEntries.push({
        client: target.client,
        label: target.label,
        configPath: target.configPath,
        serverName,
        entry,
        ...inspection,
      });
    }
  }

  if (configErrors.length > 0) {
    return {
      result: {
        id: 'mcp-clients',
        status: 'fail',
        title: 'MCP client registrations',
        detail: configErrors.join('; '),
        impact: 'Malformed JSON prevents the MCP client from reading server configurations.',
        fix: 'Fix the invalid JSON syntax in the reported MCP config file.',
      },
      discoveredEntries,
    };
  }
  if (discoveredEntries.length === 0) {
    return {
      result: {
        id: 'mcp-clients',
        status: 'warn',
        title: 'MCP client registrations',
        detail: 'No crucible-mcp entry found in Claude Code, Cursor, Gemini CLI, or Antigravity configs.',
        impact: 'Without MCP registration, agents fall back to hand-coding raw primitives without scene_inspect or scene_look.',
        fix: `Run crucible doctor --fix to write ${join(workingDirectory, '.mcp.json')} with crucible-scene.`,
        repair: { kind: 'register-project-mcp', configPath: join(workingDirectory, '.mcp.json') },
      },
      discoveredEntries,
    };
  }
  const entriesWithIssues = discoveredEntries.filter(item => item.issues.length > 0);
  if (entriesWithIssues.length > 0) {
    const summary = entriesWithIssues.map(item => `${item.label} (${item.serverName}): ${item.issues.join('; ')}`).join(' | ');
    return {
      result: {
        id: 'mcp-clients',
        status: 'warn',
        title: 'MCP client registrations',
        detail: summary,
        impact: 'Stale flags, --backend cpu, or low --memory degrade render quality or reject MCP startup.',
        fix: 'Run crucible doctor --fix to repair Crucible MCP flags with a .bak backup.',
        repair: { kind: 'repair-mcp-entries', entries: entriesWithIssues },
      },
      discoveredEntries,
    };
  }
  return {
    result: {
      id: 'mcp-clients',
      status: 'ok',
      title: 'MCP client registrations',
      detail: discoveredEntries.map(item => `${item.label} (${item.serverName})`).join(', '),
      impact: null,
      fix: null,
    },
    discoveredEntries,
  };
}

function checkDirectoriesPrerequisite({ discoveredEntries, homeDirectory, workingDirectory, environment }) {
  const configuredDirectories = [];
  for (const item of discoveredEntries) {
    for (const flag of ['--assets', '--jobs', '--packs', '--audio']) {
      const value = item.parsed.flags[flag];
      if (!value || (flag === '--packs' && value === 'none') || !isAbsolute(value)) continue;
      configuredDirectories.push({ flag, path: value, source: item.label });
    }
  }
  const missingConfigured = configuredDirectories.filter(entry => !existsSync(entry.path));
  const missingDefaultJobs = discoveredEntries.some(item => item.parsed.flags['--jobs']) ? [] : [{ flag: '--jobs', path: join(workingDirectory, '.crucible', 'jobs'), source: 'project default' }];
  const packsDefault = defaultPacksFolder({ environment, home: homeDirectory });

  if (missingConfigured.length > 0) {
    return {
      id: 'directories',
      status: 'fail',
      title: 'Assets and jobs directories',
      detail: `Missing configured folders: ${missingConfigured.map(entry => `${entry.flag} ${entry.path}`).join(', ')}`,
      impact: 'crucible-mcp refuses to start when configured --assets, --jobs, --packs, or --audio paths do not exist.',
      fix: 'Run crucible doctor --fix to create missing directories, or update the path in MCP config.',
      repair: { kind: 'mkdir', paths: missingConfigured.map(entry => entry.path) },
    };
  }
  if (configuredDirectories.length === 0) {
    return {
      id: 'directories',
      status: 'warn',
      title: 'Assets and jobs directories',
      detail: `No --assets or --jobs directories configured in MCP configs (default packs folder: ${existsSync(packsDefault) ? packsDefault : 'not created'}).`,
      impact: 'Agents cannot load external GLBs via scene_asset_catalog or run offline render/export jobs without --jobs.',
      fix: `Pass --jobs ${missingDefaultJobs[0].path} (and optional --assets <folder>) or run crucible doctor --fix.`,
      repair: { kind: 'mkdir', paths: [missingDefaultJobs[0].path] },
    };
  }
  return {
    id: 'directories',
    status: 'ok',
    title: 'Assets and jobs directories',
    detail: configuredDirectories.map(entry => `${entry.flag}=${entry.path}`).join(', '),
    impact: null,
    fix: null,
  };
}

function checkMemoryPrerequisite({ discoveredEntries, totalMemoryBytes, recommendedMiB }) {
  const totalGiB = (totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(1);
  const lowMemoryEntries = discoveredEntries.filter(item => {
    const value = item.parsed.flags['--memory'];
    const configuredMiB = value === undefined ? 192 : Number(value);
    return Number.isFinite(configuredMiB) && configuredMiB < 256;
  });
  if (totalMemoryBytes >= 8 * 1024 ** 3 && lowMemoryEntries.length > 0) {
    return {
      id: 'memory',
      status: 'warn',
      title: 'Memory budget (--memory)',
      detail: `Host RAM ${totalGiB} GiB; MCP entry uses default 192 or under 256 MiB (${lowMemoryEntries.map(item => item.serverName).join(', ')}).`,
      impact: 'Low --memory shrinks render targets and can hit OOM guards on 1080p textured scenes.',
      fix: `Set --memory ${recommendedMiB} in your crucible-mcp launch args (or run crucible doctor --fix).`,
    };
  }
  return {
    id: 'memory',
    status: 'ok',
    title: 'Memory budget (--memory)',
    detail: `Host RAM ${totalGiB} GiB; recommended --memory ${recommendedMiB} MiB.`,
    impact: null,
    fix: null,
  };
}

function checkOptionalPackagesPrerequisite({ resolvePackage, packageRoot }) {
  const missing = [];
  const present = [];
  for (const packageName of OPTIONAL_PACKAGES) {
    const info = resolvePackage(packageName, packageRoot);
    if (!info.installed) {
      missing.push(packageName);
    } else if (packageName === '@codepawlhq/cook' && info.hasNativeBinary === false) {
      missing.push('@codepawlhq/cook (native binary missing)');
    } else {
      present.push(packageName);
    }
  }
  if (missing.length > 0) {
    const npmNames = missing.map(name => name.split(' ')[0]);
    return {
      id: 'optional-packages',
      status: 'warn',
      title: 'Optional decoders and native tracer',
      detail: `Missing: ${missing.join(', ')}${present.length > 0 ? ` (installed: ${present.join(', ')})` : ''}`,
      impact: 'Draco GLBs require draco3d, KTX2 textures require three, and native GPU path tracing requires @codepawlhq/cook.',
      fix: `Install needed optional packages with: npm install ${npmNames.join(' ')}`,
    };
  }
  return {
    id: 'optional-packages',
    status: 'ok',
    title: 'Optional decoders and native tracer',
    detail: present.join(', '),
    impact: null,
    fix: null,
  };
}

async function checkSkillsPrerequisite({ homeDirectory, workingDirectory, packageRoot }) {
  const bundledSkillsRoot = join(packageRoot, 'skills');
  const searchRoots = [
    join(workingDirectory, '.claude', 'skills'),
    join(workingDirectory, '.agents', 'skills'),
    join(homeDirectory, '.claude', 'skills'),
    join(homeDirectory, '.gemini', 'config', 'skills'),
    join(homeDirectory, '.agents', 'skills'),
  ];
  const installedRoots = searchRoots.filter(candidate => REQUIRED_SKILL_NAMES.every(name => existsSync(join(candidate, name, 'SKILL.md'))));
  if (installedRoots.length === 0) {
    return {
      id: 'skills',
      status: 'warn',
      title: 'Crucible agent skills',
      detail: `Skills (${REQUIRED_SKILL_NAMES.join(', ')}) were not found in project or user skill folders.`,
      impact: 'Agents lack Crucible scene/render workflow instructions and may improvise unsupported workflows.',
      fix: `Install or copy ${REQUIRED_SKILL_NAMES.join(' and ')} from @codepawlhq/crucible skills/ into your client skills folder.`,
    };
  }
  const drifted = [];
  if (existsSync(bundledSkillsRoot)) {
    for (const skillName of REQUIRED_SKILL_NAMES) {
      const bundledFile = join(bundledSkillsRoot, skillName, 'SKILL.md');
      if (!existsSync(bundledFile)) continue;
      const bundledContent = readFileSync(bundledFile, 'utf8');
      for (const rootPath of installedRoots) {
        const installedFile = join(rootPath, skillName, 'SKILL.md');
        const installedContent = readFileSync(installedFile, 'utf8');
        if (installedContent !== bundledContent) {
          drifted.push(`${skillName} in ${rootPath}`);
        }
      }
    }
  }
  if (drifted.length > 0) {
    return {
      id: 'skills',
      status: 'warn',
      title: 'Crucible agent skills',
      detail: `Installed skill text differs from Crucible ${packageMetadata.version}: ${drifted.join('; ')}`,
      impact: 'Out-of-date skills can tell agents to pass old field names or miss new verification steps.',
      fix: `Sync updated skills from ${bundledSkillsRoot} (or update the Crucible plugin) for Crucible ${packageMetadata.version}.`,
    };
  }
  return {
    id: 'skills',
    status: 'ok',
    title: 'Crucible agent skills',
    detail: `Synced in ${installedRoots[0]}`,
    impact: null,
    fix: null,
  };
}

/** Run all Crucible environment, MCP config, directory, memory, package, and skill diagnostics. */
export async function runDoctorChecks({
  environment = process.env,
  platform = process.platform,
  homeDirectory = homedir(),
  workingDirectory = process.cwd(),
  nodeVersion = process.version,
  totalMemoryBytes = totalmem(),
  findBrowser = defaultFindBrowser,
  probeBrowserWebGl = defaultProbeBrowserVersion,
  resolvePackage = defaultResolvePackage,
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  now = () => new Date().toISOString(),
} = {}) {
  const recommendedMiB = recommendedMemoryMiB(totalMemoryBytes);
  const checks = [];
  checks.push(checkNodePrerequisite(nodeVersion));
  checks.push(checkBrowserPrerequisite({ platform, environment, findBrowser, probeBrowserWebGl }));
  const { result: mcpCheck, discoveredEntries } = await checkMcpClients({ homeDirectory, workingDirectory, recommendedMiB, packageRoot });
  checks.push(mcpCheck);
  checks.push(checkDirectoriesPrerequisite({ discoveredEntries, homeDirectory, workingDirectory, environment }));
  checks.push(checkMemoryPrerequisite({ discoveredEntries, totalMemoryBytes, recommendedMiB }));
  checks.push(checkOptionalPackagesPrerequisite({ resolvePackage, packageRoot }));
  checks.push(await checkSkillsPrerequisite({ homeDirectory, workingDirectory, packageRoot }));

  const hasFail = checks.some(check => check.status === 'fail');
  const hasWarn = checks.some(check => check.status === 'warn');
  return {
    version: packageMetadata.version,
    checkedAt: now(),
    status: hasFail ? 'fail' : hasWarn ? 'warn' : 'ok',
    recommendedMemoryMiB: recommendedMiB,
    checks,
    nextSteps: checks.filter(check => check.fix).map(check => check.fix),
  };
}

function buildUpdatedArgs(argumentsList, { recommendedMiB, packageRoot, workingDirectory }) {
  const updated = [];
  let sawBackend = false;
  let sawMemory = false;
  const localEntrypoint = join(packageRoot, 'bin', 'crucible-mcp.mjs');
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (typeof token === 'string' && !token.startsWith('--') && /crucible-mcp\.mjs$/i.test(token)) {
      const candidateAbsolute = isAbsolute(token) ? token : resolve(workingDirectory, token);
      updated.push(!existsSync(candidateAbsolute) && existsSync(localEntrypoint) ? localEntrypoint : candidateAbsolute);
      continue;
    }
    if (typeof token === 'string' && token.startsWith('--')) {
      if (!MCP_OPTION_NAMES.includes(token)) {
        const nextToken = argumentsList[index + 1];
        if (nextToken !== undefined && !String(nextToken).startsWith('--')) index += 1;
        continue;
      }
      const value = argumentsList[index + 1];
      if (value === undefined || String(value).startsWith('--')) continue;
      if (token === '--backend') {
        sawBackend = true;
        updated.push('--backend', 'gpu');
      } else if (token === '--memory') {
        sawMemory = true;
        const numeric = Number(value);
        updated.push('--memory', String(Number.isFinite(numeric) && numeric >= 256 ? numeric : recommendedMiB));
      } else {
        updated.push(token, String(value));
      }
      index += 1;
      continue;
    }
    updated.push(token);
  }
  if (!sawBackend) updated.push('--backend', 'gpu');
  if (!sawMemory) updated.push('--memory', String(recommendedMiB));
  return updated;
}

async function backupAndWriteJson(filePath, updatedObject) {
  let backupPath = null;
  if (existsSync(filePath)) {
    const existingStats = await stat(filePath);
    if (existingStats.isFile()) {
      backupPath = `${filePath}.bak`;
      await copyFile(filePath, backupPath);
    }
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(updatedObject, null, 2)}\n`, 'utf8');
  return backupPath;
}

/** Apply safe non-destructive fixes: create missing directories and repair or write MCP configs with `.bak` backups. */
export async function applyDoctorFixes(report, {
  workingDirectory = process.cwd(),
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  nodeExecutable = process.execPath,
} = {}) {
  const actions = [];
  const recommendedMiB = report.recommendedMemoryMiB ?? 256;
  for (const check of report.checks) {
    const repair = check.repair;
    if (!repair) continue;
    if (repair.kind === 'mkdir') {
      for (const folderPath of repair.paths) {
        await mkdir(folderPath, { recursive: true });
        actions.push(`Created directory ${folderPath}`);
      }
    } else if (repair.kind === 'register-project-mcp') {
      const jobsFolder = join(workingDirectory, '.crucible', 'jobs');
      await mkdir(jobsFolder, { recursive: true });
      actions.push(`Created jobs directory ${jobsFolder}`);
      const existing = existsSync(repair.configPath) ? await readJsonSafely(repair.configPath) : {};
      const nextConfig = {
        ...existing,
        mcpServers: {
          ...(existing.mcpServers && typeof existing.mcpServers === 'object' ? existing.mcpServers : {}),
          'crucible-scene': {
            command: nodeExecutable,
            args: [
              join(packageRoot, 'bin', 'crucible-mcp.mjs'),
              '--backend',
              'gpu',
              '--memory',
              String(recommendedMiB),
              '--jobs',
              jobsFolder,
            ],
          },
        },
      };
      const backupPath = await backupAndWriteJson(repair.configPath, nextConfig);
      actions.push(`Registered crucible-scene in ${repair.configPath}${backupPath ? ` (backup: ${backupPath})` : ''}`);
    } else if (repair.kind === 'repair-mcp-entries') {
      const byConfig = new Map();
      for (const item of repair.entries) {
        if (!byConfig.has(item.configPath)) byConfig.set(item.configPath, []);
        byConfig.get(item.configPath).push(item);
      }
      for (const [configPath, items] of byConfig) {
        const existing = await readJsonSafely(configPath);
        const servers = { ...(existing.mcpServers ?? {}) };
        for (const item of items) {
          const currentEntry = servers[item.serverName] ?? {};
          servers[item.serverName] = {
            ...currentEntry,
            args: buildUpdatedArgs(Array.isArray(currentEntry.args) ? currentEntry.args : [], { recommendedMiB, packageRoot, workingDirectory }),
          };
        }
        const backupPath = await backupAndWriteJson(configPath, { ...existing, mcpServers: servers });
        actions.push(`Repaired Crucible MCP config in ${configPath}${backupPath ? ` (backup: ${backupPath})` : ''}`);
      }
    }
  }
  return actions;
}

/** Format human-readable CLI report for `crucible doctor`. */
export function formatDoctorReport(report, actions = []) {
  const tags = { ok: '[OK]  ', warn: '[WARN]', fail: '[FAIL]' };
  const lines = [`Crucible Doctor v${report.version} (${report.status.toUpperCase()})`];
  for (const check of report.checks) {
    lines.push(`${tags[check.status]} ${check.title}: ${check.detail}`);
    if (check.impact) lines.push(`       Impact: ${check.impact}`);
    if (check.fix) lines.push(`       Fix:    ${check.fix}`);
  }
  if (actions.length > 0) {
    lines.push('', 'Applied fixes:');
    for (const action of actions) lines.push(`- ${action}`);
  }
  if (report.nextSteps.length > 0) {
    lines.push('', 'Next steps:');
    for (const step of report.nextSteps) lines.push(`- ${step}`);
  }
  return lines.join('\n');
}

/** CLI runner for `crucible doctor`. */
export async function runDoctorCommand(argumentList, options = {}) {
  let parsed;
  try {
    parsed = parseDoctorArguments(argumentList);
  } catch (error) {
    console.error(`crucible doctor: ${error.message}\n${DOCTOR_USAGE}`);
    return 1;
  }
  if (parsed.help) {
    console.log(DOCTOR_USAGE);
    return 0;
  }
  const workingDirectory = parsed.cwd ? resolve(parsed.cwd) : options.workingDirectory ?? process.cwd();
  const checkOptions = { ...options, workingDirectory };
  let report = await runDoctorChecks(checkOptions);
  let appliedActions = [];
  if (parsed.fix) {
    appliedActions = await applyDoctorFixes(report, { workingDirectory, packageRoot: options.packageRoot, nodeExecutable: options.nodeExecutable });
    if (appliedActions.length > 0) {
      report = await runDoctorChecks(checkOptions);
    }
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ...report, appliedActions }, null, 2));
  } else {
    console.log(formatDoctorReport(report, appliedActions));
  }
  return report.status === 'fail' ? 1 : 0;
}
