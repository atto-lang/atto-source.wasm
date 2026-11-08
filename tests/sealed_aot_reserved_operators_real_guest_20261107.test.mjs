import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, writeFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';

// Canonical .atto bytes are shared with the LLVM native compiler. A host-only
// SHA check is not compiler rejection or Wasm guest execution evidence.
const cases = Object.freeze([
  {id:'multiply-positive',expr:'7 * 6',token:null,
    blob:'b7134418f1b23e22e4865452716c9e465bbe7b0d'},
  {id:'percent-reject',expr:'7 % 3',token:'%',
    blob:'6fdf352a669dd7597ff7d27efbfd05b2290d1ec6'},
  {id:'caret-reject',expr:'7 ^ 3',token:'^',
    blob:'4d3a2470383d6bc4cb1be56e9221371b7bdbc6fa'},
  {id:'double-caret-reject',expr:'7 ^^ 3',token:'^^',
    blob:'ab4d69393bb17e06a8c977bc81b7e206cfa00684'},
  {id:'nested-caret-reject',expr:'(2 ^ 3) * 4',token:'^',
    blob:'a830b33f301c69cdaec37466ee4e43480d8844d5'},
  {id:'nested-double-caret-reject',expr:'(2 ^^ 3) + 4',token:'^^',
    blob:'7afaf2be676c97b16c3138845445705eef04cef0'},
]);
const bytesFor = c => Buffer.from('pub fnc main(): int {\n  return '+c.expr+';\n}\n');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const gitBlob = b => createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const envMode = process.env.ATTO_SEALED_OPERATOR_REAL_GUEST_REQUIRED ?? '0';
if(!['0','1'].includes(envMode)) throw Error('invalid sealed operator guest requirement');
const compilerPath = process.env.ORESLANG_LLVM_COMPILER;
const required = envMode === '1';
// A real LLVM compiler can fail for an unrelated reason while echoing an
// operator token. A valid negative receipt needs the intended semantic
// decision on the SAME compiler-owned diagnostic line.
const semanticPolicy = /(?:noncanonical|removed|unsupported|forbidden|disallowed|not allowed)/i;
const genericFailure = /(?:syntax error|parse error|unexpected (?:token|character)|unrecognized token|unsupported character|unresolved (?:identifier|symbol)|unknown (?:identifier|symbol)|internal error|stack overflow)/i;
function matchesReservedOperatorDiagnostic(stderr, token) {
  if (!['%', '^', '^^'].includes(token) || typeof stderr !== 'string'
      || stderr.length < 1 || stderr.length > 65536 || genericFailure.test(stderr)) return false;
  return stderr.split(/\r?\n/).some(line => {
    if (!/^oreslang-llvmc:\s+/.test(line) || !/\boperator\b/i.test(line)
        || !semanticPolicy.test(line)) return false;
    const mentioned = line.match(/\^{1,2}|%/g) ?? [];
    return mentioned.length > 0 && mentioned.every(symbol => symbol === token);
  });
}


// Real compiler provenance must be verified by GitHub's Sigstore-backed CLI,
// not by a source SHA supplied in an environment variable or unsigned JSON.
// The signer workflow must BUILD and ATTEST the binary at that source revision.
const upstreamLLVM='ores-truffle-oreslang/oreslang-source.llvm';
const upstreamLLVMID='1410897874';
const trustedBuilder='ores-truffle-oreslang/oreslang-source.llvm/.github/workflows/atto-llvm-compiler-attestation.yml';
function assertSignedAttestationResult(results,digest) {
  assert.ok(Array.isArray(results) && results.length>0 && results.length<=30,
    'no bounded verified compiler attestations');
  assert.ok(results.some(({verificationResult:v}={}) => {
    const cert=v?.signature?.certificate;
    const statement=v?.statement;
    return String(cert?.sourceRepositoryIdentifier??'')===upstreamLLVMID
      && Array.isArray(v?.verifiedTimestamps) && v.verifiedTimestamps.length>0
      && statement?.predicateType==='https://slsa.dev/provenance/v1'
      && Array.isArray(statement?.subject) && statement.subject.length===1
      && statement.subject[0]?.digest?.sha256===digest;
  }), 'verified attestation lacks the pinned LLVM repo identity, subject digest or signed timestamp');
}
function verifySignedLLVMCompiler({compiler,digest,sourceSha,run=spawnSync,environment=process.env}) {
  assert.match(digest,/^[0-9a-f]{64}$/,'invalid compiler SHA-256');
  assert.match(sourceSha,/^[0-9a-f]{40}$/,'invalid reviewed LLVM source SHA');
  assert.ok(isAbsolute(compiler),'attested compiler path must be absolute');
  // Always fetch signed attestations from the live GitHub repo. A local JSON
  // or offline bundle cannot substitute for current repository identity.
  const args=['attestation','verify',compiler,'--repo',upstreamLLVM,
    '--signer-workflow',trustedBuilder,'--source-ref','refs/heads/main',
    '--source-digest',sourceSha,'--signer-digest',sourceSha,
    '--deny-self-hosted-runners','--format','json'];
  const token=environment.GH_TOKEN??environment.GITHUB_TOKEN;
  const result=run('/usr/bin/gh',args,{
    cwd:'/',encoding:'utf8',timeout:45000,maxBuffer:1024*1024,
    env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',
      GH_HOST:'github.com',...(token?{GH_TOKEN:token}:{})}
  });
  assert.ok(!result.error && !result.signal && result.status===0
      && typeof result.stdout==='string' && result.stdout.length<=1024*1024,
    'GitHub cryptographic source-to-binary attestation missing or failed');
  let verified;
  try{verified=JSON.parse(result.stdout)}
  catch{throw new Error('GitHub attestation verification returned malformed JSON')}
  assertSignedAttestationResult(verified,digest);
  return Object.freeze({repository:upstreamLLVM,sourceSha,compilerSha256:digest,
    signerWorkflow:trustedBuilder,scope:'verified-signed-compiler-provenance'});
}

