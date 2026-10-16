import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const target = fileURLToPath(new URL("./value-boundaries.test.mjs", import.meta.url));

function testRealCompilerAdmission(required) {
  const env = {...process.env};
  delete env.ORESLANG_LLVM_COMPILER;
  delete env.ORESLANG_LLVM_COMPILER_SHA256;
  delete env.ORESLANG_LLVM_SOURCE_SHA;
  delete env.ORESLANG_REQUIRE_REAL_COMPILER;
  if (required) env.ORESLANG_REQUIRE_REAL_COMPILER = "1";
  return spawnSync(process.execPath, [
    "--test",
    "--test-name-pattern=real source value boundaries reject before publishing a Wasm artifact",
    target
  ], {env, encoding: "utf8", timeout: 15000, maxBuffer: 1024*1024});
}

test("real compiler parity opt-in fails closed without a compiler", () => {
  const run = testRealCompilerAdmission(true);
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  assert.notEqual(run.status, 0, "required native parity cannot be skipped");
  assert.match(run.stdout + run.stderr,
    /never skip required guest execution/);
});

test("ordinary unit tests may skip unavailable optional real compiler", () => {
  const run = testRealCompilerAdmission(false);
  assert.ifError(run.error);
  assert.equal(run.signal, null);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /# SKIP/);
});
