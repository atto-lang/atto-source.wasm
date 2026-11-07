import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {assessBooleanWasmEvidence, BOOLEAN_CASES, BOOLEAN_SOURCE_SHA256}
  from '../scripts/verify-boolean-wasm-evidence.mjs';
const head='a'.repeat(40),tree='b'.repeat(40),digest='c'.repeat(64);
const positiveSteps = [
  'Require authorized private LLVM read access',
  'Check out Wasm backend',
  'Bind protected Wasm main checkout',
  'Check out immutable private LLVM compiler source',
  'Verify exact LLVM source commit',
  'Compile exact LLVM compiler checkout',
  'Pin actual native compiler binary',
  'Run WebAssembly regression suite',
  'Execute genuine Oreslang-to-Wasm end-to-end gate',
  'Execute mandatory pinned boolean Wasm32 guest and type rejection matrix',
  'Upload source-bound boolean guest evidence (not Java certification)',
];
function fixture() {
  const cases=BOOLEAN_CASES.map(([id,kind,value,blob])=>({
    id,kind:kind==='execute'?'EXECUTED_WASM32_GUEST':'NATIVE_LLVM_TYPE_REJECTION',
    sourceGitBlob:blob,sourceSha256:BOOLEAN_SOURCE_SHA256[id],
    ...(kind==='execute'?{wasmSha256:digest,expected:value,observed:value,
      imports:0,hostCapabilities:0}:{diagnostic:value,exitStatus:1,
      emittedLLVM:false,publishedArtifact:false}),
  }));
  return {
    expectedHead:head,expectedTree:tree,
    receipt: {schema:'atto-boolean-wasm32-guest-evidence-v1',
      classification:'EXECUTED_WASM32_GUEST_AND_NATIVE_FRONTEND_REJECTIONS',
      wasm:{repository:'ores-truffle-oreslang/oreslang-source.wasm',head,tree},
      llvm:{repository:'ores-truffle-oreslang/oreslang-source.llvm',
        sourceHeadMetadata:'b83f540269a256e549cc9160b6b43bf37d33fb0f',
        sourceTreeMetadata:'26e85b258061b206e4a145825df6dfe11065a499',
        compilerSha256:digest,referenceTestGitBlob:'80056fbf9d67e3fb37a052652398c2dc3796540b'},
      executedGuests:6,nativeFrontendRejections:5,cases,
      javaDifferential:'NOT_EXECUTED',fiveBackendCertification:'NOT_CERTIFIED'},
    run:{id:123,run_attempt:2,workflow_id:456,
      repository:{id:1419858954,full_name:'ores-truffle-oreslang/oreslang-source.wasm'},
      head_repository:{id:1419858954,full_name:'ores-truffle-oreslang/oreslang-source.wasm'},
      head_sha:head,head_branch:'main',event:'workflow_dispatch',
      name:'Real pinned Oreslang LLVM to Wasm gate',
      path:'ores-truffle-oreslang/oreslang-source.wasm/.github/workflows/real-llvm.yml@refs/heads/main',
      status:'completed',conclusion:'success'},
    jobs:{jobs:[{id:987,run_id:123,run_attempt:2,head_sha:head,head_branch:'main',
      workflow_name:'Real pinned Oreslang LLVM to Wasm gate',
      name:'integration',status:'completed',conclusion:'success',
      runner_id:789,runner_name:'GitHub Actions 1',started_at:'2026-11-07T12:00:00Z',
      completed_at:'2026-11-07T12:01:00Z',steps:positiveSteps.map((name,i)=>({
        name,number:i+1,status:'completed',conclusion:'success',
        started_at:'2026-11-07T12:00:00Z',completed_at:'2026-11-07T12:01:00Z'}))}]},
    artifacts:{artifacts:[{id:222,name:'boolean-wasm32-guest-evidence-123-2',
      size_in_bytes:1000,expired:false,workflow_run:{id:123,head_sha:head}}]},
  };
}
function mutate(testName,fn) {
  test(testName,()=>{const d=fixture();fn(d);assert.throws(()=>assessBooleanWasmEvidence(d));});
}
test('complete input is only a consistent *untrusted* record, never certified',()=>{
  const r=assessBooleanWasmEvidence(fixture());
  assert.equal(r.status,'CONSISTENT_UNTRUSTED_EXECUTION_RECORDS');
  assert.equal(r.releaseCertification,'NOT_CERTIFIED');
  assert.equal(r.javaDifferential,'NOT_EXECUTED');
});
mutate('reject zero-step run', d => {d.jobs.jobs[0].steps=null;});
mutate('reject run without runner identity',d=>{d.jobs.jobs[0].runner_id=null;});
mutate('reject failed guest step',d=>{d.jobs.jobs[0].steps[9].conclusion='failure';});
mutate('reject skipped guest step',d=>{d.jobs.jobs[0].steps[9].conclusion='skipped';});
mutate('reject omitted compiler source checkout',d=>{d.jobs.jobs[0].steps.splice(3,1);});
mutate('reject duplicate guest step',d=>{d.jobs.jobs[0].steps.push({...d.jobs.jobs[0].steps[9]});});
mutate('reject non-main workflow',d=>{d.run.head_branch='feature';});
mutate('reject PR-triggered workflow',d=>{d.run.event='pull_request';});
mutate('reject forged workflow path',d=>{d.run.path='x/.github/workflows/untrusted.yml@refs/heads/main';});
mutate('reject run without exact source HEAD',d=>{d.run.head_sha='d'.repeat(40);});
mutate('reject receipt without exact tree',d=>{d.receipt.wasm.tree='e'.repeat(40);});
mutate('reject unpinned compiler hash',d=>{d.receipt.llvm.compilerSha256='';});
mutate('reject wrong pinned LLVM tree',d=>{d.receipt.llvm.sourceTreeMetadata='d'.repeat(40);});
mutate('reject wrong LLVM test source blob',d=>{d.receipt.llvm.referenceTestGitBlob='d'.repeat(40);});
mutate('reject missing guest result',d=>{d.receipt.cases.splice(0,1);});
mutate('reject changed guest result',d=>{d.receipt.cases[4].observed='42';});
mutate('reject guest with host imports',d=>{d.receipt.cases[0].imports=1;});
mutate('reject denied artifact published',d=>{d.receipt.cases[7].publishedArtifact=true;});
mutate('reject incorrect diagnostic',d=>{d.receipt.cases[9].diagnostic='unsupported';});
mutate('reject failed run',d=>{d.run.conclusion='failure';});
mutate('reject zero-size artifact',d=>{d.artifacts.artifacts[0].size_in_bytes=0;});
mutate('reject missing release artifact',d=>{d.artifacts.artifacts=[];});
mutate('reject stale artifact from another head',d=>{d.artifacts.artifacts[0].workflow_run.head_sha='d'.repeat(40);});
mutate('reject duplicate artifact for run',d=>{d.artifacts.artifacts.push({...d.artifacts.artifacts[0]});});

