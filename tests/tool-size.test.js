import test from 'node:test';
import assert from 'node:assert/strict';
import { measureToolSizes, formatToolSizes } from '../scripts/tool-size.mjs';
import { measureToolCost } from '../scripts/measure-tool-cost.mjs';

test('tool sizes: the total and every row equal what npm run tool-cost measures', async () => {
  const sizes = await measureToolSizes();
  const cost = await measureToolCost();
  assert.equal(sizes.totalBytes, cost.schemaTotal.bytes);
  assert.equal(sizes.estimatedTokens, cost.schemaTotal.tokens);
  assert.deepEqual(sizes.rows.map(row => [row.name, row.bytes]), cost.schemas.map(row => [row.name, row.bytes]));
});

test('tool sizes: rows are largest first and add up to the total within the commas between entries', async () => {
  const sizes = await measureToolSizes();
  assert.ok(sizes.rows.length > 20, 'expected every MCP tool to be listed');
  for (let index = 1; index < sizes.rows.length; index += 1) {
    assert.ok(sizes.rows[index - 1].bytes >= sizes.rows[index].bytes, `${sizes.rows[index].name} is out of order`);
  }
  const rowSum = sizes.rows.reduce((sum, row) => sum + row.bytes, 0);
  assert.ok(sizes.totalBytes >= rowSum && sizes.totalBytes - rowSum <= sizes.rows.length + 1, `total ${sizes.totalBytes} vs rows ${rowSum}`);
});

test('tool sizes: the printed table has one line per tool and a total line', async () => {
  const sizes = await measureToolSizes();
  const lines = formatToolSizes(sizes).split('\n');
  assert.equal(lines.length, sizes.rows.length + 1);
  assert.ok(lines.at(-1).startsWith('total') && lines.at(-1).includes(`${sizes.totalBytes.toLocaleString('en-US')} B`) && lines.at(-1).endsWith(`(${sizes.rows.length} tools)`), lines.at(-1));
  assert.ok(lines[0].startsWith(sizes.rows[0].name), lines[0]);
});
