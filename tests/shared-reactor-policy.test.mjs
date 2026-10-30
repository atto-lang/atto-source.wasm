import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {admitSharedReactorOptions} from "../src/shared-reactor-policy.mjs";
import {runIsolatedCoreGuest} from "../src/isolated-runner.mjs";

test("shared reactor requests fail before guest decoding/compilation", () => {
  for (const options of [
    {schedulerMode: "shared"}, {schedulerMode: "dedicated"}, {schedulerMode: null},
    {schedulerWorkers: 1}, {schedulerWorkers: 2}, {schedulerWorkers: 3},
    {schedulerWorkers: -1}, {schedulerWorkers: "0"}, {schedulerWorkers: NaN},
    {schedulerWorkersMax: 1}, {schedulerWorkersMax: 256}, {schedulerWorkersMax: null}
  ]) {
    assert.throws(() => compileAdmittedCoreGuest(new Uint8Array([0]), options),
      /shared reactor workers are unsupported/);
  }
});
test("public isolated runner rejects workers before worker allocation", async () => {
  for (const options of [{schedulerMode: "shared"}, {schedulerWorkers: 2}, {schedulerWorkersMax: 4}]) {
    await assert.rejects(runIsolatedCoreGuest(new Uint8Array([0]), options),
      /shared reactor workers are unsupported/);
  }
});
test("host scalar mode allocates no pool and preserves ordinary byte validation", () => {
  assert.equal(admitSharedReactorOptions(), undefined);
  assert.equal(admitSharedReactorOptions({schedulerMode: "host", schedulerWorkers: 0, schedulerWorkersMax: 0}), undefined);
  assert.throws(() => compileAdmittedCoreGuest(new Uint8Array([0])),
    error => !/shared reactor workers/.test(error.message));
});
test("default isolated scalar execution still runs and terminates its guest worker", async () => {
  const bytes = Uint8Array.from([
    0x00,0x61,0x73,0x6d,0x01,0x00,0x00,0x00,
    0x01,0x05,0x01,0x60,0x00,0x01,0x7e,0x03,0x02,0x01,0x00,
    0x05,0x04,0x01,0x01,0x01,0x01,0x07,0x11,0x02,
    0x04,0x6d,0x61,0x69,0x6e,0x00,0x00,
    0x06,0x6d,0x65,0x6d,0x6f,0x72,0x79,0x02,0x00,
    0x0a,0x06,0x01,0x04,0x00,0x42,0x2a,0x0b
  ]);
  const result = await runIsolatedCoreGuest(bytes);
  assert.equal(result.value, 42n);
  assert.equal(result.admission.hostCapabilities, 0);
});
