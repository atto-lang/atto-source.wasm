import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

// Shared EXACT source blobs with ores-llm-ml-conformance-tests PR #37.
// Host-only byte identity checks do not count as WASM execution.
const corpus=[
  ['multiply-positive','7 * 6','b7134418f1b23e22e4865452716c9e465bbe7b0d'],
  ['percent-basic-reject','7 % 3','6fdf352a669dd7597ff7d27efbfd05b2290d1ec6'],
  ['percent-signed-reject','-7 % -3','0918de8a151a4fc588fb53279f234e1aad42a836'],
  ['percent-nested-reject','(8 % 3) * 2','5b7d888feef8b1eea4198fadcde2a2f5364a1308'],
  ['percent-min-reject','-9223372036854775808 % -1','3d4cdc1c34d2f3986c315a9240a670c37a6d2941']
];
const source=expr=>'pub fnc main(): int {\n  return '+expr+';\n}\n';
const gitBlob=bytes=>createHash('sha1').update('blob '+bytes.length+String.fromCharCode(0)).update(bytes).digest('hex');

test('canonical removed-% fixture SHA and source-only verdicts (NOT Wasm execution)',()=>{
  assert.deepEqual(corpus.map(c=>c[0]),['multiply-positive','percent-basic-reject','percent-signed-reject','percent-nested-reject','percent-min-reject']);
  for(const [id,expr,sha] of corpus){
    const bytes=Buffer.from(source(expr));
    assert.equal(gitBlob(bytes),sha,id);
    assert.equal(expr.includes('%'),id!=='multiply-positive',id);
  }
});

// Both compiler revisions reject the same removed operator. Do not accept
// generic parser, bridge, or toolchain failures as evidence of this denial.
const removedPercentDiagnostic = /noncanonical '%' source operator|'%' is reserved and is not AttoLang source syntax; use Integer\.rem\(a, b\) or Integer\.mod\(a, b\)/;
test('removed-percent diagnostic recognizes only the specific language denial',()=>{
  for(const message of [
    "noncanonical '%' source operator",
    "'%' is reserved and is not AttoLang source syntax; use Integer.rem(a, b) or Integer.mod(a, b) at byte 33"
  ]) assert.match(message,removedPercentDiagnostic);
  for(const message of [
    "native public module wrapper is not supported in the i64 subset",
    "compiler not found","invalid WebAssembly artifact","unexpected '%' token"
  ]) assert.doesNotMatch(message,removedPercentDiagnostic);
});

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const required=process.env.ORESLANG_NUMERIC_PARITY_REQUIRED==='1'||process.env.ORESLANG_REQUIRE_REAL_COMPILER==='1';
test('actual LLVM -> wasm32 source rejects legacy % and executes unchanged multiplication', {
  skip:!compiler&&!required,
  timeout:180000
},async()=>{
  assert.ok(compiler,'real Wasm parity required: no LLVM compiler, never skip mandatory native execution');
  const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const sourceSha=process.env.ORESLANG_LLVM_SOURCE_SHA;
  assert.match(compilerSha256||'',/^[a-f0-9]{64}$/,'required pinned compiler digest');
  assert.match(sourceSha||'',/^[a-f0-9]{40}$/,'required pinned native LLVM source revision');
  const dir=await mkdtemp(join(tmpdir(),'oreslang-canonical-no-percent-wasm-'));
  try{
    for(const [id,expr] of corpus){
      const input=join(dir,id+'.ores'),output=join(dir,id+'.wasm');
      await writeFile(input,source(expr),{flag:'wx',mode:0o600});
      if(id==='multiply-positive'){
        const built=await compileOresToWasm({
          compiler:resolve(compiler),compilerSha256,source:input,output,
          environment:'browser',publication:'atomic'
        });
        assert.equal(built.compilerSha256,compilerSha256);
        const release=await readAtomicRelease(output);
        assert.equal(release.manifest.wasmSha256,built.wasmSha256);
        assert.deepEqual(release.manifest.imports,[]);
        assert.deepEqual(release.manifest.requiredCapabilities,[]);
        const actual=await runIsolatedCoreGuest(release.wasm,{
          expectedSha256:built.wasmSha256,timeoutMs:5000
        });
        assert.equal(actual.value,42n);
        assert.equal(actual.admission.hostCapabilities,0);
      }else{
        await assert.rejects(
          ()=>compileOresToWasm({
            compiler:resolve(compiler),compilerSha256,source:input,output,
            environment:'browser',publication:'atomic'
          }),
          removedPercentDiagnostic,
          id+' must be rejected by the real compiler for the RIGHT reason'
        );
        await assert.rejects(()=>readFile(output),{code:'ENOENT'},
          id+' published a Wasm artifact after source rejection');
      }
    }
  }finally{await cleanupRealCompilerWorkspace(dir);}
});
