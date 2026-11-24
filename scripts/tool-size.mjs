import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { measureToolCost } from './measure-tool-cost.mjs';

// One row per MCP tool, largest first, measured the way `npm run tool-cost` measures it: the JSON of
// { name, description, inputSchema }, which is what a harness sends to the model. The total is that tool-cost total
// (the whole list serialized once), so it is a few bytes above the sum of the rows (the commas between entries).
export async function measureToolSizes() {
  const { schemas, schemaTotal } = await measureToolCost();
  const rows = schemas.map(({ name, bytes, tokens }) => ({ name, bytes, tokens }));
  return { rows, totalBytes: schemaTotal.bytes, estimatedTokens: schemaTotal.tokens };
}

export function formatToolSizes({ rows, totalBytes, estimatedTokens }) {
  const nameWidth = Math.max(...rows.map(row => row.name.length));
  const lines = rows.map(row => `${row.name.padEnd(nameWidth)}  ${row.bytes.toLocaleString('en-US').padStart(7)} B  ${row.tokens.toLocaleString('en-US').padStart(6)} tokens`);
  lines.push(`${'total'.padEnd(nameWidth)}  ${totalBytes.toLocaleString('en-US').padStart(7)} B  ${estimatedTokens.toLocaleString('en-US').padStart(6)} tokens (${rows.length} tools)`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(formatToolSizes(await measureToolSizes()));
  process.exit(0);
}
