import { parentPort } from 'node:worker_threads';
import { answerKernelRequest } from '../../src/kernel-registry.js';

parentPort.on('message', request => {
  const { response, transfer } = answerKernelRequest(request);
  parentPort.postMessage(response, transfer);
});
