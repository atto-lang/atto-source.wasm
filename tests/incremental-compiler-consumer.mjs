// Integration gate: real upstream compiler artifacts only; no hand-built Wasm.
// This is a runtime consumer test, not a distinct Wasm incremental compiler.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
const [coldPath,warmPath,editPath]=process.argv.slice(2);
if(!coldPath||!warmPath||!editPath||process.argv.length!==5)throw Error('expected cold, warm, edited compiler artifact paths');
const [cold,warm,edit]=await Promise.all([coldPath,warmPath,editPath].map(p=>readFile(p)));
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.deepEqual(cold,warm);assert.notDeepEqual(cold,edit);
const coldPin=sha(cold),editPin=sha(edit);
for(const [bytes,pin,expected] of [[cold,coldPin,42n],[warm,coldPin,42n],[edit,editPin,43n]]){
 const result=await runIsolatedCoreGuest(bytes,{expectedSha256:pin,timeoutMs:5000});
 assert.equal(result.value,expected);assert.equal(result.admission.sha256,pin);
}
await assert.rejects(runIsolatedCoreGuest(edit,{expectedSha256:coldPin,timeoutMs:5000}));
console.log('INCREMENTAL_WASM_CONSUMER|actual-worker-guests=42/42/43|stale-pin-denied|upstream-compiler');
