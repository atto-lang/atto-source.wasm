import test from "node:test";
import assert from "node:assert/strict";
import {OresVM} from "../src/tenant-vm.mjs";

// clang17 wasm32 freestanding: volatile counter; fixed memory 2..2 pages,
// no imports, main() -> i64. NOT compiled from Oreslang source.
const COUNTER = Buffer.from(
 "AGFzbQEAAAABBQFgAAF+AwIBAAQFAXABAQEFBAEBAgIGCAF/AUGQiAQLBxECBm1lbW9yeQIABG1haW4AAAofAR0BAX5BAEEAKQOAiICAAEIBfCIANwOAiICAACAACwA9BG5hbWUAGRh0ZW5hbnRfY291bnRlcl93YXNtLndhc20BBwEABG1haW4HEgEAD19fc3RhY2tfcG9pbnRlcgB/CXByb2R1Y2VycwEMcHJvY2Vzc2VkLWJ5AQVjbGFuZ18xNy4wLjAgKGh0dHBzOi8vZ2l0aHViLmNvbS9zd2lmdGxhbmcvbGx2bS1wcm9qZWN0LmdpdCAxMDk5OWI2ZDAzNGZlMzE4ZjNkNTZjODNiZGRiNjU3MjU5M2E4YmIwKQBJD3RhcmdldF9mZWF0dXJlcwQrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dA==",
 "base64"
);
test("real disposable Wasm workers get separate fresh linear memory", async () => {
  const vm = new OresVM({maxTenants:2,maxWorkers:2});
  const a = vm.createIsolate({tenantId:"a",maxWorkers:1});
  const b = vm.createIsolate({tenantId:"b",maxWorkers:1});
  vm.start(a);vm.start(b);
  // The same Wasm instance would return 1 then 2. Distinct workers should
  // each return 1. Tenant globals are NOT persistent across calls yet.
  const [one,other]=await Promise.all([vm.runGuest(a,COUNTER),vm.runGuest(b,COUNTER)]);
  assert.equal(one.value,1n);assert.equal(other.value,1n);
  assert.equal((await vm.runGuest(a,COUNTER)).value,1n);
  assert.equal(vm.snapshot(a).activeWorkers,0);
  assert.equal(vm.snapshot(b).activeWorkers,0);
  vm.beginShutdown(a);vm.completeShutdown(a);vm.destroy(a);
  vm.beginShutdown(b);vm.completeShutdown(b);vm.destroy(b);
});
test("guest failures release worker slots without corrupting other tenants", async () => {
  const vm = new OresVM({maxWorkers:1});
  const a = vm.createIsolate({tenantId:"a"});
  const b = vm.createIsolate({tenantId:"b"});
  vm.start(a);vm.start(b);
  await assert.rejects(vm.runGuest(a,COUNTER,{expectedSha256:"0".repeat(64)}),
    /guest rejected|SHA-256|mismatch/);
  assert.equal(vm.snapshot(a).activeWorkers,0);
  assert.equal((await vm.runGuest(b,COUNTER)).value,1n);
  assert.equal((await vm.runGuest(a,COUNTER)).value,1n);
  vm.beginShutdown(a);vm.completeShutdown(a);vm.destroy(a);
  vm.beginShutdown(b);vm.completeShutdown(b);vm.destroy(b);
});
