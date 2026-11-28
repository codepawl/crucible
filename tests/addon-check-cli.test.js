import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkAddon, entryOf, parseArguments, rangeIsSatisfiable } from '../bin/crucible-addon-check.mjs';
import { MCP_OPTION_FLAGS, MCP_OPTION_NAMES, mcpHelpText, mcpOptionSummary } from '../bin/crucible-mcp-flags.mjs';
import { MEMORY_CEILING_MIB } from '../src/agent-scene-capabilities.js';
import { resolveAddons } from '../scripts/mcp-addons.mjs';

const checkScript = resolve('bin/crucible-addon-check.mjs');
const mcpScript = resolve('bin/crucible-mcp.mjs');
const DEFAULT_ENTRY = 'export function registerAddon() {}\n';

function validPackage(overrides = {}) {
  return {
    name: 'fixture-addon',
    version: '1.0.0',
    license: 'MIT',
    keywords: ['crucible-addon'],
    exports: { '.': './index.mjs' },
    peerDependencies: { '@codepawlhq/crucible': '>=0.19.0 <1.0.0' },
    crucible: { range: '>=0.19.0 <1.0.0', extensionPoints: ['registerController'], bundleBytes: 1000 },
    ...overrides,
  };
}

// Builds <root>/node_modules/fixture-addon, runs the callback with (folder, root) and removes root afterwards.
function withAddon(pack, entryText, run) {
  const root = mkdtempSync(join(tmpdir(), 'crucible-addon-check-'));
  const folder = join(root, 'node_modules', 'fixture-addon');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'package.json'), JSON.stringify(pack));
  if (entryText !== null) writeFileSync(join(folder, 'index.mjs'), entryText);
  try {
    return run(folder, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCheck(...argumentsList) {
  return spawnSync(process.execPath, [checkScript, ...argumentsList], { encoding: 'utf8' });
}

test('a missing entry named by an object exports is an error and the loader skips it', () => {
  const pack = validPackage({ exports: { '.': './missing.mjs' } });
  withAddon(pack, null, (folder, root) => {
    assert.match(checkAddon(folder).errors.join('\n'), /entry file \.\/missing\.mjs does not exist/);
    assert.equal(runCheck(folder, '--version', '0.20.0').status, 1);
    assert.equal(resolveAddons({ folder: root, names: ['fixture-addon'], version: '0.20.0' }).addons.length, 0);
  });
});

test('an entry above bundleBytes in an object exports fails the check and the loader', () => {
  const pack = validPackage({ crucible: { range: '>=0.19.0 <1.0.0', extensionPoints: ['registerController'], bundleBytes: 10 } });
  withAddon(pack, `// ${'x'.repeat(50000)}\n`, (folder, root) => {
    assert.match(checkAddon(folder).errors.join('\n'), /bundleBytes/);
    assert.equal(runCheck(folder).status, 1);
    const { addons, skipped } = resolveAddons({ folder: root, names: ['fixture-addon'], version: '0.20.0' });
    assert.equal(addons.length, 0);
    assert.match(skipped[0].reason, /bundleBytes/);
  });
});

test('entry resolution reads exports conditions, a string exports and main like the loader', () => {
  assert.equal(entryOf({ exports: { '.': { import: './a.mjs' } } }), './a.mjs');
  assert.equal(entryOf({ exports: { '.': { default: './b.mjs' } } }), './b.mjs');
  assert.equal(entryOf({ exports: { import: './c.mjs' } }), './c.mjs');
  assert.equal(entryOf({ exports: './d.mjs', main: './x.mjs' }), './d.mjs');
  assert.equal(entryOf({ main: './e.mjs' }), './e.mjs');
  assert.equal(entryOf({}), null);
});

test('a package that names no entry fails the check', () => {
  const pack = validPackage();
  delete pack.exports;
  withAddon(pack, null, folder => {
    assert.match(checkAddon(folder).errors.join('\n'), /names no entry file/);
  });
});

test('the peer range is tested against --version', () => {
  const pack = validPackage({ peerDependencies: { '@codepawlhq/crucible': '<0.1.0' } });
  withAddon(pack, DEFAULT_ENTRY, folder => {
    assert.match(checkAddon(folder, { version: '0.20.0' }).errors.join('\n'), /peerDependencies\.@codepawlhq\/crucible <0\.1\.0 does not allow Crucible 0\.20\.0/);
    assert.equal(checkAddon(folder).errors.length, 0);
  });
});

test('unsatisfiable ranges are rejected for the manifest and the peer dependency', () => {
  assert.equal(rangeIsSatisfiable('>=1.0.0 <0.5.0'), false);
  assert.equal(rangeIsSatisfiable('>0.1.0 <0.1.1'), false);
  assert.equal(rangeIsSatisfiable('>=0.19.0 <1.0.0'), true);
  assert.equal(rangeIsSatisfiable('>0.1.5 <0.2.0'), true);
  assert.equal(rangeIsSatisfiable('^0.19.0'), true);
  const pack = validPackage({
    peerDependencies: { '@codepawlhq/crucible': '>=1.0.0 <0.5.0' },
    crucible: { range: '>=1.0.0 <0.5.0', extensionPoints: ['registerController'], bundleBytes: 1000 },
  });
  withAddon(pack, DEFAULT_ENTRY, folder => {
    const text = checkAddon(folder).errors.join('\n');
    assert.match(text, /"crucible"\.range >=1\.0\.0 <0\.5\.0 matches no version/);
    assert.match(text, /peerDependencies\.@codepawlhq\/crucible >=1\.0\.0 <0\.5\.0 matches no version/);
  });
});

test('--version works as --version X and --version=X, and a trailing bare --version exits 2', () => {
  const pack = validPackage({
    crucible: { range: '>=0.19.0 <0.20.0', extensionPoints: ['registerController'], bundleBytes: 1000 },
  });
  withAddon(pack, DEFAULT_ENTRY, folder => {
    assert.equal(runCheck(folder, '--version', '0.20.0').status, 1);
    assert.equal(runCheck(folder, '--version=0.20.0').status, 1);
    assert.equal(runCheck('--version=0.19.5', folder).status, 0);
    const trailing = runCheck(folder, '--version');
    assert.equal(trailing.status, 2);
    assert.match(trailing.stderr, /--version needs a Crucible version/);
    assert.equal(runCheck(folder, '--version', '--help').status, 0);
  });
});

test('unknown flags, extra arguments and bad version values exit 2', () => {
  withAddon(validPackage(), DEFAULT_ENTRY, folder => {
    const unknown = runCheck(folder, '--bogus');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown flag --bogus/);
    assert.equal(runCheck(folder, folder).status, 2);
    assert.equal(runCheck(folder, '--version=latest').status, 2);
    assert.equal(runCheck().status, 2);
  });
});

test('--help exits 0 and prints the usage', () => {
  const result = runCheck('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: npx crucible-addon-check/);
  assert.deepEqual(parseArguments(['-h']), { help: true });
});

const EXPECTED_MCP_FLAGS = [
  '--addons', '--allow-addon', '--backend', '--browser', '--memory', '--assets', '--max-asset-bytes', '--packs',
  '--jobs', '--gpu-queue', '--gpu-queue-wait', '--ffmpeg', '--audio', '--branches', '--relations', '--findings', '--schema-compat', '--tools',
];

test('the flag table names exactly the 18 flags crucible-mcp accepts', () => {
  assert.deepEqual([...MCP_OPTION_NAMES], EXPECTED_MCP_FLAGS);
});

test('the help text and the parse error summary name every flag', () => {
  const helpText = mcpHelpText('0.0.0');
  const summary = mcpOptionSummary();
  for (const name of EXPECTED_MCP_FLAGS) {
    assert.ok(helpText.includes(name), name + ' missing from help text');
    assert.ok(summary.includes(name), name + ' missing from the error summary');
  }
});

test('the --memory range in the flag table follows MEMORY_CEILING_MIB', () => {
  const memoryFlag = MCP_OPTION_FLAGS.find(flag => flag.name === '--memory');
  assert.ok(memoryFlag.value.includes('..' + MEMORY_CEILING_MIB + ' '), memoryFlag.value);
});

test('crucible-mcp --help lists every accepted flag and combines with other flags', () => {
  for (const argumentsList of [['--help'], ['--help', '--backend', 'cpu'], ['--version', '--help']]) {
    const result = spawnSync(process.execPath, [mcpScript, ...argumentsList], { encoding: 'utf8' });
    assert.equal(result.status, 0, argumentsList.join(' '));
    for (const name of EXPECTED_MCP_FLAGS) assert.ok(result.stdout.includes(name), name + ' missing from help');
  }
});

test('runMcpCli rejects an unknown flag with an error that names the flags and --help', async () => {
  const { runMcpCli } = await import('../scripts/mcp-server.mjs');
  await assert.rejects(runMcpCli({ argumentsValue: ['--bogus', 'x'] }), error => {
    for (const name of EXPECTED_MCP_FLAGS) assert.ok(error.message.includes(name), name);
    assert.match(error.message, /crucible-mcp --help/);
    return true;
  });
});
