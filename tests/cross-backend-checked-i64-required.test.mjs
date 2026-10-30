import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const target=fileURLToPath(new URL("./cross-backend-checked-i64-scalar.test.mjs",import.meta.url));

function run(required){
  const env={...process.env};
  delete env.NODE_TEST_CONTEXT;
  delete env.ORESLANG_LLVM_COMPILER;
  delete env.ORESLANG_LLVM_COMPILER_SHA256;
  delete env.ORESLANG_LLVM_SOURCE_SHA;
  delete env.ORESLANG_REQUIRE_REAL_COMPILER;
  if(required) env.ORESLANG_REQUIRE_REAL_COMPILER="1";
  return spawnSync(process.execPath,[
    "--test",
    "--test-name-pattern=Math.abs negative",
    target
  ],{env,encoding:"utf8",timeout:15000,maxBuffer:1024*1024});
}

test("required Math parity cannot silently skip a missing compiler",()=>{
  const result=run(true);
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  assert.notEqual(result.status,0,"required Math parity unexpectedly skipped");
  assert.match(result.stdout+result.stderr,/never skip required Math parity/);
});

test("ordinary unit suites may keep the real compiler optional",()=>{
  const result=run(false);
  assert.ifError(result.error);
  assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stdout,/# SKIP/);
});
