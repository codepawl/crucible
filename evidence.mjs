// Evidence for #3094: the same leaf-shaped alpha card as alphaMode mask and as blend, through MCP, one still and its recipe JSON.
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const worktree = process.argv[2];
const out = resolve(process.argv[3]);
await mkdir(`${out}/assets`, { recursive: true });
function crc(buffer) { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } let r = 0xffffffff; for (const b of buffer) r = table[(r ^ b) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); }
function leafPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1;
    const inside = Math.abs(u) + Math.abs(v) * 0.5 < 0.9 - 0.4 * v * v;
    const soft = Math.max(0, Math.min(1, (0.9 - 0.4 * v * v - Math.abs(u) - Math.abs(v) * 0.5) * 3));
    const vein = Math.abs(u) < 0.03;
    const o = y * (size * 4 + 1) + 1 + x * 4;
    raw[o - (x === 0 ? 1 : 0) * 0] = raw[o];
    raw[o] = vein ? 200 : 40; raw[o + 1] = vein ? 230 : 150; raw[o + 2] = 40; raw[o + 3] = inside ? Math.round(255 * soft) : 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
await writeFile(`${out}/assets/leaf.png`, leafPng(128));
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(worktree, 'scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', `${out}/assets`], stderr: 'pipe', cwd: worktree });
const client = new Client({ name: 'evidence-3094', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' }, probe: { timeoutMs: 180000 } } });
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }, { timeout: 180000 }); if (r.isError) throw new Error(JSON.stringify(r.content)); return r; };
await client.connect(transport, { timeout: 180000 });
const catalog = await call('scene_asset_catalog');
const text = catalog.content.find(i => i.type === 'text').text;
const leafId = text.match(/[0-9a-f]{64}/)?.[0];
console.log('leaf id', leafId);
const card = (id, x, mode) => ({ id, geometry: 'card', material: mode, translation: [x, 1, 0], scale: [1.6, 1.6, 1] });
const recipe = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'card', type: 'plane' }, { id: 'ground', type: 'plane' }, { id: 'stripe', type: 'box', bevel: 0 }],
  materials: [
    { id: 'ground', color: [0.55, 0.55, 0.5] },
    { id: 'stripe', color: [0.9, 0.2, 0.2] },
    { id: 'mask', colorMap: leafId, alphaMode: 'mask', alphaCutoff: 0.5, doubleSided: true },
    { id: 'blend', colorMap: leafId, alphaMode: 'blend', doubleSided: true },
  ],
  nodes: [
    { id: 'ground', geometry: 'ground', material: 'ground', rotation: [-0.7071068, 0, 0, 0.7071068], scale: [8, 4, 1] },
    { id: 'stripe', geometry: 'stripe', material: 'stripe', translation: [0, 1, -0.2], scale: [8, 0.25, 0.05] },
    card('maskCard', -1.1, 'mask'), card('blendCard', 1.1, 'blend'),
  ],
  camera: { eye: [0, 1.6, 4.2], target: [0, 1, 0], fov: 40 },
};
await writeFile(`${out}/leaf-mask-vs-blend.json`, JSON.stringify({ recipe, size: [960, 540], backend: 'cpu' }, null, 2));
const created = await call('scene_create', { recipe });
const sessionId = JSON.parse(created.content.find(i => i.type === 'text').text).sessionId;
const look = await call('scene_look', { sessionId, width: 960, height: 540 });
await writeFile(`${out}/leaf-mask-vs-blend.png`, Buffer.from(look.content.find(i => i.type === 'image').data, 'base64'));
await client.close();
