// All evidence in this file is intentionally synthetic; no compiler executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  NEGATIVE_FIXTURES, POSITIVE_FIXTURE,
  evaluateNativeNegativeReceipt, readNativeNegativeReceipt
} from '../scripts/verify-native-negative-receipt.mjs';

const H = n => (n===64?'e':'a').repeat(n);
const cleanChildEnv = () => {
  const env={...process.env,...context()};
  delete env.NODE_TEST_CONTEXT;
  return env;
};
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
test('receipt file reader rejects duplicate keys, ambiguous encoding and noncanonical JSON',()=>{
  const root=mkdtempSync(join(tmpdir(),'atto-ambiguous-negative-receipt-'));
  const file=join(root,'receipt.json');
  try {
    const valid=JSON.stringify(receipt());
    // Source-owned compiler writer emits one LF; this remains admissible.
    writeFileSync(file,valid+'\n');
    assert.deepEqual(readNativeNegativeReceipt(file),receipt());
    const forged=[
      valid.replace('"result":"EXECUTED"',
        '"result":"NOT_EXECUTED","result":"EXECUTED"'),
      valid.replace('"compilerExit":1',
        '"compilerExit":0,"compilerExit":1'),
      valid.replace('"result":"EXECUTED"',
        '"res\\u0075lt":"NOT_EXECUTED","result":"EXECUTED"'),
      JSON.stringify(receipt(),null,2),
      '\ufeff'+valid,
    ];
    for(const raw of forged){
      assert.notEqual(raw,valid,'mutation must actually change receipt bytes');
      writeFileSync(file,raw);
      assert.throws(()=>readNativeNegativeReceipt(file),
        /noncanonical|ambiguous|Unexpected|position|JSON/);
    }
    // Node Buffer.toString('utf8') silently substitutes replacement chars.
    writeFileSync(file,Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xc3,0x28,0x22,0x7d]));
    assert.throws(()=>readNativeNegativeReceipt(file),/encoded|UTF-8|valid|decode/i);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('source-free synthetic fixture manifest has distinct case IDs/blobs',()=>{
  const ids=[...NEGATIVE_FIXTURES.map(c=>c[0]),POSITIVE_FIXTURE[0]];
  const shas=[...NEGATIVE_FIXTURES.map(c=>c[1]),POSITIVE_FIXTURE[1]];
  assert.equal(new Set(ids).size,6);
  assert.equal(new Set(shas).size,6);
  assert.ok(shas.every(s=>/^[0-9a-f]{40}$/.test(s)));
});

test('actual Node CLI accepts synthetic receipt but never emits certification',()=>{
  const root=mkdtempSync(join(tmpdir(),'atto-native-negative-cli-'));
  try {
    const file=join(root,'receipt.json');
    writeFileSync(file,JSON.stringify(receipt()),{flag:'wx',mode:0o600});
    const cli=fileURLToPath(new URL('../scripts/verify-native-negative-receipt.mjs',import.meta.url));
    const env=cleanChildEnv();
    const run=(vars,path=file)=>spawnSync(process.execPath,[cli,path],{
      env:{...env,...vars},encoding:'utf8',timeout:10000,maxBuffer:64*1024
    });
    const ok=run({});
    assert.ifError(ok.error);
    assert.equal(ok.status,0,ok.stderr);
    assert.equal(JSON.parse(ok.stdout).classification,'LOCAL_NATIVE_FRONTEND_CASES_RECORDED');
    assert.equal(JSON.parse(ok.stdout).compilerExecutionCertified,false);
    assert.equal(JSON.parse(ok.stdout).guestAotCertified,false);
    const skipped=run({GITHUB_REF_PROTECTED:'false'});
    assert.equal(skipped.status,1);
    assert.equal(JSON.parse(skipped.stdout).classification,'NOT_VERIFIED');
    const absent=run({},join(root,'missing.json'));
    assert.equal(absent.status,2);
    assert.match(absent.stderr,/NOT_VERIFIED/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('workflow never gives private LLVM credential to PR-head execution',()=>{
  const file=fileURLToPath(new URL('../.github/workflows/real-llvm.yml',import.meta.url));
  const workflow=readFileSync(file,'utf8');
  assert.match(workflow,/on:\n  workflow_dispatch:/);
  assert.match(workflow,/github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow,/github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow,/github\.ref_protected/);
  assert.match(workflow,/GITHUB_REF_PROTECTED.*?true/);
  assert.match(workflow,/persist-credentials: false/);
  assert.match(workflow,/ATTO_NATIVE_NEGATIVE_REQUIRED: '1'/);
  assert.match(workflow,/npm run test:real-negative-frontend/);
  assert.match(workflow,/node scripts\/verify-native-negative-receipt\.mjs/);
  assert.ok(workflow.indexOf('Require authorized private LLVM read access') <
    workflow.indexOf('Check out immutable private LLVM compiler source'));
  assert.ok(workflow.indexOf('Check out immutable private LLVM compiler source') <
    workflow.indexOf('Require five compiler-owned negative rejections'));
});
test('CLI prevents forged host-only or skipped receipts from becoming a recorded check',()=>{
  const root=mkdtempSync(join(tmpdir(),'atto-negative-tamper-cli-'));
  try {
    const cli=fileURLToPath(new URL('../scripts/verify-native-negative-receipt.mjs',import.meta.url));
    for(const [kind,change] of [
      ['skipped',{result:'SKIPPED'}],
      ['host',{hostOnly:true}],
      ['guest-aot',{guestAotCertified:true}],
      ['missing-matrix',{negatives:[]}],
      ['wrong-attempt',{runAttempt:'1'}]
    ]) {
      const file=join(root,kind+'.json');
      writeFileSync(file,JSON.stringify({...receipt(),...change}));
      const run=spawnSync(process.execPath,[cli,file],{
        env:cleanChildEnv(),encoding:'utf8',timeout:10000,maxBuffer:64*1024
      });
      assert.ifError(run.error);
      assert.equal(run.status,1,kind);
      assert.equal(JSON.parse(run.stdout).classification,'NOT_VERIFIED');
    }
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('source-free PR workflow never has secrets or native compiler execution',()=>{
  const file=fileURLToPath(new URL('../.github/workflows/native-negative-source-free-pr.yml',import.meta.url));
  const workflow=readFileSync(file,'utf8');
  assert.match(workflow,/on:\n  pull_request:\n/);
  assert.match(workflow,/  push:\n    branches: \[main\]/);
  assert.match(workflow,/permissions:\n  contents: read/);
  assert.match(workflow,/ref: .*github\.event\.pull_request\.head\.sha/);
  assert.match(workflow,/persist-credentials: false/);
  assert.match(workflow,/ATTO_NATIVE_NEGATIVE_REQUIRED: '0'/);
  assert.match(workflow,/ATTO_NATIVE_NEGATIVE_REQUIRED: '1'/);
  assert.match(workflow,/REQUIRED_COMPILER_MISSING=EXPECTED_FAIL_CLOSED/);
  assert.match(workflow,/# tests 21/);
  assert.match(workflow,/# pass 20/);
  assert.match(workflow,/# skipped 1/);
  assert.doesNotMatch(workflow,/\bsecrets\.|ORESLANG_LLVM_READ_TOKEN|pull_request_target|workflow_run:|repository: ores-truffle-oreslang\/oreslang-source\.llvm/);
  assert.doesNotMatch(workflow,/npm run test:real-compiler|npm run test:real-negative-frontend/);
  assert.ok(workflow.indexOf('Checkout exact unprivileged PR head') <
    workflow.indexOf('Require exact host-only suite'));
});
