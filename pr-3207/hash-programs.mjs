// Hashes the default raster program text (vertex, fragment, depth) of a worktree, with and without the liquid shader module imported.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2]);
const shaders = await import(pathToFileURL(join(root, 'src/shaders.js')).href);
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const result = {
  defaultVertex: hash(shaders.vertexShader),
  defaultFragment: hash(shaders.createFragmentShader(new Set())),
  defaultDepthFragment: hash(shaders.createDepthFragmentShader(new Set())),
  benchmarkFragment: hash(shaders.benchmarkFragmentShader),
};
await import(pathToFileURL(join(root, 'src/liquid-shader.js')).href);
result.defaultFragmentAfterLiquidImported = hash(shaders.createFragmentShader(new Set()));
result.liquidFragment = hash(shaders.liquidFragmentSource());
console.log(JSON.stringify(result, null, 1));