// Isolated adversarial policy cases: mocked CLI output is NOT a signed receipt.
const fakeAttestation=d=>[{
  verificationResult:{
    signature:{certificate:{sourceRepositoryIdentifier:upstreamLLVMID}},
    verifiedTimestamps:[{timestamp:'2026-11-07T00:00:00Z'}],
    statement:{predicateType:'https://slsa.dev/provenance/v1',
      subject:[{name:'oreslang-llvmc',digest:{sha256:d}}]}
  }
}];
const fakeDigest='f'.repeat(64), fakeSource='a'.repeat(40);
test('signed compiler provenance: correct verified envelope is structurally accepted (MOCK ONLY)',()=>{
  assert.doesNotThrow(()=>assertSignedAttestationResult(fakeAttestation(fakeDigest),fakeDigest));
});
const badAttestationCases=[
  ['empty',a=>a.splice(0)],['empty timestamps',a=>a[0].verificationResult.verifiedTimestamps=[]],
  ['wrong repository ID',a=>a[0].verificationResult.signature.certificate.sourceRepositoryIdentifier='0'],
  ['missing certificate',a=>delete a[0].verificationResult.signature.certificate],
  ['wrong predicate',a=>a[0].verificationResult.statement.predicateType='not-slsa'],
  ['wrong binary digest',a=>a[0].verificationResult.statement.subject[0].digest.sha256='0'.repeat(64)],
  ['missing binary digest',a=>delete a[0].verificationResult.statement.subject[0].digest.sha256],
  ['extra subject',a=>a[0].verificationResult.statement.subject.push({name:'forged'})],
  ['no subjects',a=>a[0].verificationResult.statement.subject=[]],
  ['no verification result',a=>delete a[0].verificationResult]
];
for(const [name,mutate] of badAttestationCases)
  test('signed compiler provenance: reject '+name+' (MOCK ONLY)',()=>{
    const sample=fakeAttestation(fakeDigest); mutate(sample);
    assert.throws(()=>assertSignedAttestationResult(sample,fakeDigest));
  });
