import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { annotateViewHtml, clientSupportsMcpApps, ANNOTATE_VIEW_URI, MCP_APPS_MIME_TYPE, MAXIMUM_VIEW_BYTES } from '../scripts/annotate-app-view.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const NONCE = 'a'.repeat(32);
const APPS_CAPABILITIES = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APPS_MIME_TYPE] } } };

function createRuntime(record) {
  return {
    activeSessionId: () => 'scene-1',
    async close() {},
    async askUser(input) {
      record.asks.push(input);
      return input.inline
        ? { image: PNG, content: { sessionId: input.sessionId, outcome: 'pending', view: { width: 1, height: 1 }, maxMarks: 16 }, viewMeta: { nonce: NONCE } }
        : { image: PNG, content: { sessionId: input.sessionId, outcome: 'sent', marks: [] } };
    },
    async submitAskUser(input) {
      record.submits.push(input);
      return { image: input.image, content: { sessionId: 'scene-1', outcome: 'sent', marks: [{ number: 1, pixel: [input.marks[0].x, input.marks[0].y], note: input.marks[0].note, partId: 'lamp' }] } };
    },
  };
}

async function connect(context, capabilities) {
  const record = { asks: [], submits: [] };
  const server = createAgentMcpServer(createRuntime(record));
  const client = new Client({ name: 'apps-test', version: '1' }, capabilities ? { capabilities } : undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, record };
}

test('a host without MCP Apps gets the browser flow, the same tool list and no UI resource (#923)', async context => {
  const { client, record } = await connect(context);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 26);
  assert.equal(tools.find(tool => tool.name === 'scene_ask_user_submit'), undefined);
  assert.equal(tools.find(tool => tool.name === 'scene_ask_user')._meta, undefined);
  const result = await client.callTool({ name: 'scene_ask_user', arguments: {} });
  assert.equal(record.asks[0].inline, undefined);
  assert.equal(JSON.parse(result.content[1].text).outcome, 'sent');
  const listed = await client.listResources().catch(() => ({ resources: [] }));
  assert.deepEqual(listed.resources, []);
  await assert.rejects(client.readResource({ uri: ANNOTATE_VIEW_URI }));
  const submit = await client.callTool({ name: 'scene_ask_user_submit', arguments: { nonce: NONCE, marks: [{ x: 1, y: 1 }], image: PNG } }).catch(error => ({ isError: true, error }));
  assert.equal(submit.isError, true);
  assert.equal(record.submits.length, 0);
});

test('a host with MCP Apps gets the view resource, a UI link on the tool and a pending result (#923)', async context => {
  const { client, record } = await connect(context, APPS_CAPABILITIES);
  const { tools } = await client.listTools();
  assert.equal(tools.find(tool => tool.name === 'scene_ask_user')._meta.ui.resourceUri, ANNOTATE_VIEW_URI);
  assert.deepEqual(tools.find(tool => tool.name === 'scene_ask_user_submit')._meta.ui.visibility, ['app']);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map(resource => [resource.uri, resource.mimeType]), [[ANNOTATE_VIEW_URI, MCP_APPS_MIME_TYPE]]);
  const { contents } = await client.readResource({ uri: ANNOTATE_VIEW_URI });
  assert.equal(contents[0].mimeType, MCP_APPS_MIME_TYPE);
  assert.equal(contents[0].text, annotateViewHtml());
  const result = await client.callTool({ name: 'scene_ask_user', arguments: { prompt: 'Pin it' } });
  assert.equal(record.asks[0].inline, true);
  assert.equal(result.content[0].type, 'image');
  assert.equal(JSON.parse(result.content[1].text).outcome, 'pending');
  assert.equal(result._meta['crucible/annotate'].nonce, NONCE);
  assert.ok(!JSON.stringify(result.content).includes(NONCE), 'the model-visible content never carries the nonce');
});

