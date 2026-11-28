import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Addon packages that ship separately on npm beside the core package. Keep empty while three-bridge and denoise-oidn
// ship as built-in @codepawlhq/crucible/addons/* entries.
export const PUBLISHED_ADDONS = Object.freeze([]);

/** The addons whose package.json version the registry does not serve yet, as { folder, name, version }. */
export async function addonsToPublish(folders, { fetchImplementation = globalThis.fetch, readText = path => readFile(path, 'utf8') } = {}) {
  const pending = [];
  for (const folder of folders) {
    const { name, version } = JSON.parse(await readText(`${folder}/package.json`));
    const response = await fetchImplementation(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(30000) });
    if (response.ok) continue;
    if (response.status !== 404) throw new Error(`Registry check for ${name}@${version} failed: HTTP ${response.status}.`);
    pending.push({ folder, name, version });
  }
  return pending;
}

async function main() {
  if (!process.env.GITHUB_ACTIONS || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error('Run this release through the GitHub Actions trusted publisher.');
  if (!process.env.npm_execpath) throw new Error('Run this script through npm run publish:addons:ci.');
  const failures = [];
  for (const addon of await addonsToPublish(PUBLISHED_ADDONS)) {
    console.log(`Publishing ${addon.name}@${addon.version} from ${addon.folder}.`);
    const result = spawnSync(process.execPath, [process.env.npm_execpath, 'publish', '--access', 'public'], { cwd: addon.folder, windowsHide: true, stdio: 'inherit' });
    if (result.status !== 0) failures.push(addon);
  }
  for (const addon of failures) {
    // An annotation, so a missing trusted publisher on a new addon shows on the run page without blocking the core release.
    console.log(`::warning::${addon.name}@${addon.version} was not published. A new package needs one manual first publish and a trusted publisher (codepawl/crucible, publish.yml) in its npm settings.`);
  }
  if (failures.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
