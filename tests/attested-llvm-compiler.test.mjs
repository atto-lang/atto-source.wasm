import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSignedAttestationResult, verifySignedLLVMCompiler} from '../scripts/attested-llvm-compiler.mjs';

// JSON-shape fixture based on the publicly documented Sigstore verification
// result fields and GitHub CLI's documented 'verificationResult' envelope.
// This is SYNTHETIC; it is not a cryptographically verified attestation.
const source='a'.repeat(40), digest='f'.repeat(64);
const repo='ores-truffle-oreslang/oreslang-source.llvm';
const uri='https://github.com/'+repo;
const builder=repo+'/.github/workflows/atto-llvm-compiler-attestation.yml';
const signer='https://github.com/'+builder+'@refs/heads/main';
const fixture=()=>[{attestation:{bundle:{mediaType:'application/vnd.dev.sigstore.bundle.v0.3+json'}},
  verificationResult:{
    signature:{certificate:{
      sourceRepositoryIdentifier:'1410897874',sourceRepositoryURI:uri,
      sourceRepositoryRef:'refs/heads/main',sourceRepositoryDigest:source,
      sourceRepositoryOwnerURI:'https://github.com/ores-truffle-oreslang',
      issuer:'https://token.actions.githubusercontent.com',
      runnerEnvironment:'github-hosted',buildSignerURI:signer,
      buildSignerDigest:source,buildConfigURI:signer,
      githubWorkflowRepository:repo,githubWorkflowRef:'refs/heads/main',
      githubWorkflowTrigger:'push',subjectAlternativeName:{type:'URI',value:signer}
    }},
    verifiedTimestamps:[{type:'TimestampAuthority',timestamp:'2026-11-07T22:00:00Z'}],
    statement:{predicateType:'https://slsa.dev/provenance/v1',
      subject:[{name:'oreslang-llvmc',digest:{sha256:digest}}],predicate:{}}
  }
}];