test('the view is self-contained, bounded and speaks the MCP Apps handshake (#923)', () => {
  const html = annotateViewHtml();
  assert.ok(Buffer.byteLength(html) <= MAXIMUM_VIEW_BYTES);
  assert.doesNotMatch(html, /https?:\/\/|\/\/[a-z]+\.|<link|@import|[^a-zA-Z]url\(|\ssrc="(?!data:)/i, 'no remote reference');
  assert.equal(html.match(/<script/g).length, 1, 'one inline script, no external one');
  for (const protocolPart of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/tool-result', 'ui/message', 'scene_ask_user_submit']) {
    assert.ok(html.includes(protocolPart), protocolPart);
  }
  assert.ok(html.includes('event.source !== window.parent'));
  assert.doesNotMatch(html, /\beval\(|new Function|document\.write/);
});

test('only a client that lists the HTML app mime type counts as supporting MCP Apps', () => {
  assert.equal(clientSupportsMcpApps(undefined), false);
  assert.equal(clientSupportsMcpApps({}), false);
  assert.equal(clientSupportsMcpApps({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html'] } } }), false);
  assert.equal(clientSupportsMcpApps({ extensions: { 'io.modelcontextprotocol/ui': {} } }), false);
  assert.equal(clientSupportsMcpApps(APPS_CAPABILITIES), true);
});

test('the submit tool bounds what a view can send and passes the marks to the runtime (#923)', async context => {
  const { client, record } = await connect(context, APPS_CAPABILITIES);
  const sent = await client.callTool({ name: 'scene_ask_user_submit', arguments: { nonce: NONCE, marks: [{ x: 3, y: 4, note: 'dull' }], image: PNG } });
  assert.equal(sent.content[0].type, 'image');
  const answer = JSON.parse(sent.content[1].text);
  assert.equal(answer.outcome, 'sent');
  assert.equal(answer.marks[0].partId, 'lamp');
  assert.equal(record.submits.length, 1);
  const forged = await client.callTool({ name: 'scene_ask_user_submit', arguments: { marks: [{ x: 1, y: 1 }], image: PNG } }).catch(error => ({ isError: true, error }));
  assert.equal(forged.isError, true, 'a submit built only from model-visible data has no nonce');
  const manyMarks = Array.from({ length: 17 }, () => ({ x: 1, y: 1 }));
  for (const argumentsValue of [
    { nonce: 'short', marks: [{ x: 1, y: 1 }], image: PNG },
    { nonce: NONCE, marks: [], image: PNG },
    { nonce: NONCE, marks: manyMarks, image: PNG },
    { nonce: NONCE, marks: [{ x: 1, y: 1, note: 'x'.repeat(281) }], image: PNG },
    { nonce: NONCE, marks: [{ x: 1, y: 1 }], image: 'A'.repeat(1500001) },
    { nonce: NONCE, marks: [{ x: 1, y: 1, code: 'alert(1)' }], image: PNG },
  ]) {
    const rejected = await client.callTool({ name: 'scene_ask_user_submit', arguments: argumentsValue }).catch(error => ({ isError: true, error }));
    assert.equal(rejected.isError, true, JSON.stringify(argumentsValue).slice(0, 80));
  }
  assert.equal(record.submits.length, 1);
});

test('the inline view includes all four mark tools and scene_ask_user_submit accepts color and view marks (#922)', async context => {
  const html = annotateViewHtml();
  for (const id of ['tool-pin', 'tool-lasso', 'tool-color', 'tool-view', 'color-picker', 'capture-view']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  const { client, record } = await connect(context, APPS_CAPABILITIES);
  const sent = await client.callTool({
    name: 'scene_ask_user_submit',
    arguments: {
      nonce: NONCE,
      marks: [
        { kind: 'color', x: 10, y: 20, hex: '#ff5a4f', note: 'paint warm' },
        { kind: 'view', camera: { eye: [2, 3, 4], target: [0, 0, 0], fov: 45 }, note: 'hero angle' },
      ],
      image: PNG,
    },
  });
  assert.equal(sent.isError, undefined);
  assert.equal(record.submits.length, 1);
  assert.equal(record.submits[0].marks[0].kind, 'color');
  assert.equal(record.submits[0].marks[1].kind, 'view');
  for (const badMark of [
    { kind: 'color', x: 10, y: 20, hex: 'red' },
    { kind: 'view', camera: { eye: [1, 2, 3], target: [0, 0, 0], fov: 121 } },
    { kind: 'transform', x: 10, y: 20, deltaPosition: [1001, 0, 0] },
    { kind: 'pin', x: 10, y: 20, time: 3601 },
  ]) {
    const rejected = await client.callTool({ name: 'scene_ask_user_submit', arguments: { nonce: NONCE, marks: [badMark], image: PNG } }).catch(error => ({ isError: true, error }));
    assert.equal(rejected.isError, true);
  }
});

test('the inline view includes transform and motion timeline controls and scene_ask_user_submit accepts transform and time (#922)', async context => {
  const html = annotateViewHtml();
  for (const id of ['tool-transform', 'transform-options', 'tf-dx', 'tf-ry', 'tf-s', 'motion-options', 'motion-scrub', 'motion-time']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  const { client, record } = await connect(context, APPS_CAPABILITIES);
  const sent = await client.callTool({
    name: 'scene_ask_user_submit',
    arguments: {
      nonce: NONCE,
      marks: [
        { kind: 'transform', x: 12, y: 24, deltaPosition: [0.5, 0, 0], deltaRotation: [0, 30, 0], scaleFactor: [1, 1.2, 1], note: 'lift and turn', time: 1.25 },
        { kind: 'lasso', points: [[1, 1], [10, 1], [10, 10]], note: 'these', time: 2.5 },
      ],
      image: PNG,
    },
  });
  assert.equal(sent.isError, undefined);
  assert.equal(record.submits.length, 1);
  assert.equal(record.submits[0].marks[0].kind, 'transform');
  assert.equal(record.submits[0].marks[0].time, 1.25);
  assert.equal(record.submits[0].marks[1].time, 2.5);
});
