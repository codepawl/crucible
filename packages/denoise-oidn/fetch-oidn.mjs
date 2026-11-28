import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOidn as fetchOidnInto } from '../../bin/crucible-oidn-fetch.mjs';

const PACKAGE_VENDOR = join(dirname(fileURLToPath(import.meta.url)), 'vendor');

export async function fetchOidn() {
  return fetchOidnInto({ vendorDirectory: PACKAGE_VENDOR });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`Open Image Denoise is in ${await fetchOidn()}`);
}
