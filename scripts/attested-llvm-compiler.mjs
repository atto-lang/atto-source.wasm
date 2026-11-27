/**
 * Verify a source-owned, signed LLVM compiler before invoking any guest code.
 * JSON parsing is only defense in depth: /usr/bin/gh MUST independently verify
 * Sigstore signatures, trusted roots, certificate identity and the file digest.
 * Never accept a direct JSON claim or use unsigned SLSA predicate fields as
 * proof of repository, workflow, source ref or runner identity.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {isAbsolute, basename} from 'node:path';

const repo='ores-truffle-oreslang/oreslang-source.llvm';
const repositoryID='1410897874';
const owner='ores-truffle-oreslang';
const workflow='.github/workflows/atto-llvm-compiler-attestation.yml';
const builder=repo+'/'+workflow;
const signerURI='https://github.com/'+builder+'@refs/heads/main';
const sourceURI='https://github.com/'+repo;
const sourceRef='refs/heads/main';
const expectedIssuer='https://token.actions.githubusercontent.com';
const predicate='https://slsa.dev/provenance/v1';
const sha40=/^[a-f0-9]{40}$/;
const sha64=/^[a-f0-9]{64}$/;

function validCertificate(cert,sourceSha){
  if(!cert || typeof cert!=='object') return false;
  const san=cert.subjectAlternativeName;
  return String(cert.sourceRepositoryIdentifier??'')===repositoryID
    && cert.sourceRepositoryURI===sourceURI
    && cert.sourceRepositoryRef===sourceRef
    && cert.sourceRepositoryDigest===sourceSha
    && cert.sourceRepositoryOwnerURI==='https://github.com/'+owner
    && cert.issuer===expectedIssuer
    && cert.runnerEnvironment==='github-hosted'
    && cert.buildSignerURI===signerURI
    && cert.buildSignerDigest===sourceSha
    && cert.buildConfigURI===signerURI
    && cert.githubWorkflowRepository===repo
    && cert.githubWorkflowRef===sourceRef
    && cert.githubWorkflowTrigger==='push'
    && san?.type==='URI' && san.value===signerURI;
}

/** 'verifiedTimestamps' is produced by the Sigstore verifier, not source code. */
function validTimestamps(ts){
  return Array.isArray(ts) && ts.length>0 && ts.length<=30
    && ts.every(t=>t && typeof t==='object' && typeof t.timestamp==='string'
      && Number.isFinite(Date.parse(t.timestamp)));
}

export function assertSignedAttestationResult(results,digest,sourceSha){
  assert.match(digest??'',sha64,'invalid compiler SHA-256');
  assert.match(sourceSha??'',sha40,'invalid compiler source SHA');
  assert.ok(Array.isArray(results) && results.length>0 && results.length<=30,
    'no bounded GitHub verified compiler attestations');
  assert.ok(results.some(({verificationResult:v}={})=>{
    if(!v || typeof v!=='object') return false;
    const statement=v.statement;
    return validCertificate(v.signature?.certificate,sourceSha)
      && validTimestamps(v.verifiedTimestamps)
      && statement?.predicateType===predicate
      && Array.isArray(statement.subject) && statement.subject.length===1
      && typeof statement.subject[0]?.name==='string'
      && basename(statement.subject[0].name)==='oreslang-llvmc'
      && statement.subject[0]?.digest?.sha256===digest;
  }), 'no verified compiler attestation matches signed source, builder, runner and binary');
}

export function verifySignedLLVMCompiler({compiler,digest,sourceSha,
  run=spawnSync,environment=process.env}){
  assert.match(digest??'',sha64,'invalid compiler SHA-256');
  assert.match(sourceSha??'',sha40,'invalid LLVM source SHA');
  assert.ok(typeof compiler==='string' && isAbsolute(compiler),
    'pinned compiler path must be absolute');
  // A private repo must be verified with an explicit, scoped token. We scrub
  // inherited environment so fake GH_CONFIG_DIR/HOME/GH_HOST cannot redirect.
  const token=environment.GH_TOKEN??environment.GITHUB_TOKEN;
  assert.ok(typeof token==='string' && token.length>0 && token.length<=4096,
    'authenticated GitHub token required for private compiler provenance');
  const args=['attestation','verify',compiler,'--repo',repo,
    '--signer-workflow',builder,'--source-ref',sourceRef,
    '--source-digest',sourceSha,'--signer-digest',sourceSha,
    '--predicate-type',predicate,'--deny-self-hosted-runners',
    '--limit','30','--format','json'];
  const result=run('/usr/bin/gh',args,{
    cwd:'/',encoding:'utf8',timeout:45000,maxBuffer:1024*1024,
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
      GH_HOST:'github.com',GH_TOKEN:token}
  });
  assert.ok(!result.error && !result.signal && result.status===0
    && typeof result.stdout==='string' && result.stdout.length>0
    && result.stdout.length<=1024*1024,
  'GitHub signed compiler verification failed or produced no bounded output');
  let verified;
  try { verified=JSON.parse(result.stdout); }
  catch { throw Error('GitHub verifier output is not valid JSON'); }
  assertSignedAttestationResult(verified,digest,sourceSha);
  return Object.freeze({repository:repo,sourceSha,compilerSha256:digest,
    signerWorkflow:builder,scope:'verified-signed-compiler-provenance'});
}
