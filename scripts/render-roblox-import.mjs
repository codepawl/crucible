// Imports a Roblox-style XML place, renders it in Crucible, and draws the same source parts in a separate diagram, side by side.
// Usage: node scripts/render-roblox-import.mjs <place.rbxlx> <output directory> [--size <width>x<height>]
// It also renders the albedo and objectId passes, averages each part's albedo, and prints the CIEDE2000 difference between that and
// the part's source Color3 (<name>-albedo.png, <name>-colour-check.json, <name>-three-up.png).
// Writes <name>.png (the Crucible render), <name>-diagram.png (flat-shaded source parts seen from the Roblox camera, drawn from the
// raw XML numbers with its own small reader and projection, not from the importer), <name>-side-by-side.png and <name>.json (the
// recipe, camera, size and backend of the render). Run it through gpu-lock: it starts the MCP server and a headless Chrome render.
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { importRoblox, STUD_METERS } from '../packages/roblox-import/index.mjs';

const serverEntry = new URL('../bin/crucible-mcp.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const SKY = '#cfd8e3';
const SPHERE_SEGMENTS = 28;
const SPHERE_RINGS = 14;
const CYLINDER_SEGMENTS = 28;

function parseArguments(argumentList) {
  const options = { file: null, directory: null, width: 1080, height: 1920 };
  for (let index = 0; index < argumentList.length; index++) {
    const argument = argumentList[index];
    if (argument === '--size') {
      const match = /^(\d+)x(\d+)$/.exec(argumentList[++index] ?? '');
      if (!match) throw new Error('Pass --size as <width>x<height>, for example --size 1080x1920.');
      options.width = Number(match[1]);
      options.height = Number(match[2]);
    } else if (!options.file) options.file = resolve(argument);
    else options.directory = resolve(argument);
  }
  if (!options.file || !options.directory) throw new Error('Usage: node scripts/render-roblox-import.mjs <place.rbxlx> <output directory> [--size WxH]');
  return options;
}

// ---------------------------------------------------------------- the diagram: its own reader for the fixture's few fields

function numbers(block, names) {
  return names.map(name => Number(new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)[1]));
}

