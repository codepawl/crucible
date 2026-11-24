// Usage: node clip.mjs <checkout> <out folder> <label> <view,...> [frames]
// Renders a slow camera move (24 frames = 2 s at 12 fps) over the pixel recipe of each view, one scene session per view.
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [checkout, folder, label, viewList, frameArgument] = process.argv.slice(2);
const frames = Number(frameArgument ?? 24);
const MOVES = { close: [1.2, 0.2], heavy: [3, 0.4] };
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(checkout, 'bin/crucible-mcp.mjs'), '--jobs', join(tmpdir(), `clip3147-${process.pid}`)], stderr: 'inherit' });
const client = new Client({ name: 'clip', version: '1.0.0' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, { timeout: 600000 });
try {
  for (const view of viewList.split(',')) {
    const source = JSON.parse(await readFile(`C:/Users/nxan2/Documents/crucible/artifacts/3147e/r2/${view}-pixel.json`, 'utf8'));
    let created;
    for (let attempt = 0; attempt < 14; attempt++) {
      created = await call('scene_create', { recipe: source.recipe });
      if (!created.isError) break;
    }
    let { sessionId, revision } = created.structuredContent;
    const { eye, target, fov } = source.recipe.camera;
    const [shiftEye, shiftTarget] = MOVES[view];
    await mkdir(join(folder, `${label}-${view}`), { recursive: true });
    for (let frame = 0; frame < frames; frame++) {
      const target_ = join(folder, `${label}-${view}`, `f${String(frame).padStart(2, '0')}.png`);
      if (existsSync(target_)) continue;
      const progress = frame / (frames - 1);
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const state = (await call('scene_inspect', { sessionId })).structuredContent;
          revision = state.revision ?? revision;
          const applied = (await call('scene_apply', { sessionId, expectedRevision: revision, operations: [{ type: 'set-camera', eye: [eye[0] + shiftEye * progress, eye[1], eye[2]], target: [target[0] + shiftTarget * progress, target[1], target[2]], fov }] })).structuredContent;
          revision = applied.revision ?? revision + 1;
          const submitResponse = await call('scene_render_submit', { sessionId, expectedRevision: revision, settings: { kind: 'image', width: source.width, height: source.height } });
          if (submitResponse.isError) throw new Error('submit: ' + JSON.stringify(submitResponse.content).slice(0, 400));
          const submitted = submitResponse.structuredContent;
          for (;;) {
            const record = (await call('scene_render_status', { jobId: submitted.jobId })).structuredContent;
            if (record.state === 'completed') break;
            if (['cancelled', 'failed'].includes(record.state)) throw new Error(JSON.stringify(record).slice(0, 800));
            await delay(150);
          }
          const result = (await call('scene_render_result', { jobId: submitted.jobId })).structuredContent;
          await copyFile(result.artifacts[0].path, target_);
          await call('scene_render_release', { jobId: submitted.jobId });
          break;
        } catch (error) {
          console.log('frame', frame, 'attempt', attempt, String(error.message).slice(0, 200));
          if (attempt === 5) throw error;
        }
      }
    }
    console.log('done', label, view);
  }
} finally {
  await client.close();
}