test('documented GitHub CLI JSON array shape is accepted (SYNTHETIC, NOT SIGNED)',()=>{
  assert.doesNotThrow(()=>assertSignedAttestationResult(fixture(),digest,source));
});
const cases=[
  ['sourceRepositoryIdentifier',c=>c.sourceRepositoryIdentifier='999'],
  ['sourceRepositoryURI',c=>c.sourceRepositoryURI='https://github.com/forged/repo'],
  ['sourceRepositoryRef',c=>c.sourceRepositoryRef='refs/heads/evil'],
  ['sourceRepositoryDigest',c=>c.sourceRepositoryDigest='0'.repeat(40)],
  ['sourceRepositoryOwnerURI',c=>c.sourceRepositoryOwnerURI='https://github.com/evil'],
  ['issuer',c=>c.issuer='https://evil.example'],
  ['runnerEnvironment',c=>c.runnerEnvironment='self-hosted'],
  ['buildSignerURI',c=>c.buildSignerURI='https://github.com/evil/workflow'],
  ['buildSignerDigest',c=>c.buildSignerDigest='0'.repeat(40)],
  ['buildConfigURI',c=>c.buildConfigURI='https://github.com/evil/workflow'],
  ['githubWorkflowRepository',c=>c.githubWorkflowRepository='evil/repo'],
  ['githubWorkflowRef',c=>c.githubWorkflowRef='refs/heads/evil'],
  ['githubWorkflowTrigger',c=>c.githubWorkflowTrigger='pull_request'],
  ['subjectAlternativeName type',c=>c.subjectAlternativeName.type='DNS'],
  ['subjectAlternativeName value',c=>c.subjectAlternativeName.value='https://github.com/evil'],
];
for(const [name,mutate] of cases){
  test('denies forged signed certificate '+name,()=>{
    const a=fixture();mutate(a[0].verificationResult.signature.certificate);
    assert.throws(()=>assertSignedAttestationResult(a,digest,source));
  });
}
for(const [name,mutate] of [
  ['no result',a=>delete a[0].verificationResult],
  ['no signature',a=>delete a[0].verificationResult.signature],
  ['no timestamps',a=>a[0].verificationResult.verifiedTimestamps=[]],
  ['bogus timestamp',a=>a[0].verificationResult.verifiedTimestamps=[{timestamp:'bad'}]],
  ['wrong predicate',a=>a[0].verificationResult.statement.predicateType='bad'],
  ['wrong digest',a=>a[0].verificationResult.statement.subject[0].digest.sha256='0'.repeat(64)],
  ['wrong subject name',a=>a[0].verificationResult.statement.subject[0].name='forged'],
  ['multiple subjects',a=>a[0].verificationResult.statement.subject.push({name:'forged'})],
  ['missing subject',a=>a[0].verificationResult.statement.subject=[]],
  ['absent certificate',a=>delete a[0].verificationResult.signature.certificate],
  ['unsigned author-supplied metadata',a=>{delete a[0].verificationResult.signature;
    a[0].verificationResult.statement.predicate.sourceRepositoryIdentifier='1410897874';}],
]) test('denies invalid CLI JSON '+name,()=>{
  const a=fixture();mutate(a);assert.throws(()=>assertSignedAttestationResult(a,digest,source));
});
test('mixed results require at least one matching signed certificate',()=>{
  const a=fixture();const b=fixture();b[0].verificationResult.signature.certificate.runnerEnvironment='self-hosted';
  assert.doesNotThrow(()=>assertSignedAttestationResult([...b,...a],digest,source));
  assert.throws(()=>assertSignedAttestationResult([...b,...b],digest,source));
});
test('more than 30 results are rejected',()=>{
  assert.throws(()=>assertSignedAttestationResult(Array.from({length:31},fixture).flat(),digest,source));
});
test('invokes pinned gh with source identity, digest and runner restrictions',()=>{
  let called=0;
  const proof=verifySignedLLVMCompiler({compiler:'/tmp/oreslang-llvmc',digest,source,
    sourceSha:source,environment:{GH_TOKEN:'mock-token',NODE_OPTIONS:'--malicious',GH_HOST:'evil.example'},
    run:(binary,args,opts)=>{called++;
      assert.equal(binary,'/usr/bin/gh');
      assert.deepEqual(args,['attestation','verify','/tmp/oreslang-llvmc',
        '--repo',repo,'--signer-workflow',builder,'--source-ref','refs/heads/main',
        '--source-digest',source,'--signer-digest',source,
        '--predicate-type','https://slsa.dev/provenance/v1',
        '--deny-self-hosted-runners','--limit','30','--format','json']);
      assert.deepEqual(Object.keys(opts.env).sort(),['GH_HOST','GH_TOKEN','LANG','LC_ALL','PATH'].sort());
      assert.equal(opts.env.GH_HOST,'github.com');
      return {status:0,stdout:JSON.stringify(fixture())};
    }});
  assert.equal(called,1);assert.equal(proof.compilerSha256,digest);
});
for(const [name,failure] of [
  ['bad signature status',()=>({status:1,stdout:JSON.stringify(fixture())})],
  ['signal',()=>({status:null,signal:'SIGKILL',stdout:''})],
  ['invalid JSON',()=>({status:0,stdout:'not-json'})],
  ['empty',()=>({status:0,stdout:''})],
  ['forged JSON',()=>{const a=fixture();a[0].verificationResult.signature.certificate.runnerEnvironment='self-hosted';
    return {status:0,stdout:JSON.stringify(a)};}]
]) test('gh CLI failure '+name+' must not be accepted',()=>{
  assert.throws(()=>verifySignedLLVMCompiler({compiler:'/tmp/oreslang-llvmc',digest,sourceSha:source,
    environment:{GH_TOKEN:'mock'},run:failure}));
});
test('missing token fails before executing gh',()=>{
  let called=false;
  assert.throws(()=>verifySignedLLVMCompiler({compiler:'/tmp/oreslang-llvmc',digest,
    sourceSha:source,environment:{},run:()=>{called=true;return {status:0};}}));
  assert.equal(called,false);
});
test('malformed source SHA fails before executing gh',()=>{
  let called=false;
  assert.throws(()=>verifySignedLLVMCompiler({compiler:'/tmp/oreslang-llvmc',digest,
    sourceSha:'z'.repeat(40),environment:{GH_TOKEN:'mock'},run:()=>{called=true;return {status:0};}}));
  assert.equal(called,false);
});
