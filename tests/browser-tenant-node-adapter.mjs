// Node adapter is only a test transport. Production browser hosts use
// real Web Workers and must pass a separate Chromium gate.
import {parentPort} from 'node:worker_threads';
if (!parentPort) throw Error('test adapter requires worker_threads');
const backlog = [];
globalThis.self = {postMessage: value => parentPort.postMessage(value)};
parentPort.on('message', data => {
  if (typeof globalThis.self.onmessage === 'function')
    globalThis.self.onmessage({data});
  else backlog.push(data);
});
await import('../src/browser-tenant-worker.mjs');
for (const data of backlog) globalThis.self.onmessage({data});
