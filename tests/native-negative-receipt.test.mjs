// All evidence in this file is intentionally synthetic; no compiler executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  NEGATIVE_FIXTURES, POSITIVE_FIXTURE,
  evaluateNativeNegativeReceipt, readNativeNegativeReceipt
} from '../scripts/verify-native-negative-receipt.mjs';

const H = n => (n===64?'e':'a').repeat(n);
const context = () => ({
  GITHUB_ACTIONS:'true',
  GITHUB_REF_PROTECTED:'true',
  GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REPOSITORY:'ores-truffle-oreslang/oreslang-source.wasm',
  GITHUB_REF:'refs/heads/main',
  GITHUB_JOB:'integration',
  GITHUB_SHA:'a'.repeat(40),
  GITHUB_RUN_ID:'1001',
  GITHUB_RUN_ATTEMPT:'2',
  ORESLANG_BOOL_WASM_EXPECTED_HEAD:'a'.repeat(40),
  ORESLANG_BOOL_WASM_SOURCE_TREE:'b'.repeat(40),
  ORESLANG_LLVM_SOURCE_SHA:'c'.repeat(40),
  ORESLANG_LLVM_SOURCE_TREE:'d'.repeat(40),
  ORESLANG_LLVM_COMPILER_SHA256:H(64)
});
function receipt(c=context()) {
  return {
    schema:'atto.native-negative.frontend/1',
    classification:'COMPILER_FRONTEND_ONLY',
    result:'EXECUTED',guestExecuted:false,guestAotCertified:false,hostOnly:false,
    wasmHead:c.GITHUB_SHA,wasmTree:c.ORESLANG_BOOL_WASM_SOURCE_TREE,
    llvmHead:c.ORESLANG_LLVM_SOURCE_SHA,llvmTree:c.ORESLANG_LLVM_SOURCE_TREE,
    compilerSha256:c.ORESLANG_LLVM_COMPILER_SHA256,
    runId:c.GITHUB_RUN_ID,runAttempt:c.GITHUB_RUN_ATTEMPT,jobId:c.GITHUB_JOB,
    positive:{
      id:POSITIVE_FIXTURE[0],sourceGitBlob:POSITIVE_FIXTURE[1],
      sourceSha256:'1'.repeat(64),llvmIrSha256:'2'.repeat(64),
      compilerExit:0,signal:null,emittedIr:true,stdoutBytes:713,nativeCompiler:true
    },
    negatives:NEGATIVE_FIXTURES.map(([id,sourceGitBlob,diagnostic],i)=>({
      id,sourceGitBlob,sourceSha256:String(i+3).repeat(64),
      diagnostic,compilerExit:1,signal:null,stdoutBytes:0,
      emittedIr:false,nativeCompiler:true,
      compilerSha256:c.ORESLANG_LLVM_COMPILER_SHA256,
      runAttempt:c.GITHUB_RUN_ATTEMPT,jobId:c.GITHUB_JOB
    }))
  };
}
const rejected = (r,c=context()) =>
  assert.equal(evaluateNativeNegativeReceipt(r,c).classification,'NOT_VERIFIED');

