import test from "node:test";
import assert from "node:assert/strict";
import {admitCoreGuest, compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// These tests deliberately use invalid guest bytes: invalid options must be
// rejected BEFORE any guest snapshot, compilation, worker or host I/O.
function forbiddenOptions() {
  let accessorRuns = 0;
  const getter = Object.defineProperty({}, "entry", {
    enumerable: true, get() { accessorRuns++; return "main"; }
  });
  return {
    getAccessorRuns: () => accessorRuns,
    values: [
      {permissions: {net: ["api.example.com:443"]}},
      {allowNet: ["api.example.com:443"]},
      Object.defineProperty({}, "allowRead", {value: ["/workspace"], enumerable: false}),
      {[Symbol("allowFfi")]: true},
      getter,
      Object.create({allowRun: ["git"]}),
      Object.create({entry: "main"}),
      ["entry"],
      42,
      null
    ]
  };
}

test("admission API rejects hidden, symbol, inherited, accessor host options", () => {
  const {values, getAccessorRuns} = forbiddenOptions();
  for (const options of values) {
    assert.throws(() => admitCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
  }
  assert.equal(getAccessorRuns(), 0, "no user-controlled accessors executed");
});

test("isolated runner rejects hidden and inherited permissions before starting worker", async () => {
  const {values, getAccessorRuns} = forbiddenOptions();
  for (const options of values) {
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /zero-capability guest option|guest options must/);
  }
  assert.equal(getAccessorRuns(), 0, "no option getters executed");
});

test("valid supported options retain normal snapshot validation path", async () => {
  const options = Object.assign(Object.create(null), {entry: "main"});
  assert.throws(() => admitCoreGuest(null, options), /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, {timeoutMs: 1000}),
    /expected core WebAssembly bytes/);
});

test("only isolated runner admits the timeout option", () => {
  assert.throws(() => admitCoreGuest(null, {timeoutMs: 1000}),
    /unsupported zero-capability guest option/);
});