test('11 pinned source SHA-256 values independently match real .atto fixture bytes', async()=>{
  assert.equal(BOOLEAN_CASES.length,11);
  assert.deepEqual(new Set(Object.keys(BOOLEAN_SOURCE_SHA256)),
    new Set(BOOLEAN_CASES.map(([id])=>id)));
  for(const [id,, ,blob] of BOOLEAN_CASES){
    const path=fileURLToPath(new URL('./fixtures/boolean-v1/'+id+'.atto',import.meta.url));
    const st=await lstat(path);
    assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.size>0&&st.size<=8192,id+' unsafe fixture');
    const bytes=await readFile(path);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const gitBlob=createHash('sha1').update(Buffer.from('blob '+bytes.length+String.fromCharCode(0),'ascii'))
      .update(bytes).digest('hex');
    assert.equal(sha256,BOOLEAN_SOURCE_SHA256[id],id+' SHA-256 drift');
    assert.equal(gitBlob,blob,id+' Git blob drift');
  }
});
mutate('reject source SHA-256 with valid format but wrong bytes',d=>{
  d.receipt.cases[0].sourceSha256='d'.repeat(64);
});
mutate('reject swapped valid fixture source SHA-256 values',d=>{
  d.receipt.cases[0].sourceSha256=d.receipt.cases[1].sourceSha256;
});
mutate('reject lookalike source repository numeric ID',d=>{d.run.repository.id=999;});
mutate('reject forked workflow head repository ID',d=>{d.run.head_repository.id=999;});
mutate('reject missing workflow numeric identity',d=>{d.run.workflow_id=null;});
mutate('reject missing job identity',d=>{d.jobs.jobs[0].id=null;});
mutate('reject stale job attempt from older run',d=>{d.jobs.jobs[0].run_attempt=1;});
mutate('reject job pointing to different commit',d=>{d.jobs.jobs[0].head_sha='d'.repeat(40);});
mutate('reject job on non-main branch',d=>{d.jobs.jobs[0].head_branch='feature';});
mutate('reject job belonging to different workflow',d=>{
  d.jobs.jobs[0].workflow_name='Another Workflow';
});
mutate('reject duplicate successful step number',d=>{
  d.jobs.jobs[0].steps[5].number=d.jobs.jobs[0].steps[4].number;
});
mutate('reject out-of-order required step numbers',d=>{
  const steps=d.jobs.jobs[0].steps;
  [steps[7],steps[8]]=[steps[8],steps[7]];
});
mutate('reject unnumbered extra step',d=>{
  d.jobs.jobs[0].steps.push({name:'extra unnumbered step',status:'completed',
    conclusion:'success',started_at:'2026-11-07T12:00:00Z',
    completed_at:'2026-11-07T12:01:00Z'});
});
