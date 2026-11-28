import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDoctorFixes,
  formatDoctorReport,
  parseDoctorArguments,
  recommendedMemoryMiB,
  runDoctorChecks,
  runDoctorCommand,
} from '../bin/crucible-doctor.mjs';

async function makeTempWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'crucible-doctor-'));
  const homeDirectory = join(root, 'home');
  const workingDirectory = join(root, 'project');
  const packageRoot = join(root, 'pkg');
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await writeFile(join(packageRoot, 'bin', 'crucible-mcp.mjs'), '// stub\n');
  try {
    await run({ root, homeDirectory, workingDirectory, packageRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parseDoctorArguments parses --fix, --json, --cwd, and rejects unknown options', () => {
  assert.deepEqual(parseDoctorArguments([]), { fix: false, json: false, help: false, cwd: undefined });
  assert.deepEqual(parseDoctorArguments(['--fix', '--json', '--cwd', '/tmp/proj']), {
    fix: true, json: false === true ? false : true, help: false, cwd: '/tmp/proj',
  });
  assert.throws(() => parseDoctorArguments(['--bogus']), /unknown option/);
  assert.throws(() => parseDoctorArguments(['--cwd']), /pass a directory path/);
});

test('runDoctorChecks detects missing MCP registration, software WebGL, missing packages, and drifted skills', async () => {
  await makeTempWorkspace(async ({ homeDirectory, workingDirectory, packageRoot }) => {
    await mkdir(join(packageRoot, 'skills', 'build-crucible-scene'), { recursive: true });
    await mkdir(join(packageRoot, 'skills', 'render-crucible-media'), { recursive: true });
    await writeFile(join(packageRoot, 'skills', 'build-crucible-scene', 'SKILL.md'), 'version-new\n');
    await writeFile(join(packageRoot, 'skills', 'render-crucible-media', 'SKILL.md'), 'version-new\n');

    await mkdir(join(homeDirectory, '.claude', 'skills', 'build-crucible-scene'), { recursive: true });
    await mkdir(join(homeDirectory, '.claude', 'skills', 'render-crucible-media'), { recursive: true });
    await writeFile(join(homeDirectory, '.claude', 'skills', 'build-crucible-scene', 'SKILL.md'), 'version-old\n');
    await writeFile(join(homeDirectory, '.claude', 'skills', 'render-crucible-media', 'SKILL.md'), 'version-new\n');

    const report = await runDoctorChecks({
      homeDirectory,
      workingDirectory,
      packageRoot,
      nodeVersion: 'v22.12.0',
      totalMemoryBytes: 32 * 1024 ** 3,
      findBrowser: () => '/usr/bin/google-chrome',
      probeBrowserWebGl: () => ({ ok: true, softwareWebGl: true, graphics: 'SwiftShader' }),
      resolvePackage: name => ({ installed: name === 'playwright-core', resolvedPath: null, hasNativeBinary: false }),
      environment: {},
    });

    assert.equal(report.status, 'warn');
    assert.equal(report.recommendedMemoryMiB, recommendedMemoryMiB(32 * 1024 ** 3));
    const byId = Object.fromEntries(report.checks.map(check => [check.id, check]));
    assert.equal(byId.node.status, 'ok');
    assert.equal(byId.browser.status, 'warn');
    assert.equal(byId['mcp-clients'].status, 'warn');
    assert.equal(byId['optional-packages'].status, 'warn');
    assert.match(byId['optional-packages'].fix, /draco3d/);
    assert.equal(byId.skills.status, 'warn');
    assert.match(formatDoctorReport(report), /Crucible Doctor/);
  });
});

test('runDoctorChecks + applyDoctorFixes repairs MCP JSON with .bak backup while preserving unrelated keys', async () => {
  await makeTempWorkspace(async ({ root, homeDirectory, workingDirectory, packageRoot }) => {
    const assetsFolder = join(root, 'missing-assets');
    const claudeConfigPath = join(homeDirectory, '.claude.json');
    const originalConfig = {
      theme: 'dark',
      mcpServers: {
        otherTool: { command: 'node', args: ['other.mjs'] },
        'crucible-scene': {
          command: 'node',
          args: [join(packageRoot, 'bin', 'crucible-mcp.mjs'), '--backend', 'cpu', '--memory', '128', '--old-flag', '1', '--assets', assetsFolder],
        },
      },
    };
    await writeFile(claudeConfigPath, JSON.stringify(originalConfig, null, 2));

    const firstReport = await runDoctorChecks({
      homeDirectory,
      workingDirectory,
      packageRoot,
      nodeVersion: 'v22.12.0',
      totalMemoryBytes: 16 * 1024 ** 3,
      findBrowser: () => 'C:\\chrome.exe',
      probeBrowserWebGl: () => ({ ok: true, detail: 'Chrome 131' }),
      resolvePackage: () => ({ installed: true, resolvedPath: 'ok', hasNativeBinary: true }),
      environment: {},
    });
    assert.equal(firstReport.status, 'fail');
    const actions = await applyDoctorFixes(firstReport, { workingDirectory, packageRoot });
    assert.ok(actions.some(item => item.includes(assetsFolder)));
    assert.ok(existsSync(assetsFolder));
    assert.ok(existsSync(`${claudeConfigPath}.bak`));

    const repaired = JSON.parse(await readFile(claudeConfigPath, 'utf8'));
    assert.equal(repaired.theme, 'dark');
    assert.deepEqual(repaired.mcpServers.otherTool, originalConfig.mcpServers.otherTool);
    const fixedArgs = repaired.mcpServers['crucible-scene'].args;
    assert.equal(fixedArgs[fixedArgs.indexOf('--backend') + 1], 'gpu');
    assert.equal(fixedArgs[fixedArgs.indexOf('--memory') + 1], '1024');
    assert.equal(fixedArgs.includes('--old-flag'), false);
    assert.equal(fixedArgs[fixedArgs.indexOf('--assets') + 1], assetsFolder);
  });
});

test('crucible doctor --fix creates project .mcp.json cleanly when no client config exists', async () => {
  await makeTempWorkspace(async ({ homeDirectory, workingDirectory, packageRoot }) => {
    const exitCode = await runDoctorCommand(['--fix', '--json', '--cwd', workingDirectory], {
      homeDirectory,
      workingDirectory,
      packageRoot,
      nodeVersion: 'v22.12.0',
      totalMemoryBytes: 16 * 1024 ** 3,
      findBrowser: () => '/usr/bin/chrome',
      probeBrowserWebGl: () => ({ ok: true, detail: 'Chrome' }),
      resolvePackage: () => ({ installed: true, resolvedPath: 'ok', hasNativeBinary: true }),
      environment: {},
    });
    assert.equal(exitCode, 0);
    const projectMcp = JSON.parse(await readFile(join(workingDirectory, '.mcp.json'), 'utf8'));
    assert.ok(projectMcp.mcpServers['crucible-scene']);
    assert.ok(projectMcp.mcpServers['crucible-scene'].args.includes('--backend'));
    assert.ok(projectMcp.mcpServers['crucible-scene'].args.includes('--jobs'));
    assert.ok(existsSync(join(workingDirectory, '.crucible', 'jobs')));
  });
});