function readSourceParts(xml) {
  const parts = [];
  const itemPattern = /<Item class="(Part|WedgePart)"[^>]*>([\s\S]*?)<\/Properties>/g;
  let match = itemPattern.exec(xml);
  while (match) {
    const body = match[2];
    const frameBlock = /<CoordinateFrame name="CFrame">([\s\S]*?)<\/CoordinateFrame>/.exec(body)[1];
    const packed = Number(/name="Color3uint8">(\d+)</.exec(body)[1]);
    const name = /<string name="Name">([^<]*)</.exec(body)[1];
    const shape = match[1] === 'WedgePart' ? 'wedge' : ['ball', 'block', 'cylinder'][Number(/name="shape">(\d)</.exec(body)?.[1] ?? 1)];
    const size = numbers(/<Vector3 name="size">([\s\S]*?)<\/Vector3>/.exec(body)[1], ['X', 'Y', 'Z']);
    const transparency = Number(/name="Transparency">([^<]*)</.exec(body)?.[1] ?? 0);
    parts.push({
      name, shape, size, transparency,
      position: numbers(frameBlock, ['X', 'Y', 'Z']),
      rotation: numbers(frameBlock, ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']),
      color: [(packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255],
    });
    match = itemPattern.exec(xml);
  }
  const cameraBlock = /<Item class="Camera"[\s\S]*?<\/Properties>/.exec(xml)[0];
  const cameraFrame = /<CoordinateFrame name="CFrame">([\s\S]*?)<\/CoordinateFrame>/.exec(cameraBlock)[1];
  const camera = {
    position: numbers(cameraFrame, ['X', 'Y', 'Z']),
    rotation: numbers(cameraFrame, ['R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']),
    fov: Number(/name="FieldOfView">([^<]*)</.exec(cameraBlock)[1]),
  };
  return { parts, camera };
}

function toWorld(part, local) {
  const { rotation, position } = part;
  return [0, 1, 2].map(row => rotation[row * 3] * local[0] + rotation[row * 3 + 1] * local[1] + rotation[row * 3 + 2] * local[2] + position[row]);
}

// Local-space triangles of a part, in studs, centred on the part. Each face is a list of corners.
function faces(part) {
  const [sx, sy, sz] = part.size.map(value => value / 2);
  if (part.shape === 'block') {
    const corner = (x, y, z) => [x * sx, y * sy, z * sz];
    return [
      [corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1)],
      [corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1)],
      [corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1)],
      [corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1)],
      [corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1)],
      [corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1)],
    ];
  }
  if (part.shape === 'wedge') {
    // Triangle in the Y-Z plane: floor along the whole depth, tall side at +Z (the back), slope rising toward the back.
    const front = [-sy, -sz];
    const point = (x, [y, z]) => [x, y, z];
    const bottomBack = [-sy, sz];
    const topBack = [sy, sz];
    return [
      [point(-sx, front), point(-sx, bottomBack), point(-sx, topBack)],
      [point(sx, front), point(sx, bottomBack), point(sx, topBack)],
      [point(-sx, front), point(sx, front), point(sx, bottomBack), point(-sx, bottomBack)],
      [point(-sx, bottomBack), point(sx, bottomBack), point(sx, topBack), point(-sx, topBack)],
      [point(-sx, front), point(sx, front), point(sx, topBack), point(-sx, topBack)],
    ];
  }
  const result = [];
  if (part.shape === 'ball') {
    const vertex = (ring, segment) => {
      const polar = (ring / SPHERE_RINGS) * Math.PI;
      const azimuth = (segment / SPHERE_SEGMENTS) * Math.PI * 2;
      return [sx * Math.sin(polar) * Math.cos(azimuth), sy * Math.cos(polar), sz * Math.sin(polar) * Math.sin(azimuth)];
    };
    for (let ring = 0; ring < SPHERE_RINGS; ring++) {
      for (let segment = 0; segment < SPHERE_SEGMENTS; segment++) {
        result.push([vertex(ring, segment), vertex(ring + 1, segment), vertex(ring + 1, segment + 1), vertex(ring, segment + 1)]);
      }
    }
    return result;
  }
  // Roblox cylinder: length along local X, diameter in Y and Z.
  const ringPoint = (end, segment) => {
    const angle = (segment / CYLINDER_SEGMENTS) * Math.PI * 2;
    return [end * sx, sy * Math.cos(angle), sz * Math.sin(angle)];
  };
  for (let segment = 0; segment < CYLINDER_SEGMENTS; segment++) {
    result.push([ringPoint(-1, segment), ringPoint(1, segment), ringPoint(1, segment + 1), ringPoint(-1, segment + 1)]);
  }
  result.push(Array.from({ length: CYLINDER_SEGMENTS }, (_, segment) => ringPoint(-1, segment)));
  result.push(Array.from({ length: CYLINDER_SEGMENTS }, (_, segment) => ringPoint(1, segment)));
  return result;
}

function subtract(left, right) {
  return left.map((value, axis) => value - right[axis]);
}