test('synthetic positive control remains explicitly uncertified',()=>{
  const output=evaluateNativeNegativeReceipt(receipt(),context());
  assert.equal(output.classification,'LOCAL_NATIVE_FRONTEND_CASES_RECORDED');
  assert.equal(output.caseCount,5);
  assert.equal(output.positiveControlCount,1);
  assert.equal(output.compilerExecutionCertified,false);
  assert.equal(output.guestAotCertified,false);
  assert.equal(output.exportAuthorized,false);
});
test('Node host-like process.env object accepted without weakening receipt checks',()=>{
  const env=Object.assign(Object.create(null),context());
  assert.equal(evaluateNativeNegativeReceipt(receipt(env),env).classification,
    'LOCAL_NATIVE_FRONTEND_CASES_RECORDED');
  rejected({...receipt(),result:'SKIPPED'},env);
});
test('missing protected main or wrong repository/event/job is rejected',()=>{
  for(const [key,value] of [
    ['GITHUB_ACTIONS','false'],
    ['GITHUB_REF_PROTECTED','false'],
    ['GITHUB_EVENT_NAME','pull_request'],
    ['GITHUB_REF','refs/heads/feature'],
    ['GITHUB_REPOSITORY','attacker/clone'],
    ['GITHUB_JOB','test']
  ]) rejected(receipt(),{...context(),[key]:value});
});
test('missing, stale or malformed source/compiler/run context rejected',()=>{
  for(const [key,value] of [
    ['GITHUB_SHA','a'.repeat(39)],
    ['ORESLANG_BOOL_WASM_EXPECTED_HEAD','f'.repeat(40)],
    ['ORESLANG_BOOL_WASM_SOURCE_TREE','0'.repeat(40)],
    ['ORESLANG_LLVM_SOURCE_SHA','A'.repeat(40)],
    ['ORESLANG_LLVM_SOURCE_TREE','0'.repeat(40)],
    ['ORESLANG_LLVM_COMPILER_SHA256','a'.repeat(40)],
    ['GITHUB_RUN_ID','0'],
    ['GITHUB_RUN_ATTEMPT','']
  ]) rejected(receipt(),{...context(),[key]:value});
});
test('host-only, skipped, fabricated guest AOT and wrong schema rejected',()=>{
  for(const [key,value] of [
    ['schema','arbitrary'],
    ['classification','HOST_ONLY'],
    ['result','SKIPPED'],
    ['result','NOT_EXECUTED'],
    ['guestExecuted',true],
    ['guestAotCertified',true],
    ['hostOnly',true]
  ]) rejected({...receipt(),[key]:value});
});
test('receipt cannot be replayed against another attempt, job or binary',()=>{
  for(const [key,value] of [
    ['wasmHead','f'.repeat(40)],
    ['wasmTree','f'.repeat(40)],
    ['llvmHead','f'.repeat(40)],
    ['llvmTree','f'.repeat(40)],
    ['compilerSha256','f'.repeat(64)],
    ['runId','1002'],
    ['runAttempt','1'],
    ['jobId','different']
  ]) rejected({...receipt(),[key]:value});
});
test('all five required native negatives are present in canonical order',()=>{
  const r=receipt();r.negatives.pop();rejected(r);
  const s=receipt();s.negatives.reverse();rejected(s);
  const t=receipt();t.negatives[1]={...t.negatives[0]};rejected(t);
  const u=receipt();u.negatives.push({...u.negatives[0]});rejected(u);
});
test('every negative case rejects wrong diagnostic, status and IR leakage',()=>{
  for(let i=0;i<NEGATIVE_FIXTURES.length;i++) {
    for(const [key,value] of [
      ['compilerExit',0],['compilerExit',2],['signal','SIGKILL'],
      ['stdoutBytes',1],['emittedIr',true],['nativeCompiler',false],
      ['diagnostic','generic parser error'],['sourceGitBlob','0'.repeat(40)],
      ['sourceSha256','0'.repeat(64)],
      ['compilerSha256','f'.repeat(64)],['runAttempt','1'],['jobId','other']
    ]) {
      const r=receipt();r.negatives[i]={...r.negatives[i],[key]:value};
      rejected(r);
    }
  }
});
test('positive compiler-owned IR control must be nonempty and correctly pinned',()=>{
  for(const [key,value] of [
    ['id','fake-guest'],['sourceGitBlob','0'.repeat(40)],
    ['sourceSha256','0'.repeat(64)],['llvmIrSha256','0'.repeat(64)],
    ['compilerExit',1],['signal','SIGABRT'],['stdoutBytes',0],
    ['emittedIr',false],['nativeCompiler',false]
  ]) {
    const r=receipt();r.positive[key]=value;rejected(r);
  }
});
test('non-object receipts and missing nested cases fail closed',()=>{
  for(const r of [null,[],42,'success',{}, {positive:{},negatives:[]}])
    rejected(r);
  const r=receipt();r.negatives[0]=null;rejected(r);
  const s=receipt();s.positive=null;rejected(s);
});
test('regular receipt JSON reads; directories, symlinks and oversized data rejected',()=>{
  const root=mkdtempSync(join(tmpdir(),'atto-source-free-receipt-'));
  try {
    const file=join(root,'receipt.json'),link=join(root,'link.json'),big=join(root,'big.json');
    writeFileSync(file,JSON.stringify(receipt()));
    assert.deepEqual(readNativeNegativeReceipt(file),receipt());
    symlinkSync(file,link);
    assert.throws(()=>readNativeNegativeReceipt(link));
    assert.throws(()=>readNativeNegativeReceipt(root));
    writeFileSync(big,'x'.repeat(65537));
    assert.throws(()=>readNativeNegativeReceipt(big));
    assert.throws(()=>readNativeNegativeReceipt(''));
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('source-free synthetic fixture manifest has distinct case IDs/blobs',()=>{
  const ids=[...NEGATIVE_FIXTURES.map(c=>c[0]),POSITIVE_FIXTURE[0]];
  const shas=[...NEGATIVE_FIXTURES.map(c=>c[1]),POSITIVE_FIXTURE[1]];
  assert.equal(new Set(ids).size,6);
  assert.equal(new Set(shas).size,6);
  assert.ok(shas.every(s=>/^[0-9a-f]{40}$/.test(s)));
});
