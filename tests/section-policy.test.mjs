import test from "node:test";
import assert from "node:assert/strict";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Valid core Wasm: one () -> i64 main, one private 1..2-page memory.
// The additional element section is *empty* and WebAssembly.validate
// accepts it. Our tighter scalar contract intentionally must not.
const header = [0,97,115,109,1,0,0,0];
const types = [1,5,1,0x60,0,1,0x7e];
const funcs = [3,2,1,0];
const memory = [5,4,1,1,1,2];
const exports = [7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0];
const body = [10,6,1,4,0,0x42,42,11];
const base = () => Uint8Array.from([...header,...types,...funcs,...memory,...exports,...body]);
const withElementSection = () => Uint8Array.from([
  ...header,...types,...funcs,...memory,...exports,
  9,1,0, // element section with zero segments (valid core Wasm)
  ...body
]);
test("positive minimal Wasm scalar fixture remains admitted and executable",async()=>{
  const guest=base();
  assert.equal(WebAssembly.validate(guest),true);
  const claim=admitCoreGuest(guest);
  assert.equal(claim.profile,"core-wasm.i64-v1");
  assert.equal((await runIsolatedCoreGuest(guest)).value,42n);
});
test("valid but forbidden element section is rejected before guest execution",async()=>{
  const guest=withElementSection();
  assert.equal(WebAssembly.validate(guest),true);
  assert.throws(()=>admitCoreGuest(guest),/element sections are forbidden/);
  await assert.rejects(runIsolatedCoreGuest(guest),/element sections are forbidden/);
});
