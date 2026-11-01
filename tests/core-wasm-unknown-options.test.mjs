import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

const unsupported = [
  "tenantId", "tenant", "isolateId", "actorId", "permissions",
  "capabilities", "wasmtimeStore", "actorPlacement"
];

test("scalar guest admission rejects every unsupported tenant/capability authority", () => {
  for (const key of unsupported) {
    assert.throws(() => compileAdmittedCoreGuest(null, {[key]: "tenant-a"}),
      /unsupported core Wasm guest admission option/, key);
  }
});

test("Node worker refuses unsupported tenant/capability authorities before starting", async () => {
  for (const key of unsupported) {
    await assert.rejects(runIsolatedCoreGuest(null, {[key]: "tenant-a"}),
      /unsupported core Wasm isolated runner option/, key);
  }
});

test("nonenumerable and symbol placement options cannot bypass admission", async () => {
  const hidden = {};
  Object.defineProperty(hidden, "tenantId", {value: "tenant-a", enumerable: false});
  const symbol = {[Symbol("tenantId")]: "tenant-a"};
  for (const options of [hidden, symbol]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /unsupported core Wasm guest admission option/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /unsupported core Wasm isolated runner option/);
  }
});

test("known scalar options still progress to ordinary input validation", async () => {
  assert.throws(() => compileAdmittedCoreGuest(null, {entry: "main"}),
    /expected core WebAssembly bytes/);
  await assert.rejects(runIsolatedCoreGuest(null, {timeoutMs: 100}),
    /expected core WebAssembly bytes/);
});

test("malformed options fail before byte admission", async () => {
  for (const options of [null, [], "tenant-a"]) {
    assert.throws(() => compileAdmittedCoreGuest(null, options),
      /options must be an object/);
    await assert.rejects(runIsolatedCoreGuest(null, options),
      /options must be an object/);
  }
});