test('signed compiler provenance: fixed authenticated gh CLI parameters (MOCK ONLY)',()=>{
  let invocations=0;
  const result=verifySignedLLVMCompiler({compiler:'/tmp/pinned-llvmc',digest:fakeDigest,
    sourceSha:fakeSource,environment:{GH_TOKEN:'test-placeholder',NODE_OPTIONS:'malicious'},
    run:(program,args,options)=>{
      invocations++;
      assert.equal(program,'/usr/bin/gh');
      assert.deepEqual(args,['attestation','verify','/tmp/pinned-llvmc',
        '--repo',upstreamLLVM,'--signer-workflow',trustedBuilder,
        '--source-ref','refs/heads/main','--source-digest',fakeSource,
        '--signer-digest',fakeSource,'--deny-self-hosted-runners','--format','json']);
      assert.equal(options.env.GH_TOKEN,'test-placeholder');
      assert.equal(options.env.NODE_OPTIONS,undefined);
      return {status:0,stdout:JSON.stringify(fakeAttestation(fakeDigest))};
    }});
  assert.equal(invocations,1); assert.equal(result.compilerSha256,fakeDigest);
});
for(const [name,report] of [
  ['failed signature',()=>({status:1,stdout:JSON.stringify(fakeAttestation(fakeDigest))})],
  ['process signal',()=>({status:null,signal:'SIGKILL',stdout:''})],
  ['invalid JSON',()=>({status:0,stdout:'not JSON'})],
  ['forged repo',()=>{const a=fakeAttestation(fakeDigest);
    a[0].verificationResult.signature.certificate.sourceRepositoryIdentifier='0';
    return {status:0,stdout:JSON.stringify(a)}}]
]) test('signed compiler provenance: deny '+name+' (MOCK ONLY)',()=>{
  assert.throws(()=>verifySignedLLVMCompiler({compiler:'/tmp/pinned-llvmc',digest:fakeDigest,
    sourceSha:fakeSource,run:report}));
});
test('signed compiler provenance: deny malformed SHA before invoking CLI',()=>{
  let called=false;
  assert.throws(()=>verifySignedLLVMCompiler({compiler:'/tmp/pinned-llvmc',
    digest:fakeDigest,sourceSha:'a'.repeat(39),run:()=>{
      called=true;return {status:0,stdout:JSON.stringify(fakeAttestation(fakeDigest))};
    }}));
  assert.equal(called,false);
});

test('pinned .atto corpus includes an executable positive and five operator rejections (SOURCE ONLY)', () => {
  assert.equal(cases.length,6);
  assert.deepEqual(cases.map(c=>c.id),[
    'multiply-positive','percent-reject','caret-reject',
    'double-caret-reject','nested-caret-reject','nested-double-caret-reject']);
  const ids=new Set();
  for(const c of cases) {
    assert.ok(!ids.has(c.id)); ids.add(c.id);
    assert.match(c.blob,/^[0-9a-f]{40}$/);
    assert.equal(gitBlob(bytesFor(c)),c.blob,c.id);
    assert.equal(c.token===null, c.id==='multiply-positive');
    if(c.token!==null) assert.ok(c.expr.includes(c.token),c.id);
  }
});

// Adversarial policy checks are source-only and never certify a native compiler.
for (const op of ['%', '^', '^^']) {
  for (const policy of ['noncanonical', 'removed', 'unsupported', 'forbidden', 'disallowed', 'not allowed']) {
    test('diagnostic oracle: ' + op + ' same-line ' + policy, () => {
      assert.equal(matchesReservedOperatorDiagnostic(
        'oreslang-llvmc: ' + policy + " '" + op + "' source operator", op), true);
    });
  }
  const wrong = op === '^' ? '^^' : '^';
  const bad = [
    'oreslang-llvmc: error: syntax error near ' + op + '; operator unsupported',
    "oreslang-llvmc: unexpected token '" + op + "' operator unsupported",
    "oreslang-llvmc: unsupported character '" + op + "'; operator unsupported",
    "oreslang-llvmc: unknown identifier '" + op + "'; operator unsupported",
    'oreslang-llvmc: internal error while checking ' + op + ' operator unsupported',
    'oreslang-llvmc: ' + op + ' unsupported',
    "ors-lang-cxx: unsupported '" + op + "' operator",
    'oreslang-llvmc: permission denied while reading ' + op + ' operator',
    'oreslang-llvmc: unknown ' + op + ' operator',
    'oreslang-llvmc: operator ' + op + '\noreslang-llvmc: unrelated operator unsupported',
    'oreslang-llvmc: unsupported operator ' + wrong,
    'oreslang-llvmc: unsupported operators ' + op + ' and ' + wrong,
  ];
  for (const [index, diagnostic] of bad.entries()) {
    test('diagnostic oracle: ' + op + ' denies wrong reason ' + index, () => {
      assert.equal(matchesReservedOperatorDiagnostic(diagnostic, op), false);
    });
  }
}
test('diagnostic oracle: invalid symbol cannot be certified', () => {
  assert.equal(matchesReservedOperatorDiagnostic('oreslang-llvmc: removed + operator', '+'), false);
});
test('diagnostic oracle: oversized stderr cannot be certified', () => {
  assert.equal(matchesReservedOperatorDiagnostic(
    'oreslang-llvmc: removed % operator'.repeat(3000), '%'), false);
});

