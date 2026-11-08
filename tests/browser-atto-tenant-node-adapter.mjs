// Test-only Node worker_threads adapter for the exact browser module.
// Not a replacement for a real Chromium browser test.
import {parentPort} from 'node:worker_threads';
if(!parentPort)throw Error('Node integrated tenant adapter requires worker_threads');
const backlog=[];
globalThis.self={postMessage:reply=>parentPort.postMessage(reply)};
parentPort.on('message',data=>{
  if(typeof self.onmessage==='function')self.onmessage({data});
  else backlog.push(data);
});
await import('../src/browser-atto-tenant-worker.mjs');
for(const data of backlog)self.onmessage({data});
