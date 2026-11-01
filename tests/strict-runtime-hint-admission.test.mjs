import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

// These are authorization hints, not optional cosmetic metadata: silently
// ignoring any of them would falsely claim CPU, actor, or I/O isolation.
const unsupported = [
  {cpuAffinity: 0}, {cpuSet: [0, 1]}, {numaNode: 0},
  {preferredCpu: 0}, {preferredCache: "package0:llc0"},
  {actorPhysicalTurns: 1}, {hardRealtime: true},
  {guestNetworkIo: true}, {nioReactors: 1}, {ioMode: "blocking"},
  {schedulerAffinity: "hard"}, {schedulerMode: "shared"},
];

test("compiled scalar guest refuses all unsupported placement/actor/I/O hints before decoding", () => {
  const malformedGuest = new Uint8Array([0]);
  for (const options of unsupported) {
    assert.throws(() => compileAdmittedCoreGuest(malformedGuest, options),
      /unsupported|shared reactor/, JSON.stringify(options));
  }
});
test("isolated scalar guest refuses hints before constructing Worker", async () => {
  const malformedGuest = new Uint8Array([0]);
  for (const options of unsupported) {
    await assert.rejects(runIsolatedCoreGuest(malformedGuest, options),
      /unsupported|shared reactor/, JSON.stringify(options));
  }
});
test("accessor options and non-plain options fail without invoking getters", async () => {
  let reads = 0;
  const getter = {};
  Object.defineProperty(getter, "schedulerWorkers", {
    enumerable: true, get() { reads++; return 0; }
  });
  const inherited = Object.create({cpuAffinity: 0});
  const invalid = [getter, inherited, null, [], "host", { [Symbol("cpu")]: 1 }];
  for (const options of invalid) {
    assert.throws(() => compileAdmittedCoreGuest(new Uint8Array([0]), options), TypeError);
    await assert.rejects(runIsolatedCoreGuest(new Uint8Array([0]), options), TypeError);
  }
  assert.equal(reads, 0);
});
test("allowed scalar options still reach normal byte validation", async () => {
  const options = {schedulerMode:"host", schedulerWorkers:0, schedulerWorkersMax:0};
  assert.throws(() => compileAdmittedCoreGuest(new Uint8Array([0]), options),
    error => !/unsupported core-wasm guest option/.test(String(error)));
  await assert.rejects(runIsolatedCoreGuest(new Uint8Array([0]), options),
    error => !/unsupported core-wasm guest option/.test(String(error)));
});
