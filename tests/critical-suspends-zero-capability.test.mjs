import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";

// The capability checks must fail before attempting to inspect/instantiate
// deliberately malformed guest bytes. This is a host admission test, NOT an
// Oreslang source compiler, scheduler, or guest critical runtime test.
const badWasm = new Uint8Array([1, 2, 3, 4]);

test("core Wasm denies every advertised critical gate until real lowering", () => {
  for (const criticalGateCount of [1, 2, -1, false, null, "0"]) {
    assert.throws(
      () => compileAdmittedCoreGuest(badWasm, {criticalGateCount}),
      /E_CRITICAL_UNLOWERED/
    );
  }
});

test("core Wasm denies async generator frames without a native continuation", () => {
  for (const asyncGeneratorFrames of [1, -1, false, null, "0"]) {
    assert.throws(
      () => compileAdmittedCoreGuest(badWasm, {asyncGeneratorFrames}),
      /E_ASYNC_GENERATOR_UNLOWERED/
    );
  }
});

test("Wasm never accepts a suspending critical body policy", () => {
  for (const suspendingCriticalBodies of [true, 1, 0, null, "false"]) {
    assert.throws(
      () => compileAdmittedCoreGuest(badWasm, {suspendingCriticalBodies}),
      /E_CRITICAL_SUSPENSION/
    );
  }
});

test("zero-valued capabilities cannot bypass Wasm binary validation", () => {
  assert.throws(
    () => compileAdmittedCoreGuest(badWasm, {
      criticalGateCount: 0, asyncGeneratorFrames: 0,
      suspendingCriticalBodies: false
    }),
    // The malformed module still fails existing byte-level admission.
    /invalid|Wasm|module|magic|signature|bytes|header/i
  );
});
