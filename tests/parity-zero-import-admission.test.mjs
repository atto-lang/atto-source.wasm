import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Both are individually VALID core WebAssembly modules. The second differs
// by containing an imported env.danger function; it is not a malformed
// bytecode fixture. Compile/validation occurs inside the real guest worker.
const HEADER_TYPE = [0,97,115,109,1,0,0,0, 1,5,1,96,0,1,126];
const FUNCTION = [3,2,1,0];
const MEMORY = [5,4,1,1,1,2];  // privately defined bounded memory: 1..2 pages
const EXPORTS = mainIndex => [7,17,2,4,109,97,105,110,0,mainIndex,
                              6,109,101,109,111,114,121,2,0];
const CODE = [10,6,1,4,0,66,14,11];  // i64.const 14
const IMPORT = [2,14,1,3,101,110,118,6,100,97,110,103,101,114,0,0];

const clean = Uint8Array.from([
  ...HEADER_TYPE, ...FUNCTION, ...MEMORY, ...EXPORTS(0), ...CODE
]);
const imported = Uint8Array.from([
  ...HEADER_TYPE, ...IMPORT, ...FUNCTION, ...MEMORY, ...EXPORTS(1), ...CODE
]);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("source parity: zero-import valid Wasm executes with zero host capabilities", async () => {
  assert.equal(WebAssembly.validate(clean), true);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(clean)), []);
  const {value, admission} = await runIsolatedCoreGuest(clean, {
    expectedSha256: sha256(clean), maxMemoryPages: 2, timeoutMs: 5000
  });
  assert.equal(value, 14n);
  assert.equal(admission.profile, "core-wasm.i64-v1");
  assert.equal(admission.imports, 0);
  assert.equal(admission.hostCapabilities, 0);
  assert.equal(admission.sha256, sha256(clean));
});

test("source parity: valid imported Wasm is denied before guest execution", async () => {
  assert.equal(WebAssembly.validate(imported), true,
    "rejecting malformed Wasm would not prove host-import confinement");
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(imported)),
    [{module: "env", name: "danger", kind: "function"}]);
  await assert.rejects(runIsolatedCoreGuest(imported, {
    expectedSha256: sha256(imported), maxMemoryPages: 2, timeoutMs: 5000
  }), /imports/i);
});

test("source parity: mismatched pinned executable bytes fail closed", async () => {
  await assert.rejects(runIsolatedCoreGuest(clean, {
    expectedSha256: sha256(imported), timeoutMs: 5000
  }), /sha-256|sha256|digest|mismatch/i);
});
