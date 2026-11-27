import {verifySignedLLVMCompiler} from '../scripts/attested-llvm-compiler.mjs';
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
  {id:'multiply-positive',expr:'7 * 6',token:null,expected:42n,
    blob:'b7134418f1b23e22e4865452716c9e465bbe7b0d'},
  {id:'percent-reject',expr:'7 % 3',token:'%',
    blob:'6fdf352a669dd7597ff7d27efbfd05b2290d1ec6'},
  {id:'caret-reject',expr:'7 ^ 3',token:'^',
    blob:'4d3a2470383d6bc4cb1be56e9221371b7bdbc6fa'},
  {id:'double-caret-positive',expr:'7 ^^ 3',token:null,expected:4n,
    blob:'ab4d69393bb17e06a8c977bc81b7e206cfa00684'},
  {id:'nested-caret-reject',expr:'(2 ^ 3) * 4',token:'^',
    blob:'a830b33f301c69cdaec37466ee4e43480d8844d5'},
  {id:'nested-double-caret-positive',expr:'(2 ^^ 3) + 4',token:null,expected:5n,
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
  if (!['%', '^'].includes(token) || typeof stderr !== 'string'
      || stderr.length < 1 || stderr.length > 65536 || genericFailure.test(stderr)) return false;
  return stderr.split(/\r?\n/).some(line => {
    if (!/^oreslang-llvmc:\s+/.test(line) || !/\boperator\b/i.test(line)
        || !semanticPolicy.test(line)) return false;
    const mentioned = line.match(/\^{1,2}|%/g) ?? [];
    return mentioned.length > 0 && mentioned.every(symbol => symbol === token);
  });
}


test('pinned .atto corpus includes three positives and three operator rejections (SOURCE ONLY)', () => {
  assert.equal(cases.length,6);
  assert.deepEqual(cases.map(c=>c.id),[
    'multiply-positive','percent-reject','caret-reject',
    'double-caret-positive','nested-caret-reject','nested-double-caret-positive']);
  const ids=new Set();
  for(const c of cases) {
    assert.ok(!ids.has(c.id)); ids.add(c.id);
    assert.match(c.blob,/^[0-9a-f]{40}$/);
    assert.equal(gitBlob(bytesFor(c)),c.blob,c.id);
    assert.equal(c.token===null, typeof c.expected==='bigint',c.id);
    if(c.token!==null) {
      assert.ok(['%', '^'].includes(c.token),c.id);
      assert.ok(c.expr.includes(c.token) && !c.expr.includes('^^'),c.id);
    }
  }
});

// Adversarial policy checks are source-only and never certify a native compiler.
for (const op of ['%', '^']) {
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
test('diagnostic oracle: integer double-caret is no longer a reserved operator', () => {
  assert.equal(matchesReservedOperatorDiagnostic('oreslang-llvmc: unsupported ^^ operator', '^^'), false);
});
test('diagnostic oracle: oversized stderr cannot be certified', () => {
  assert.equal(matchesReservedOperatorDiagnostic(
    'oreslang-llvmc: removed % operator'.repeat(3000), '%'), false);
});

test('real pinned LLVM frontend rejects % and infix ^; integer ^^ emits runnable Wasm', {
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
          environment:'browser',publication:'atomic',operatorProfile:'canonical-i64-v5'});
        assert.equal(built.sourceSha256,sha256(source));
        assert.equal(built.compilerSha256,expectedDigest);
        const release=await readAtomicRelease(output);
        assert.equal(built.wasmSha256,sha256(release.wasm));
        assert.deepEqual(release.manifest.imports,[]);
        assert.deepEqual(release.manifest.requiredCapabilities,[]);
        const guest=await runIsolatedCoreGuest(release.wasm,{
          expectedSha256:built.wasmSha256,timeoutMs:5000});
        assert.equal(guest.value,c.expected,c.id);
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
          environment:'browser',publication:'atomic',operatorProfile:'canonical-i64-v5'}),
          e => String(e?.message??e).includes("ATTO_REMOVED_OPERATOR: '"+c.token+"'"),
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
