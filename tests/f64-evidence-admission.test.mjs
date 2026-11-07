import test from "node:test";
import assert from "node:assert/strict";
import {assertApprovedLlvmF64Receipt,assertF64WorkerEvidence}
  from "../scripts/f64-evidence-admission.mjs";
const sha="a".repeat(40),tree="b".repeat(40),bin="c".repeat(64);
const pins={llvmSha:sha,llvmTree:tree,compilerSha256:bin};
function good(){
  return {schema:"atto-llvm-f64-source-execution-v1",
    sourceRepository:"ores-truffle-oreslang/oreslang-source.llvm",
    sourceCommitSha:sha,sourceRootTreeSha:tree,compilerBinarySha256:bin,
    ctestJUnitSha256:"d".repeat(64),
    executedTests:["native_f64_scalar_e2e","wasm_core_f64_entry_source_gate","native_float_ml"],
    runnerName:"approved-source-runner",runId:"4242",runAttempt:"1",
    execution:"EXECUTED",sourceToWasmWorker:"NOT_EXECUTED",
    javaParity:"NOT_CERTIFIED",release:"NOT_CERTIFIED"};
}
function worker(){
 return {schema:"atto-f64-wasm-worker-v1",compilerSha256:bin,
  sourceSha256:"d".repeat(64),wasmSha256:"e".repeat(64),
  releaseSha256:"f".repeat(64),profile:"core-wasm.f64-v1",
  entry:"main",value:3.75,hostImports:0,hostCapabilities:0,
  negativeNoPublication:true,execution:"EXECUTED",certification:"NOT_CERTIFIED"};
}
test("exact independently pinned real native source receipt",()=>{
  assert.equal(assertApprovedLlvmF64Receipt(good(),pins),true);
  assert.throws(()=>assertApprovedLlvmF64Receipt(good(),{}),/approval pins/);
  for(const [key,bad] of Object.entries({
    sourceCommitSha:"f".repeat(40),sourceRootTreeSha:"f".repeat(40),
    compilerBinarySha256:"f".repeat(64),ctestJUnitSha256:"oops",
    executedTests:["native_f64_scalar_e2e","native_float_ml"],
    execution:"NOT_EXECUTED",release:"CERTIFIED",runId:"0",
    sourceRepository:"attacker/other",sourceToWasmWorker:"EXECUTED"})){
    const forged={...good(),[key]:bad};
    assert.throws(()=>assertApprovedLlvmF64Receipt(forged,pins),
      /absent, stale, unexecuted/,key);
  }
  assert.throws(()=>assertApprovedLlvmF64Receipt(
    {...good(),extra:"allow"},pins),/fields invalid/);
  assert.throws(()=>assertApprovedLlvmF64Receipt(
    {...good(),executedTests:["native_float_ml","native_float_ml",
      "wasm_core_f64_entry_source_gate"]},pins),/absent, stale, unexecuted/);
});
test("Wasm f64 guest receipt requires executed zero-import source-built result",()=>{
  assert.equal(assertF64WorkerEvidence(worker(),bin),true);
  for(const [key,bad] of Object.entries({compilerSha256:"f".repeat(64),
    profile:"core-wasm.i64-v1",value:42,hostImports:1,
    hostCapabilities:1,negativeNoPublication:false,
    execution:"NOT_EXECUTED",release:"CERTIFIED"})){
    const altered={...worker(),[key]:bad};
    assert.throws(()=>assertF64WorkerEvidence(altered,bin),
      /real f64 Worker evidence|fields invalid/,key);
  }
});
