import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';

const numberWords = new Map([
  ['twenty-one', 21], ['twenty-two', 22], ['twenty-three', 23], ['twenty-four', 24],
  ['twenty-five', 25], ['twenty-six', 26], ['twenty-seven', 27], ['twenty-eight', 28],
  ['thirty', 30],
]);

async function listedToolCount() {
  const server = createAgentMcpServer({ async close() {} });
  const client = new Client({ name: 'crucible-tool-count-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.length;
}

async function countStatedIn(file, pattern) {
  const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace(/g/g, '')}g`))];
  assert.ok(matches.length > 0, `${file} no longer states the MCP tool count`);
  return matches.map((match) => {
    const stated = match[1].toLowerCase();
    return numberWords.get(stated) ?? Number(stated);
  });
}

test('documented MCP tool counts match the protocol listing', async () => {
  const listed = await listedToolCount();
  const statements = [
    ['docs/learn/models-and-ai-agents.md', /(\d+) tools for authoring/],
    ['docs/mcp.md', /Lists all (\d+) tools/],
    ['docs/learn/connect-mcp.md', /gives the agent (\d+) tools/],
    ['docs/learn/connect-mcp.md', /You must see (\d+) tools/],
    ['docs/learn/optimize-for-agents.md', /The (\d+) tools total/],
    ['site/index.html', /(\d+) MCP tools/],
  ];
  for (const [file, pattern] of statements) {
    for (const stated of await countStatedIn(file, pattern)) {
      assert.equal(stated, listed, `${file} states a different tool count than tools/list`);
    }
  }
});

test('smoke scripts take the tool list from the server, not a hard-coded count', async () => {
  const scriptsFolder = new URL('../scripts/', import.meta.url);
  const smokeFiles = (await readdir(scriptsFolder)).filter(name => /^smoke-.*\.(mjs|py)$/.test(name));
  assert.ok(smokeFiles.length > 10, 'expected the smoke scripts to be found');
  const hardCodedCount = /tools\.length,\s*\d+|EXPECTED_TOOL_COUNT\s*=\s*\d+/;
  for (const name of smokeFiles) {
    const text = await readFile(new URL(name, scriptsFolder), 'utf8');
    assert.doesNotMatch(text, hardCodedCount, `scripts/${name} hard-codes a tool count; use assertToolListMatchesServer from scripts/mcp-tool-list.mjs`);
  }
});
