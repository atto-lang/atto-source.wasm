import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

// Run only the numerical guest source test in the child, not this admission
// test itself. The pinned LLVM compiler is deliberately absent: a dedicated
// parity check must fail rather than quietly count a skip as success.
const target=fileURLToPath(new URL("./numeric-source-parity.test.mjs",import.meta.url));

test("required numeric parity fails closed with no trusted LLVM compiler",()=>{
  const env={...process.env,ORESLANG_NUMERIC_PARITY_REQUIRED:"1"};
  delete env.ORESLANG_LLVM_COMPILER;
  delete env.ORESLANG_LLVM_COMPILER_SHA256;
  delete env.ORESLANG_LLVM_SOURCE_SHA;
  const result=spawnSync(process.execPath,["--test",target],{
    env,encoding:"utf8",timeout:15000,maxBuffer:256*1024
  });
  assert.equal(result.error,undefined);
  assert.notEqual(result.status,0,"required parity must not pass without compiler");
  assert.match(result.stdout+result.stderr,
    /numeric parity required: pinned real Oreslang LLVM compiler is missing/);
  assert.doesNotMatch(result.stdout,/\bnot ok 0\b/,
    "failed required parity cannot be presented as zero executed cases");
});
