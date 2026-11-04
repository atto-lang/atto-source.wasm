import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('./attoxp-scalar-parity.test.mjs', import.meta.url));
function launch(required) {
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  delete env.ORESLANG_LLVM_COMPILER;
  delete env.ORESLANG_LLVM_COMPILER_SHA256;
  delete env.ORESLANG_LLVM_SOURCE_SHA;
  delete env.ORESLANG_REQUIRE_REAL_COMPILER;
  if (required) env.ORESLANG_REQUIRE_REAL_COMPILER = '1';
  return spawnSync(process.execPath, [
    '--test',
    '--test-name-pattern=AttoXP four compiler-produced scalar guests',
    target
  ], {env, encoding:'utf8', timeout:20000, maxBuffer:1024*1024});
}
test('AttoXP required Wasm guest job cannot silently skip without compiler', () => {
  const result = launch(true);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0, 'required guest run must fail closed');
  assert.match(result.stdout + result.stderr,
    /requires ORESLANG_LLVM_COMPILER; cannot skip Wasm guest/);
});
test('AttoXP optional local guest job is explicitly skipped without compiler', () => {
  const result = launch(false);
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /# SKIP/);
});
