import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
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
const browserRequired=process.env.ATTO_SHARED_BROWSER_REQUIRED??'0';
assert.ok(['0','1'].includes(browserRequired),'invalid browser gate mode');
const browser=process.env.ATTO_SHARED_BROWSER;
if(browserRequired==='1'){
  assert.ok(browser && isAbsolute(browser),'absolute browser executable required');
  const version=spawnSync(browser,['--version'],{encoding:'utf8',timeout:10000});
  assert.ifError(version.error);
  assert.equal(version.status,0,version.stderr);
  console.log('SHARED_WASM_BROWSER_VERSION='+version.stdout.trim());
}
async function runBrowser(bytes,expected,name){
  const work=await mkdtemp(join(tmpdir(),'atto-shared-browser-'));
  try {
    const html=join(work,'guest.html');
    // Only the pinned, no-import compiled fixture bytes enter the browser.
    // No network request or injected result from the Node oracle.
    const payload=Buffer.from(bytes).toString('base64');
    await writeFile(html,'<!doctype html><meta charset="utf-8"><pre id="result">PENDING</pre><script>'+
      'try{const b=Uint8Array.from(atob('+JSON.stringify(payload)+'),c=>c.charCodeAt(0));'+
      'const m=new WebAssembly.Module(b);if(WebAssembly.Module.imports(m).length!==0)throw Error("imports");'+
      'const instance=new WebAssembly.Instance(m,{});const value=instance.exports.main();'+
      'if(typeof value!=="bigint")throw Error("expected i64");'+
      'document.getElementById("result").textContent="PASS:"+String(value);'+
      '}catch(e){document.getElementById("result").textContent="FAIL:"+e.message;}</script>',{flag:'wx'});
    const run=spawnSync(browser,['--headless','--disable-gpu','--disable-dev-shm-usage',
      '--no-first-run','--no-default-browser-check','--disable-background-networking',
      '--user-data-dir='+join(work,'profile'),'--dump-dom',pathToFileURL(html).href],
      {encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
    assert.ifError(run.error);
    assert.equal(run.status,0,run.stderr?.slice(-2000));
    assert.ok(run.stdout.includes('<pre id="result">PASS:'+expected+'</pre>'),run.stdout.slice(0,500));
    console.log('SHARED_WASM_REAL_BROWSER_EXECUTED='+name+':'+expected);
  } finally { await rm(work,{recursive:true,force:true}); }
}
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
    if(browserRequired==='1')await runBrowser(release.wasm,expected,name);
  }
} finally { await cleanupRealCompilerWorkspace(dir); }
console.log('SHARED_WASM_REQUIRED_GATE=PASS; Node execution verified');
if(browserRequired==='1')console.log('SHARED_WASM_REAL_BROWSER_GATE=PASS; direct WebAssembly browser execution, not browser runtime integration');
