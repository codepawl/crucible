import { attachTracer } from './path-tracer-scene.js';
import { renderBand } from './path-tracer.js';

// One thread of a path trace: receives the flattened scene once, then draws the bands it is given.

let scene = null;
let camera = null;
let options = null;

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') throw new Error('Path tracer worker expected a message object.');
  if (message.type === 'scene') {
    scene = attachTracer(message.scene);
    camera = message.camera;
    options = message.options;
    self.postMessage({ type: 'ready' });
    return;
  }
  if (message.type !== 'band') throw new Error(`Path tracer worker received unknown message type ${JSON.stringify(message.type)}.`);
  if (!scene || !camera || !options) throw new Error('Path tracer worker received a band before its scene.');
  const band = renderBand(scene, camera, options, message.rowStart, message.rowEnd);
  self.postMessage({ type: 'band', rowStart: message.rowStart, band }, Object.values(band).map(buffer => buffer.buffer));
};
