import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

// Issue 1929: Haiku asked for meshEdit, then for meshEdit.<op> once per op. The first answer now carries each op's arguments.

// The first answer of a union topic stays about this small, so it does not become the cost it was meant to save.
const MAX_UNION_ANSWER_BYTES = { meshEdit: 8000, meshStack: 3500 };

async function connectClient(context) {
  const runtime = {
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async close() {},
    activeSessionId() { return null; },
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'capabilities-op-arguments-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function ask(client, topic) {
  const result = await client.callTool({ name: 'scene_capabilities', arguments: { topic } });
  assert.notEqual(result.isError, true);
  return result.structuredContent;
}

function argumentNames(line) {
  return line.split(', ').filter(Boolean).map(entry => entry.split(':')[0].replace(/\?$/, ''));
}

function detailFieldNames(detail) {
  return Object.keys(detail.fields).filter(key => key !== '_' && key !== 'op' && key !== '$defs').map(key => key.replace(/\?$/, ''));
}

for (const topic of ['meshEdit', 'meshStack']) {
  test(`${topic} names every op's arguments, the same ones its dotted lookup lists`, async context => {
    const client = await connectClient(context);
    const answer = await ask(client, topic);
    const operations = Object.entries(answer.fields.branches);
    assert.ok(operations.length > 10);
    for (const [operation, summary] of operations) {
      assert.equal(typeof summary.args, 'string', `${topic}.${operation} has an args line`);
      const detail = await ask(client, `${topic}.${operation}`);
      assert.deepEqual(argumentNames(summary.args), detailFieldNames(detail), `${topic}.${operation}`);
    }
  });

  test(`${topic} answers within ${MAX_UNION_ANSWER_BYTES[topic]} bytes`, async context => {
    const client = await connectClient(context);
    const answer = await ask(client, topic);
    assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= MAX_UNION_ANSWER_BYTES[topic]);
  });
}

test('an args line marks optional arguments and gives types and ranges, with no prose', async context => {
  const client = await connectClient(context);
  const { fields } = await ask(client, 'meshEdit');
  assert.equal(fields.branches.bevel.args, 'name?:string, edges?:edgeRule, width:number, segments?:int[1..16], profile?:number[0..1], clampOverlap?:boolean');
  assert.equal(fields.branches.delete.args, 'select:faceRule');
  assert.match(fields.branches.translate.args, /offset:Vector3/);
});

test('each rule type is spelled out once beside the ops that take it', async context => {
  const client = await connectClient(context);
  const { fields } = await ask(client, 'meshEdit');
  assert.deepEqual(Object.keys(fields.rules).sort(), ['edgeRule', 'faceRule', 'vertexRule']);
  assert.match(fields.rules.faceRule, /^Face rule: /);
});

test('a dotted lookup still gives the full detail of one op', async context => {
  const client = await connectClient(context);
  const detail = await ask(client, 'meshEdit.bevel');
  assert.equal(detail.topic, 'meshEdit.bevel');
  assert.match(detail.fields['width'], /Distance from the edge/);
  const stackDetail = await ask(client, 'meshStack.uv_unwrap');
  assert.match(stackDetail.fields['seams?']._, /Edge rule for seams/);
});
