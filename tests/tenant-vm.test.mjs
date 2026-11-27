import test from "node:test";
import assert from "node:assert/strict";
import {OresVM} from "../src/tenant-vm.mjs";

// Real no-import Wasm module: bounded memory 1..1 pages and main() -> i64 42.
const PURE_CORE = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,126, 3,2,1,0,
  5,4,1,1,1,1, 7,17,2,
  4,109,97,105,110,0,0, 6,109,101,109,111,114,121,2,0,
  10,6,1,4,0,66,42,11
]);

test("two tenant VM handles execute separate admitted worker guests", async () => {
  const vm = new OresVM({maxTenants: 2, maxWorkers: 2});
  const a = vm.createIsolate({tenantId: "tenant-a"});
  const b = vm.createIsolate({tenantId: "tenant-b"});
  assert.throws(() => vm.createIsolate({tenantId:"tenant-c"}), /quota/);
  assert.throws(() => vm.createIsolate({tenantId:"tenant-a"}), /duplicate/);
  vm.start(a); vm.start(b);
  const results = await Promise.all([vm.runGuest(a, PURE_CORE), vm.runGuest(b, PURE_CORE)]);
  assert.equal(results[0].value, 42n);
  assert.equal(results[1].value, 42n);
  assert.equal(vm.snapshot(a).activeWorkers, 0);
  vm.beginShutdown(a);
  await assert.rejects(vm.runGuest(a, PURE_CORE), /admission/);
  assert.equal((await vm.runGuest(b, PURE_CORE)).value, 42n);
  vm.completeShutdown(a); vm.destroy(a);
  assert.throws(() => vm.snapshot(a), /stale/);
  const a2 = vm.createIsolate({tenantId:"tenant-a"});
  assert.notEqual(a2.generation, a.generation);
  vm.start(a2);
  assert.equal((await vm.runGuest(a2, PURE_CORE)).value,42n);
  vm.beginShutdown(a2); vm.completeShutdown(a2); vm.destroy(a2);
  vm.beginShutdown(b); vm.completeShutdown(b); vm.destroy(b);
});

test("worker quotas and shutdown pin until real worker termination", async () => {
  const vm = new OresVM({maxWorkers:1});
  const a = vm.createIsolate({tenantId:"busy"}); vm.start(a);
  const running = vm.runGuest(a, PURE_CORE);
  assert.equal(vm.snapshot(a).activeWorkers,1);
  await assert.rejects(vm.runGuest(a, PURE_CORE), /quota/);
  vm.beginShutdown(a);
  assert.throws(() => vm.completeShutdown(a), /active/);
  assert.equal((await running).value,42n);
  vm.completeShutdown(a); vm.destroy(a);
});

test("isolate capabilities are identity-based, not reconstructible", () => {
  const vm = new OresVM();
  const a = vm.createIsolate({tenantId:"s"});
  assert.throws(() => vm.start({...a}), /stale/);
  assert.throws(() => new OresVM().start(a), /stale/);
  vm.beginShutdown(a); vm.completeShutdown(a); vm.destroy(a);
  assert.throws(() => vm.start(a), /stale/);
});
