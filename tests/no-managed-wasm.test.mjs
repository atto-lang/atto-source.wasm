import test from "node:test";
import assert from "node:assert/strict";
import {assertNoManagedWasm} from "../scripts/no-managed-wasm.mjs";
import {inspectWasmBytes} from "../scripts/inspect-core-memory.mjs";
import {admitCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// Real, individually valid Wasm modules unless explicitly marked malformed.
// These are source-free binary admission tests, NOT .ores compiler parity.
const header = [0,97,115,109,1,0,0,0];
const scalarType = [1,0x60,0,1,0x7e];
const functions = [3,2,1,0];
const memory = [5,4,1,1,1,2];
const exports = [7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0];
const section = (id, payload) => {
  if (payload.length >= 128) throw Error("test fixture requires simple section size");
  return [id, payload.length, ...payload];
};
const guest = (body = [0,0x42,42,0x0b], {
  types = scalarType,
  globals = [],
  custom = [],
} = {}) => Uint8Array.from([
  ...header,
  ...section(1, types),
  ...functions,
  ...memory,
  ...(globals.length ? section(6, globals) : []),
  ...exports,
  ...section(10, [1,body.length,...body]),
  ...custom
]);

test("strict scalar gate still executes a legitimate native-compiled-shaped guest", async () => {
  const bytes = guest();
  assert.equal(WebAssembly.validate(bytes), true);
  assert.doesNotThrow(() => assertNoManagedWasm(bytes));
  assert.equal(admitCoreGuest(bytes).hostCapabilities, 0);
  assert.equal((await runIsolatedCoreGuest(bytes)).value, 42n);
});

test("a literal LEB continuation 0xfb and custom-section bytes are not GC opcodes", () => {
  // i64.const 123 => 0xfb,0x00; rejecting raw occurrences of 0xfb would
  // erroneously reject valid numeric guest code.
  const bytes = guest([0,0x42,0xfb,0x00,0x0b], {
    custom: section(0, [1,0x78,0xfb]) // custom name "x", payload 0xfb
  });
  assert.equal(WebAssembly.validate(bytes), true);
  assert.doesNotThrow(() => assertNoManagedWasm(bytes));
  assert.equal(admitCoreGuest(bytes).profile, "core-wasm.i64-v1");
});

const negatives = [
  ["externref opcode", guest([0,0xd0,0x6f,0x1a,0x42,42,0x0b]), /reference instruction forbidden/],
  ["externref local", guest([1,1,0x6f,0x42,42,0x0b]), /managed reference, vector or GC value type forbidden/],
  ["unused reference function signature", guest(undefined, {
    types: [2,0x60,0,1,0x7e,0x60,1,0x6f,1,0x7e]
  }), /managed reference, vector or GC value type forbidden/],
  ["real Wasm-GC struct type", guest(undefined, {
    types: [2,0x60,0,1,0x7e,0x5f,1,0x7f,0]
  }), /GC\/subtype\/array\/struct type forbidden/],
  ["real Wasm-GC allocation", guest([0,0x41,1,0xfb,0,1,0x1a,0x42,42,0x0b], {
    types: [2,0x60,0,1,0x7e,0x5f,1,0x7f,0]
  }), /GC\/subtype\/array\/struct type forbidden/],
  ["reference global", guest(undefined, {
    globals: [1,0x6f,0,0xd0,0x6f,0x0b]
  }), /managed reference, vector or GC value type forbidden/],
];

for (const [name,bytes,message] of negatives) {
  test("fail closed before compilation: " + name, async () => {
    assert.equal(WebAssembly.validate(bytes), true, "must test valid Wasm, not malformed bytes");
    assert.throws(() => assertNoManagedWasm(bytes), message);
    assert.throws(() => inspectWasmBytes(bytes), message);
    assert.throws(() => admitCoreGuest(bytes), message);
    await assert.rejects(runIsolatedCoreGuest(bytes), message);
  });
}

test("standalone no-managed scanner rejects unsupported sections before engine compilation", () => {
  const restricted = [
    [2, [0]],                // imports, including empty imports
    [4, [1,0x70,0,1]],       // managed funcref table
    [8, [0]],                // start
    [9, [0]],                // element
    [13, [0]],               // exceptions/tags
    [14, [0]],               // unknown future core extension
  ];
  for (const [id,payload] of restricted) {
    const bytes = Uint8Array.from([...header,...section(id,payload)]);
    assert.throws(() => assertNoManagedWasm(bytes),
      /host import, table, start, element or tag section forbidden|unknown extension section not admitted/,
      "section " + id + " should fail directly, without the host engine");
  }
});

test("malformed section counts and truncated function body do not bypass preflight", () => {
  const missingBody = guest([0,0x42,42,0x0b]);
  // Section length and body length disagree.
  const tampered = Uint8Array.from(missingBody);
  const bodySizeIndex = tampered.length - 5;
  tampered[bodySizeIndex] = 0x7f;
  assert.throws(() => assertNoManagedWasm(tampered), /function body exceeds section/);
  assert.equal(WebAssembly.validate(tampered), false);
});

test("no-managed gate does not imply host Node/V8 garbage collection is disabled", () => {
  const bytes = guest();
  assert.doesNotThrow(() => assertNoManagedWasm(bytes));
  // The only validated claim is bounded, unmanaged guest linear memory.
  // Do not interpret this as a zero-GC whole-process assertion.
  assert.equal(admitCoreGuest(bytes).profile, "core-wasm.i64-v1");
});