test('real pinned LLVM frontend must reject %, ^ and ^^ before IR, while emitting a runnable 42 Wasm guest', {
  skip:!compilerPath&&!required, timeout:180000
}, async () => {
  assert.ok(compilerPath, 'required pinned LLVM compiler absent; skipped execution is not evidence');
  assert.ok(isAbsolute(compilerPath),'compiler executable must use absolute path');
  const expectedDigest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
  const expectedWasmHead=process.env.ATTO_SEALED_OPERATOR_WASM_HEAD;
  assert.match(expectedDigest??'',/^[0-9a-f]{64}$/,'missing pinned executable SHA256');
  assert.match(sourceSha??'',/^[0-9a-f]{40}$/,'missing reviewed LLVM source SHA');
  assert.match(expectedWasmHead??'',/^[0-9a-f]{40}$/,'missing pinned Wasm HEAD');
  const git=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
  assert.ifError(git.error);
  assert.equal(git.status,0);
  assert.equal(git.stdout.trim(),expectedWasmHead,'Wasm checkout moved');
  // Dynamic imports prevent test-only source checks from implying that a native
  // compiler, Wasm runtime, or external build tools were available locally.
  const [{compileOresToWasm,readBoundedRegularFile}, {readAtomicRelease},
    {runIsolatedCoreGuest}, {assertNativeFrontendRejection},
    {cleanupRealCompilerWorkspace}] = await Promise.all([
    import('../scripts/compile-ores.mjs'),import('../scripts/atomic-release.mjs'),
    import('../src/isolated-runner.mjs'),import('../scripts/verify-real-compiler.mjs'),
    import('../scripts/cleanup-real-compiler.mjs')]);
  const snapshot=(await readBoundedRegularFile(compilerPath,256*1024*1024,
    'native compiler missing, nonregular or too large')).bytes;
  assert.equal(sha256(snapshot),expectedDigest,'pinned native compiler digest mismatch');
  const temp=await mkdtemp(join(tmpdir(),'atto-caret-negative-wasm32-'));
  try {
    const compiler=join(temp,'pinned-llvmc');
    await writeFile(compiler,snapshot,{flag:'wx',mode:0o500});
    // The actual staged digest was already checked above. Verify the same
    // binary against a GitHub-signed LLVM main workflow and exact source SHA.
    // No unsigned build record or local source transfer can satisfy this.
    const provenCompiler=verifySignedLLVMCompiler({
      compiler,digest:expectedDigest,sourceSha
    });
    assert.equal(provenCompiler.compilerSha256,expectedDigest);
    assert.equal(provenCompiler.sourceSha,sourceSha);
    for(const c of cases) {
      const input=join(temp,c.id+'.atto'),output=join(temp,c.id+'.wasm');
      const source=bytesFor(c);
      await writeFile(input,source,{flag:'wx',mode:0o400});
      assert.equal(gitBlob(await readFile(input)),c.blob,'source mutated before compilation');
      if(c.token===null) {
        const built=await compileOresToWasm({compiler,
          compilerSha256:expectedDigest,source:input,output,
          environment:'browser',publication:'atomic'});
        assert.equal(built.sourceSha256,sha256(source));
        assert.equal(built.compilerSha256,expectedDigest);
        const release=await readAtomicRelease(output);
        assert.equal(built.wasmSha256,sha256(release.wasm));
        assert.deepEqual(release.manifest.imports,[]);
        assert.deepEqual(release.manifest.requiredCapabilities,[]);
        const guest=await runIsolatedCoreGuest(release.wasm,{
          expectedSha256:built.wasmSha256,timeoutMs:5000});
        assert.equal(guest.value,42n);
        assert.equal(guest.admission.hostCapabilities,0);
      } else {
        const native=spawnSync(compiler,['--target=wasm32',input],{
          encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,
          env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'}});
        assertNativeFrontendRejection(native);
        const diagnostic=String(native.stderr);
        assert.ok(matchesReservedOperatorDiagnostic(diagnostic,c.token),
          c.id+' rejected for wrong reason: '+diagnostic.slice(0,300));
        await assert.rejects(compileOresToWasm({compiler,
          compilerSha256:expectedDigest,source:input,output,
          environment:'browser',publication:'atomic'}),
          e => String(e?.message??e).includes(c.token),
          c.id+' bridge must preserve source operator rejection');
        await assert.rejects(stat(output),{code:'ENOENT'},'rejected source emitted Wasm');
        await assert.rejects(stat(output+'.current.json'),{code:'ENOENT'},
          'rejected source published a release pointer');
      }
      assert.equal(gitBlob(await readFile(input)),c.blob,c.id+' source drift');
    }
    const finalGit=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
    assert.equal(finalGit.status,0);
    assert.equal(finalGit.stdout.trim(),expectedWasmHead,'Wasm checkout moved during execution');
  } finally { await cleanupRealCompilerWorkspace(temp); }
});
