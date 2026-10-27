import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";

// Minimal core module:
//   export memory 1..1 pages
//   export main: () -> i64 { 42 }
const PURE_CORE = Uint8Array.from([
  0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
  0x01,0x05,0x01,0x60,0x00,0x01,0x7e,
  0x03,0x02,0x01,0x00,
  0x05,0x04,0x01,0x01,0x01,0x01,
  0x07,0x11,0x02,
    0x04,0x6d,0x61,0x69,0x6e,0x00,0x00,
    0x06,0x6d,0x65,0x6d,0x6f,0x72,0x79,0x02,0x00,
  0x0a,0x06,0x01,0x04,0x00,0x42,0x2a,0x0b
]);

test("core-wasm admission exposes zero host I/O capabilities", () => {
  const {admission, module} = compileAdmittedCoreGuest(PURE_CORE);
  assert.equal(admission.profile, "core-wasm.i64-v1");
  assert.equal(admission.imports, 0);
  assert.equal(admission.hostCapabilities, 0);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
});

test("host I/O options fail before guest compilation or execution", () => {
  const invalid = Uint8Array.of(0);
  assert.throws(
    () => compileAdmittedCoreGuest(invalid, {ioMode: "blocking"}),
    /refuses legacy\/blocking host I\/O/
  );
  assert.throws(
    () => compileAdmittedCoreGuest(invalid, {guestNetworkIo: true}),
    /guest NIO is not implemented/
  );
  assert.throws(
    () => compileAdmittedCoreGuest(invalid, {nioReactors: 1}),
    /reactor threads are unsupported/
  );
});

test("even an empty Wasm import section is rejected before compilation", () => {
  const emptyImportSection = Uint8Array.from([
    0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
    0x02,0x01,0x00
  ]);
  assert.throws(
    () => inspectWasmBytes(emptyImportSection),
    /host imports denied before Wasm compilation/
  );
});

test("shared-memory modules are denied before engine compilation", () => {
  const sharedMemory = Uint8Array.from([
    0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
    0x05,0x04,0x01,0x03,0x01,0x01
  ]);
  assert.throws(
    () => inspectWasmBytes(sharedMemory),
    /shared\/memory64 forbidden/
  );
});

test("guest worker instantiates with an empty import object", async () => {
  const source = await readFile(new URL("../src/guest-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /new\s+WebAssembly\.Instance\s*\(\s*module\s*,\s*\{\s*\}\s*\)/);
  assert.doesNotMatch(source, /wasi_snapshot_preview1|wasi:|node:fs|node:net|node:http/);
});
