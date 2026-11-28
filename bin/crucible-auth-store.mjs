// Atomic local session storage for `crucible auth` and `crucible agent`.
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function resolveConfigDirectory({ environment = process.env, platform = process.platform, homeDirectory = homedir() } = {}) {
  const override = typeof environment.CRUCIBLE_CONFIG_DIR === 'string' ? environment.CRUCIBLE_CONFIG_DIR.trim() : '';
  if (override) {
    return resolve(override);
  }
  if (platform === 'win32') {
    const appData = typeof environment.APPDATA === 'string' && environment.APPDATA.trim()
      ? environment.APPDATA.trim()
      : join(homeDirectory, 'AppData', 'Roaming');
    return join(appData, 'crucible');
  }
  const xdgConfigHome = typeof environment.XDG_CONFIG_HOME === 'string' && environment.XDG_CONFIG_HOME.trim()
    ? environment.XDG_CONFIG_HOME.trim()
    : join(homeDirectory, '.config');
  return join(xdgConfigHome, 'crucible');
}

export function resolveAuthStorePath(options = {}) {
  if (typeof options.storePath === 'string' && options.storePath.trim()) {
    return resolve(options.storePath.trim());
  }
  return join(resolveConfigDirectory(options), 'auth.json');
}

export async function readAuthSession(options = {}) {
  const storePath = resolveAuthStorePath(options);
  let rawText;
  try {
    rawText = await readFile(storePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Auth session file ${storePath} is not valid JSON. Run "crucible auth logout" and sign in again.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Auth session file ${storePath} is invalid. Run "crucible auth logout" and sign in again.`);
  }
  return parsed;
}

export async function writeAuthSession(session, options = {}) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    throw new TypeError('Auth session must be a plain object.');
  }
  const storePath = resolveAuthStorePath(options);
  const directory = dirname(storePath);
  const platform = options.platform ?? process.platform;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    await chmod(directory, 0o700).catch(() => {});
  }
  const temporaryPath = join(directory, `.auth-${process.pid}-${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(session, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    if (platform !== 'win32') {
      await chmod(temporaryPath, 0o600);
    }
    await rename(temporaryPath, storePath);
    if (platform !== 'win32') {
      await chmod(storePath, 0o600);
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return storePath;
}

export async function clearAuthSession(options = {}) {
  const storePath = resolveAuthStorePath(options);
  await rm(storePath, { force: true });
  return storePath;
}
