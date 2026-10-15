import test from "node:test";
import assert from "node:assert/strict";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Valid core Wasm with bounded memory, exported () -> i64 main, plus
// an import section that the strict scalar admission profile forbids.
const header=[0,97,115,109,1,0,0,0];
const types=[1,5,1,96,0,1,126];
const funcs=[3,2,1,0];
const memory=[5,4,1,1,1,2];
const exportsSection=[7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0];
const code=[10,6,1,4,0,66,42,11];
const emptyImports=[2,1,0];
const importedGlobal=[2,10,1,3,101,110,118,1,103,3,127,0];
const guest=imports=>Uint8Array.from([...header,...types,...imports,...funcs,...memory,...exportsSection,...code]);

test("control fixture without import section remains admitted",()=>{
 const bytes=guest([]);
 assert.equal(WebAssembly.validate(bytes),true);
 assert.equal(admitCoreGuest(bytes).hostCapabilities,0);
});

for(const [name,section,expectedCount] of [
 ["empty import section",emptyImports,0],
 ["actual imported global",importedGlobal,1]
]){
 test("reject "+name+" before guest code compilation",async()=>{
  const bytes=guest(section);
  assert.equal(WebAssembly.validate(bytes),true,"negative fixture must be valid Wasm");
  assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(bytes)).length,expectedCount);
  assert.throws(()=>inspectWasmBytes(bytes),/host imports denied before Wasm compilation/);
  assert.throws(()=>admitCoreGuest(bytes),/host imports denied before Wasm compilation/);
  await assert.rejects(runIsolatedCoreGuest(bytes),/host imports denied before Wasm compilation/);
 });
}

test("malformed import descriptor fails at byte policy before engine compilation",()=>{
 const bytes=guest([2,1,1]);
 assert.equal(WebAssembly.validate(bytes),false);
 assert.throws(()=>inspectWasmBytes(bytes),/host imports denied before Wasm compilation/);
});
