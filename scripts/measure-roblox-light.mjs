// Measures what a Roblox PointLight of Brightness 1 and Range 8 adds to a scene under Crucible's default sun and ambient light,
// to document the importer's candela-per-Brightness constant. A top-down camera looks at a grey card; the same scene is rendered
// with and without the lamp (a 1 stud part, fully transparent, one metre above the card) and the pixel luma is compared in rings
// around the lamp. A white card checks that the lamp does not clip it at one metre.
// Usage: node scripts/measure-roblox-light.mjs [output.json]
// Run it through gpu-lock: it starts the MCP server and a headless Chrome render.
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { importRoblox, STUD_METERS, CANDELA_PER_BRIGHTNESS } from '../packages/roblox-import/index.mjs';

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const SIZE = 512;
const FIELD_OF_VIEW = 70;
const CAMERA_HEIGHT_STUDS = 30;
const LAMP_HEIGHT_STUDS = 1 / STUD_METERS;
const RING_RADII_METERS = [0, 0.5, 1, 1.5, 2, 2.24, 3, 4];

function colourPacked(red, green, blue) {
  return 4278190080 + red * 65536 + green * 256 + blue;
}

function place({ grey, withLamp, brightness, range }) {
  const lamp = withLamp
    ? `<Item class="Part" referent="RBX3"><Properties><string name="Name">Lamp</string><token name="shape">1</token><Vector3 name="size"><X>1</X><Y>1</Y><Z>1</Z></Vector3><CoordinateFrame name="CFrame"><X>0</X><Y>${LAMP_HEIGHT_STUDS}</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame><Color3uint8 name="Color3uint8">${colourPacked(255, 255, 255)}</Color3uint8><token name="Material">256</token><float name="Transparency">1</float></Properties><Item class="PointLight" referent="RBX4"><Properties><string name="Name">PointLight</string><float name="Brightness">${brightness}</float><float name="Range">${range}</float><Color3 name="Color"><R>1</R><G>1</G><B>1</B></Color3></Properties></Item></Item>`
    : '';
  return `<roblox version="4"><Item class="Camera" referent="RBX1"><Properties><string name="Name">Camera</string><float name="FieldOfView">${FIELD_OF_VIEW}</float><CoordinateFrame name="CFrame"><X>0</X><Y>${CAMERA_HEIGHT_STUDS}</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>0</R11><R12>1</R12><R20>0</R20><R21>-1</R21><R22>0</R22></CoordinateFrame></Properties></Item><Item class="Part" referent="RBX2"><Properties><string name="Name">Card</string><token name="shape">1</token><Vector3 name="size"><X>80</X><Y>1</Y><Z>80</Z></Vector3><CoordinateFrame name="CFrame"><X>0</X><Y>-0.5</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame><Color3uint8 name="Color3uint8">${colourPacked(grey, grey, grey)}</Color3uint8><token name="Material">256</token></Properties></Item>${lamp}</roblox>`;
}

async function renderPlace(client, xml) {
  const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
  const created = await call('scene_create', { recipe: importRoblox(xml).recipe });
  if (created.isError) throw new Error(created.content?.[0]?.text);
  const { sessionId } = created.structuredContent;
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings: { kind: 'image', width: SIZE, height: SIZE } });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') break;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
    await delay(250);
  }
  const result = (await call('scene_render_result', { jobId, response_format: 'detailed' })).structuredContent;
  const path = result.artifacts.find(artifact => artifact.path.endsWith('render.png')).path;
  const image = await sharp(path).removeAlpha().raw().toBuffer();
  await call('scene_dispose', { sessionId });
  return image;
}

function lumaAt(image, x, y) {
  const offset = (y * SIZE + x) * 3;
  return 0.2126 * image[offset] + 0.7152 * image[offset + 1] + 0.0722 * image[offset + 2];
}

function srgbToLinearLuma(luma) {
  const unit = luma / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

// A top-down camera: a point on the card at distance r from the lamp's axis lies at r * focal / height pixels from the centre.
function ringLuma(image, radiusMeters) {
  const cameraHeightMeters = CAMERA_HEIGHT_STUDS * STUD_METERS;
  const focalPixels = (SIZE / 2) / Math.tan((FIELD_OF_VIEW * Math.PI / 180) / 2);
  const radiusPixels = radiusMeters * focalPixels / cameraHeightMeters;
  const samples = radiusMeters === 0 ? 1 : 64;
  let total = 0;
  for (let step = 0; step < samples; step++) {
    const angle = (2 * Math.PI * step) / samples;
    const x = Math.round(SIZE / 2 + radiusPixels * Math.cos(angle));
    const y = Math.round(SIZE / 2 + radiusPixels * Math.sin(angle));
    total += lumaAt(image, x, y);
  }
  return total / samples;
}

async function main() {
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build and node scripts/build-mcp.mjs first: the MCP server is not built.');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', join(tmpdir(), `crucible-roblox-light-${process.pid}`)], stderr: 'ignore' });
  const client = new Client({ name: 'measure-roblox-light', version: '1.0.0' });
  await client.connect(transport);
  const report = { candelaPerBrightness: CANDELA_PER_BRIGHTNESS, lampHeightMeters: 1, cards: {} };
  try {
    for (const [label, grey] of [['grey card (sRGB 128)', 128], ['white card (sRGB 255)', 255]]) {
      const without = await renderPlace(client, place({ grey, withLamp: false }));
      const withLamp = await renderPlace(client, place({ grey, withLamp: true, brightness: 1, range: 8 }));
      const rings = RING_RADII_METERS.map(radius => {
        const before = ringLuma(without, radius);
        const after = ringLuma(withLamp, radius);
        return { radiusMeters: radius, lumaWithout: Math.round(before * 10) / 10, lumaWith: Math.round(after * 10) / 10, linearGain: Math.round(srgbToLinearLuma(after) / srgbToLinearLuma(before) * 100) / 100 };
      });
      let brightest = 0;
      for (let index = 0; index < withLamp.length; index++) brightest = Math.max(brightest, withLamp[index]);
      report.cards[label] = { rings, brightestChannelValue: brightest };
    }
  } finally {
    await client.close();
  }
  console.log(JSON.stringify(report, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
