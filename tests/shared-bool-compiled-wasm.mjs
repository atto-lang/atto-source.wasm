import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {compileOresToWasm} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {cleanupRealCompilerWorkspace} from '../scripts/cleanup-real-compiler.mjs';

// Mandatory explicit gate: no absent-compiler skips and no source oracle.
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha256=process.env.ORESLANG_LLVM_COMPILER_SHA256;
assert.ok(compiler && isAbsolute(compiler),'absolute compiler path required');
assert.match(compilerSha256??'',/^[0-9a-f]{64}$/);
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(await readFile(compiler)),compilerSha256);
const fixture=await readFile(new URL('./fixtures/core-types-v1/bool-call-composition-positive.atto',import.meta.url));
assert.equal(createHash('sha1').update(Buffer.from('blob '+fixture.length+'\0')).update(fixture).digest('hex'),'823fd7cf37b8303880057df2b3b436daf5cd08a8');
const dir=await mkdtemp(join(tmpdir(),'atto-shared-bool-'));
try {
  for(const [name,bytes,expected] of [
    ['control',Buffer.from('pub fnc main():int { return 42; }'),42n],
    ['shared',fixture,0n]
  ]){
    const source=join(dir,name+'.atto'),output=join(dir,name+'.wasm');
    await writeFile(source,bytes,{flag:'wx'});
    const built=await compileOresToWasm({compiler,compilerSha256,source,output,environment:'browser',publication:'atomic'});
    const release=await readAtomicRelease(output);
    assert.equal(built.sourceSha256,sha(bytes));
    assert.equal(built.wasmSha256,sha(release.wasm));
    assert.equal(release.manifest.environment,'browser');
    assert.equal(release.manifest.producer.compilerSha256,compilerSha256);
    const guest=await runIsolatedCoreGuest(release.wasm,{expectedSha256:built.wasmSha256,timeoutMs:5000});
    assert.equal(guest.value,expected);
    assert.equal(guest.admission.imports,0);
    assert.equal(guest.admission.hostCapabilities,0);
    console.log('SHARED_WASM_EXECUTED='+name+':'+guest.value);
  }
} finally { await cleanupRealCompilerWorkspace(dir); }
console.log('SHARED_WASM_REQUIRED_GATE=PASS; browser-profile module executed in Node, not a browser');
