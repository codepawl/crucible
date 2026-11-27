import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATES = Object.freeze({
  showcase: 'templates/showcase',
  addon: 'templates/addon-starter',
});

const INIT_FLAGS = Object.freeze(['--template', '--out', '--name']);
const INIT_SWITCHES = Object.freeze(['--force']);

export function initUsageText() {
  return 'Usage: crucible init [<dir>] [--template showcase|addon] [--out <dir>] [--name <pkg-name>] [--force]';
}

export function sanitizePackageName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || 'crucible-showcase';
}

export function parseInitArguments(argumentList) {
  const options = {
    template: 'showcase',
    outDir: null,
    packageName: null,
    force: false,
  };
  for (let index = 0; index < argumentList.length; index += 1) {
    const argument = argumentList[index];
    if (INIT_SWITCHES.includes(argument)) {
      options.force = true;
    } else if (INIT_FLAGS.includes(argument)) {
      const value = argumentList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError(`${argument}: pass a value, such as ${argument} <value>.`);
      }
      if (argument === '--template') options.template = value;
      if (argument === '--out') options.outDir = value;
      if (argument === '--name') options.packageName = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new TypeError(`${argument}: unknown option; crucible init takes --template, --out, --name, and --force.`);
    } else if (options.outDir === null) {
      options.outDir = argument;
    } else {
      throw new TypeError(`${argument}: pass at most one destination folder.`);
    }
  }
  if (!Object.hasOwn(TEMPLATES, options.template)) {
    throw new RangeError(`Unknown template "${options.template}". Choose showcase or addon.`);
  }
  options.outDir ??= options.template === 'addon' ? 'crucible-addon' : 'crucible-showcase';
  return options;
}

function listFilesRecursively(rootDir, currentDir = rootDir) {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  const collected = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) collected.push(...listFilesRecursively(rootDir, fullPath));
    else collected.push(relative(rootDir, fullPath).replaceAll('\\', '/'));
  }
  return collected.sort();
}

export function scaffoldTemplate({
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  template = 'showcase',
  outDir = 'crucible-showcase',
  packageName = null,
  force = false,
} = {}) {
  if (!Object.hasOwn(TEMPLATES, template)) {
    throw new RangeError(`Unknown template "${template}". Choose showcase or addon.`);
  }
  const sourceDir = resolve(packageRoot, TEMPLATES[template]);
  if (!existsSync(sourceDir)) {
    throw new Error(`Template directory not found at ${sourceDir}.`);
  }
  const resolvedOutDir = resolve(outDir);
  if (existsSync(resolvedOutDir) && readdirSync(resolvedOutDir).length > 0 && !force) {
    throw new Error(`${resolvedOutDir} already exists and is not empty. Pass --force to overwrite existing files.`);
  }
  mkdirSync(resolvedOutDir, { recursive: true });
  cpSync(sourceDir, resolvedOutDir, { recursive: true, force: true });

  const resolvedPackageName = sanitizePackageName(packageName ?? basename(resolvedOutDir));
  const cruciblePackage = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const targetPackagePath = join(resolvedOutDir, 'package.json');
  if (existsSync(targetPackagePath)) {
    const targetPackage = JSON.parse(readFileSync(targetPackagePath, 'utf8'));
    targetPackage.name = resolvedPackageName;
    if (targetPackage.dependencies?.['@codepawlhq/crucible']) {
      targetPackage.dependencies['@codepawlhq/crucible'] = `^${cruciblePackage.version}`;
    }
    if (targetPackage.devDependencies?.['@codepawlhq/crucible']) {
      targetPackage.devDependencies['@codepawlhq/crucible'] = `^${cruciblePackage.version}`;
    }
    writeFileSync(targetPackagePath, `${JSON.stringify(targetPackage, null, 2)}\n`);
  }

  return {
    template,
    outDir: resolvedOutDir,
    packageName: resolvedPackageName,
    files: listFilesRecursively(resolvedOutDir),
  };
}

export async function runInitCommand(argumentList, { packageRoot } = {}) {
  if (argumentList.includes('--help') || argumentList.includes('-h')) {
    console.log(initUsageText());
    return 0;
  }
  try {
    const options = parseInitArguments(argumentList);
    const result = scaffoldTemplate({
      packageRoot,
      template: options.template,
      outDir: options.outDir,
      packageName: options.packageName,
      force: options.force,
    });
    console.log(`Created Crucible ${result.template} project (${result.packageName}) in ${result.outDir}`);
    console.log('Next steps:');
    console.log(`  cd ${options.outDir}`);
    console.log('  npm install');
    console.log('  npm run dev');
    return 0;
  } catch (error) {
    console.error(`crucible init: ${error.message}\n${initUsageText()}`);
    return 1;
  }
}
