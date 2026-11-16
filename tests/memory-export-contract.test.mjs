import test from 'node:test';
import assert from 'node:assert/strict';
import {admitCoreGuest} from '../src/guest-admission.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

// Both byte sequences are actual valid core Wasm modules with one bounded,
// private memory and a main() -> i64 returning 42. They differ ONLY in
// whether that declared memory is exported as "memory".
const prefix = [0,97,115,109,1,0,0,0,1,5,1,96,0,1,126,3,2,1,0,5,4,1,1,1,2];
const tail = [10,6,1,4,0,66,42,11];
const mainExport = [4,109,97,105,110,0,0];
const memoryExport = [6,109,101,109,111,114,121,2,0];
const moduleBytes = exportMemory => Uint8Array.from([
  ...prefix, 7, exportMemory ? 17 : 8, exportMemory ? 2 : 1,
  ...mainExport, ...(exportMemory ? memoryExport : []), ...tail
]);

test('fail closed on valid Wasm with hidden, non-exported linear memory', async () => {
  const bytes = moduleBytes(false);
  assert.ok(WebAssembly.validate(bytes), 'negative fixture must be valid core Wasm');
  assert.deepEqual(WebAssembly.Module.exports(new WebAssembly.Module(bytes)),
    [{name:'main', kind:'function'}]);
  const layout = inspectWasmBytes(bytes, {maxMemoryPages:2});
  assert.equal(layout.memoryCount, 1);
  assert.equal(layout.memoryMaximum, 2);
  assert.throws(() => admitCoreGuest(bytes), /export exactly one bounded memory/);
  await assert.rejects(runIsolatedCoreGuest(bytes), /export exactly one bounded memory/);
});

test('allow exact scalar ABI with one exported bounded memory', async () => {
  const bytes = moduleBytes(true);
  assert.ok(WebAssembly.validate(bytes));
  const expectedExports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));
  assert.deepEqual(expectedExports, [
    {name:'main', kind:'function'}, {name:'memory', kind:'memory'}
  ]);
  const admission = admitCoreGuest(bytes);
  assert.equal(admission.memoryMaximumPages, 2);
  assert.equal((await runIsolatedCoreGuest(bytes)).value, 42n);
});