function cross(left, right) {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function dot(left, right) {
  return left.reduce((sum, value, axis) => sum + value * right[axis], 0);
}

function normalize(vector) {
  const length = Math.hypot(...vector);
  return vector.map(value => value / length);
}

function drawDiagram(source, width, height) {
  const { camera } = source;
  const axes = [0, 1, 2].map(column => [camera.rotation[column], camera.rotation[3 + column], camera.rotation[6 + column]]);
  const [right, up, back] = axes;
  const focal = height / 2 / Math.tan((camera.fov * Math.PI) / 360);
  const project = world => {
    const relative = subtract(world, camera.position);
    const depth = -dot(relative, back);
    return { x: width / 2 + (dot(relative, right) / depth) * focal, y: height / 2 - (dot(relative, up) / depth) * focal, depth };
  };
  const toward = normalize([-0.4, 1, 0.5]);
  const polygons = [];
  source.parts.forEach((part, index) => {
    for (const face of faces(part)) {
      const world = face.map(corner => toWorld(part, corner));
      const center = world.reduce((sum, corner) => sum.map((value, axis) => value + corner[axis] / world.length), [0, 0, 0]);
      let normal = normalize(cross(subtract(world[1], world[0]), subtract(world[2], world[0])));
      // A point inside the solid; the centre of a wedge lies on its slope, so use the centre of its triangle instead.
      const partCenter = part.shape === 'wedge' ? toWorld(part, [0, -part.size[1] / 6, part.size[2] / 6]) : part.position;
      if (dot(normal, subtract(center, partCenter)) < 0) normal = normal.map(value => -value);
      if (part.transparency === 0 && dot(normal, subtract(camera.position, center)) <= 0) continue;
      const shade = 0.5 + 0.5 * Math.max(0, dot(normal, toward));
      const points = world.map(project);
      if (points.some(point => point.depth <= 0.1)) continue;
      polygons.push({
        depth: Math.hypot(...subtract(center, camera.position)), points, index, transparency: part.transparency,
        fill: part.color.map(channel => Math.round(Math.min(255, channel * shade))),
      });
    }
  });
  // The ground is one huge quad whose centre is nearer than far parts, so it is always drawn first.
  polygons.sort((first, second) => (first.index === 0 ? -1 : second.index === 0 ? 1 : second.depth - first.depth));
  const shapes = polygons.map(polygon => {
    const points = polygon.points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const stroke = polygon.fill.map(channel => Math.round(channel * 0.8)).join(',');
    return `<polygon points="${points}" fill="rgb(${polygon.fill.join(',')})" fill-opacity="${1 - polygon.transparency}" stroke="rgb(${stroke})" stroke-width="1" stroke-linejoin="round"/>`;
  });
  const labels = source.parts.map((part, index) => {
    const point = project(part.position);
    return `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="17" fill="#ffffff" fill-opacity="0.9"/>`
      + `<text x="${point.x.toFixed(1)}" y="${(point.y + 7).toFixed(1)}" font-family="Arial, sans-serif" font-size="20" font-weight="700" text-anchor="middle" fill="#1b1f24">${index + 1}</text>`;
  });
  const legendLines = source.parts.map((part, index) => `<text x="40" y="${height - 40 - (source.parts.length - 1 - index) * 30}" font-family="Arial, sans-serif" font-size="22" fill="#1b1f24">${index + 1}  ${part.name} (${part.shape}, ${part.size.join(' x ')} studs)</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${SKY}"/>${shapes.join('')}${labels.join('')}${legendLines.join('')}</svg>`;
}

// ---------------------------------------------------------------- the render, through the MCP render job tools

async function renderJob(call, sessionId, settings) {
  const submitted = await call('scene_render_submit', { sessionId, expectedRevision: 0, settings });
  if (submitted.isError) throw new Error(submitted.content?.[0]?.text);
  const { jobId } = submitted.structuredContent;
  for (;;) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (record.state === 'completed') break;
    if (['cancelled', 'failed'].includes(record.state)) throw new Error(`Render job ${record.state}: ${record.reason}`);
    await delay(250);
  }
  const result = (await call('scene_render_result', { jobId, response_format: 'detailed' })).structuredContent;
  const artifacts = new Map(result.artifacts.map(artifact => [artifact.path.split(/[\\/]/).pop(), artifact.path]));
  return { artifacts, metrics: result.metrics };
}

async function renderRecipe(recipe, width, height, outputPath, albedoPath, objectIdPath) {
  if (!existsSync(new URL('../build/mcp/server.mjs', import.meta.url))) throw new Error('Run npm run build and node scripts/build-mcp.mjs first: the MCP server is not built.');
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry, '--jobs', join(tmpdir(), `crucible-roblox-${process.pid}`)], stderr: 'ignore' });
  const client = new Client({ name: 'render-roblox-import', version: '1.0.0' });
  await client.connect(transport);
  try {
    const call = (name, toolArguments) => client.callTool({ name, arguments: toolArguments }, { timeout: 600000 });
    const created = await call('scene_create', { recipe });
    if (created.isError) throw new Error(created.content?.[0]?.text);
    const { sessionId } = created.structuredContent;
    const { artifacts, metrics } = await renderJob(call, sessionId, { kind: 'image', width, height, passes: ['albedo', 'objectId'] });
    await copyFile(artifacts.get('render.png'), outputPath);
    await copyFile(artifacts.get('render-albedo.png'), albedoPath);
    await copyFile(artifacts.get('render-objectId.png'), objectIdPath);
    await call('scene_dispose', { sessionId });
    return metrics.objectNodes;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------- the colour check: mean albedo per part against its source Color3

function srgbToLinear(value) {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb255(value) {
  const clamped = Math.min(1, Math.max(0, value));
  return 255 * (clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055);
}

function srgbToLab(rgb255) {
  const [red, green, blue] = rgb255.map(srgbToLinear);
  const x = (0.4124564 * red + 0.3575761 * green + 0.1804375 * blue) / 0.95047;
  const y = 0.2126729 * red + 0.7151522 * green + 0.072175 * blue;
  const z = (0.0193339 * red + 0.119192 * green + 0.9503041 * blue) / 1.08883;
  const cubeRootCurve = value => (value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116);
  return [116 * cubeRootCurve(y) - 16, 500 * (cubeRootCurve(x) - cubeRootCurve(y)), 200 * (cubeRootCurve(y) - cubeRootCurve(z))];
}

/** CIEDE2000 between two sRGB colours (0 to 255), after Sharma, Wu and Dalal (2005). */
export function deltaE2000(firstRgb, secondRgb) {
  const [l1, a1, b1] = srgbToLab(firstRgb);
  const [l2, a2, b2] = srgbToLab(secondRgb);
  const radians = angle => angle * Math.PI / 180;
  const degrees = angle => angle * 180 / Math.PI;
  const chromaMean = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(chromaMean ** 7 / (chromaMean ** 7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1 = Math.hypot(a1Prime, b1);
  const c2 = Math.hypot(a2Prime, b2);
  const hue = (b, aPrime) => (b === 0 && aPrime === 0 ? 0 : (degrees(Math.atan2(b, aPrime)) + 360) % 360);
  const h1 = hue(b1, a1Prime);
  const h2 = hue(b2, a2Prime);
  const deltaL = l2 - l1;
  const deltaC = c2 - c1;
  let deltaH = 0;
  if (c1 * c2 !== 0) {
    deltaH = h2 - h1;
    if (deltaH > 180) deltaH -= 360;
    else if (deltaH < -180) deltaH += 360;
  }
  const deltaHue = 2 * Math.sqrt(c1 * c2) * Math.sin(radians(deltaH / 2));
  const lMean = (l1 + l2) / 2;
  const cMean = (c1 + c2) / 2;
  let hMean = h1 + h2;
  if (c1 * c2 !== 0) {
    hMean = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
  }
  const t = 1 - 0.17 * Math.cos(radians(hMean - 30)) + 0.24 * Math.cos(radians(2 * hMean)) + 0.32 * Math.cos(radians(3 * hMean + 6)) - 0.2 * Math.cos(radians(4 * hMean - 63));
  const deltaTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7));
  const sl = 1 + 0.015 * (lMean - 50) ** 2 / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cMean;
  const sh = 1 + 0.015 * cMean * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  return Math.sqrt((deltaL / sl) ** 2 + (deltaC / sc) ** 2 + (deltaHue / sh) ** 2 + rt * (deltaC / sc) * (deltaHue / sh));
}

/** Mean albedo (the pass stores linear values, 0 to 255) of every pixel that shows the object and has four neighbours that show it too. */
async function meanAlbedoPerObject(albedoPath, objectIdPath) {
  const albedo = await sharp(albedoPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const identifiers = await sharp(objectIdPath).removeAlpha().raw().toBuffer();
  const { width, height } = albedo.info;
  const sums = new Map();
  const identifierAt = (x, y) => identifiers[(y * width + x) * 3] + identifiers[(y * width + x) * 3 + 1] * 256 + identifiers[(y * width + x) * 3 + 2] * 65536;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const identifier = identifierAt(x, y);
      if (identifier === 0) continue;
      if (identifierAt(x - 1, y) !== identifier || identifierAt(x + 1, y) !== identifier || identifierAt(x, y - 1) !== identifier || identifierAt(x, y + 1) !== identifier) continue;
      const entry = sums.get(identifier) ?? { count: 0, red: 0, green: 0, blue: 0 };
      const offset = (y * width + x) * 3;
      entry.count += 1;
      entry.red += albedo.data[offset];
      entry.green += albedo.data[offset + 1];
      entry.blue += albedo.data[offset + 2];
      sums.set(identifier, entry);
    }
  }
  return new Map([...sums].map(([identifier, entry]) => [identifier, { pixels: entry.count, rgb: [entry.red / entry.count, entry.green / entry.count, entry.blue / entry.count] }]));
}

/** Rewrites the albedo pass as sRGB, the way a screen shows colour, with the sky colour where no object is drawn. */
async function writeAlbedoPreview(albedoPath, objectIdPath) {
  const albedo = await sharp(albedoPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const identifiers = await sharp(objectIdPath).removeAlpha().raw().toBuffer();
  const sky = [0xcf, 0xd8, 0xe3];
  const preview = Buffer.alloc(albedo.data.length);
  for (let offset = 0; offset < albedo.data.length; offset += 3) {
    const empty = identifiers[offset] + identifiers[offset + 1] + identifiers[offset + 2] === 0;
    for (let channel = 0; channel < 3; channel++) {
      preview[offset + channel] = empty ? sky[channel] : Math.round(linearToSrgb255(albedo.data[offset + channel] / 255));
    }
  }
  await sharp(preview, { raw: albedo.info }).png().toFile(`${albedoPath}.preview.png`);
  await copyFile(`${albedoPath}.preview.png`, albedoPath);
  await rm(`${albedoPath}.preview.png`);
}

async function colourTable(source, recipe, objectNodes, albedoPath, objectIdPath) {
  const means = await meanAlbedoPerObject(albedoPath, objectIdPath);
  const materials = new Map(recipe.materials.map(material => [material.id, material]));
  const rows = [];
  source.parts.forEach((part, index) => {
    const suffix = new RegExp(`-${index}(\\.slope)?$`);
    const node = recipe.nodes.find(candidate => candidate.geometry && suffix.test(candidate.id));
    const identifiers = objectNodes[node.id] ?? [];
    const row = { part: part.name, source: part.color };
    const material = materials.get(node.material);
    if (material.alphaMode !== 'blend' && identifiers.length > 0 && means.has(identifiers[0])) {
      const measured = means.get(identifiers[0]);
      row.measured = measured.rgb.map(value => Math.round(linearToSrgb255(value / 255) * 10) / 10);
      row.pixels = measured.pixels;
      row.from = 'albedo pass';
    } else {
      row.measured = material.color.map(value => Math.round(linearToSrgb255(value) * 10) / 10);
      row.pixels = 0;
      row.from = 'scene material (a blended part is not a clean albedo)';
    }
    row.deltaE2000 = Math.round(deltaE2000(row.measured, part.color) * 100) / 100;
    rows.push(row);
  });
  return rows;
}

async function caption(text, width) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="56"><rect width="${width}" height="56" fill="#1b1f24"/><text x="24" y="37" font-family="Arial, sans-serif" font-size="26" fill="#ffffff">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(options.directory, { recursive: true });
  const name = basename(options.file).replace(/\.[^.]+$/, '');
  const xml = await readFile(options.file, 'utf8');
  const result = importRoblox(xml);
  for (const warning of result.warnings) console.log(`warning: ${warning}`);
  const renderPath = join(options.directory, `${name}.png`);
  const albedoPath = join(options.directory, `${name}-albedo.png`);
  const objectIdPath = join(options.directory, `${name}-objectid.png`);
  const objectNodes = await renderRecipe(result.recipe, options.width, options.height, renderPath, albedoPath, objectIdPath);
  const sourceParts = readSourceParts(xml);
  const table = await colourTable(sourceParts, result.recipe, objectNodes, albedoPath, objectIdPath);
  await writeAlbedoPreview(albedoPath, objectIdPath);
  await rm(objectIdPath);
  console.log('| Part | Source Color3 | Mean albedo (sRGB) | Pixels | dE2000 |');
  for (const row of table) console.log(`| ${row.part} | ${row.source.join(', ')} | ${row.measured.join(', ')} | ${row.pixels} | ${row.deltaE2000} |`);
  await writeFile(join(options.directory, `${name}-colour-check.json`), `${JSON.stringify(table, null, 2)}\n`);
  const diagramPath = join(options.directory, `${name}-diagram.png`);
  await sharp(Buffer.from(drawDiagram(sourceParts, options.width, options.height))).png().toFile(diagramPath);
  const bar = 56;
  const sideBySide = join(options.directory, `${name}-side-by-side.png`);
  await sharp({ create: { width: options.width * 2, height: options.height + bar, channels: 3, background: '#1b1f24' } })
    .composite([
      { input: await caption('Source parts drawn from the Roblox XML', options.width), left: 0, top: 0 },
      { input: await caption('Imported into Crucible and rendered', options.width), left: options.width, top: 0 },
      { input: diagramPath, left: 0, top: bar },
      { input: renderPath, left: options.width, top: bar },
    ]).png().toFile(sideBySide);
  const threeUp = join(options.directory, `${name}-three-up.png`);
  await sharp({ create: { width: options.width * 3, height: options.height + bar, channels: 3, background: '#1b1f24' } })
    .composite([
      { input: await caption('Source parts from the Roblox XML', options.width), left: 0, top: 0 },
      { input: await caption('Crucible albedo pass in sRGB, glass not in it', options.width), left: options.width, top: 0 },
      { input: await caption('Crucible lit render', options.width), left: options.width * 2, top: 0 },
      { input: diagramPath, left: 0, top: bar },
      { input: albedoPath, left: options.width, top: bar },
      { input: renderPath, left: options.width * 2, top: bar },
    ]).png().toFile(threeUp);
  await writeFile(join(options.directory, `${name}.json`), `${JSON.stringify({
    source: basename(options.file), studMeters: STUD_METERS, size: [options.width, options.height], backend: 'crucible MCP render job, kind image, default quality, passes albedo and objectId',
    camera: result.recipe.camera, environment: result.recipe.environment, recipe: result.recipe,
  }, null, 2)}\n`);
  console.log(`wrote ${renderPath}, ${diagramPath}, ${sideBySide}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
