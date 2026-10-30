import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {admitSharedReactorOptions} from "../src/shared-reactor-policy.mjs";

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
test("host scalar mode allocates no pool and preserves ordinary byte validation", () => {
  assert.equal(admitSharedReactorOptions(), undefined);
  assert.equal(admitSharedReactorOptions({schedulerMode: "host", schedulerWorkers: 0, schedulerWorkersMax: 0}), undefined);
  assert.throws(() => compileAdmittedCoreGuest(new Uint8Array([0])),
    error => !/shared reactor workers/.test(error.message));
});
