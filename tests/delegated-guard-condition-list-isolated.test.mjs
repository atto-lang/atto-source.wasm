import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
const required=process.env.ATTO_REQUIRE_DELEGATED_GUARD==='1';
const sha=(b,alg='sha256')=>createHash(alg).update(b).digest('hex');
const blob=b=>sha(Buffer.concat([Buffer.from('blob '+b.length+'\0'),b]),'sha1');
const fixtures=[
 ['truth-table','bdd0bef8ed41125819515d2ebb08362c524febb4',true],
 ['keyword-short-circuit','f3442ff5286983278cbecc01255d0184869580cf',true],
 ['reject-non-bool','b746291a1611302773e7c3fc57aa2b02ed44c82b',false],
 ['reject-fallthrough','11949e9065098f4e994d49afd48decde01cf969c',false],
];
test('delegated exact LLVM frontend guard guest with standalone isolated worker', {skip:!required&&!process.env.ATTO_GUARD_COMPILER,timeout:60000},async t=>{
 const compiler=process.env.ATTO_GUARD_COMPILER,dir=process.env.ATTO_SHARED_GUARD_DIR,pin=process.env.ATTO_GUARD_COMPILER_SHA256;
 assert.ok(compiler&&isAbsolute(compiler)&&dir&&isAbsolute(dir));
 assert.match(pin||'',/^[0-9a-f]{64}$/);assert.equal(sha(readFileSync(compiler)),pin);
 const work=mkdtempSync(join(tmpdir(),'atto-guard-'));
 try{
  for(const [name,expected,positive] of fixtures){
   const input=join(dir,name+'.atto'),output=join(work,name+'.wasm');
   assert.equal(blob(readFileSync(input)),expected);
   const result=spawnSync(compiler,[input,'-o',output],{encoding:'utf8',timeout:10000});
   assert.ifError(result.error);assert.equal(result.signal,null);
   if(!positive){assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/E_(TYPE|GUARD|SYNTAX|UNSUPPORTED|RETURN)/);assert.equal(existsSync(output),false);const denied=spawnSync(compiler,['--isolated-core',input,'-o',output],{encoding:'utf8',timeout:10000});assert.equal(denied.status,1,denied.stderr);assert.equal(existsSync(output),false);t.diagnostic('DENIAL '+name+' '+result.stderr.trim());continue;}
   assert.equal(result.status,0,result.stderr);
   const bytes=readFileSync(output),digest=sha(bytes);
   // Distinguish successful compiler output from isolated host admission.
   const raw=await WebAssembly.instantiate(bytes,{});
   assert.equal(raw.instance.exports.main(),42n);assert.equal(raw.instance.exports.panic_code.value,0);
   t.diagnostic('COMPILER_GUEST '+name+' '+digest+' return=42 panic=0');
   await assert.rejects(runIsolatedCoreGuest(bytes,{expectedSha256:digest,timeoutMs:5000}),/bounded linear memory/);
   const isolated=join(work,name+'.isolated.wasm');
   const build=spawnSync(compiler,['--isolated-core',input,'-o',isolated],{encoding:'utf8',timeout:10000});
   assert.ifError(build.error);assert.equal(build.status,0,build.stderr);
   const isolatedBytes=readFileSync(isolated),isolatedDigest=sha(isolatedBytes);
   const module=new WebAssembly.Module(isolatedBytes);
   assert.deepEqual(WebAssembly.Module.imports(module),[]);
   assert.deepEqual(WebAssembly.Module.exports(module).map(e=>e.name).sort(),['main','memory']);
   const instance=new WebAssembly.Instance(module,{});
   assert.equal(instance.exports.memory.buffer.byteLength,65536);
   assert.throws(()=>instance.exports.memory.grow(1),RangeError);
   const observed=await runIsolatedCoreGuest(isolatedBytes,{expectedSha256:isolatedDigest,timeoutMs:5000});
   assert.equal(observed.value,42n);assert.equal(observed.admission.sha256,isolatedDigest);
   assert.equal(observed.admission.imports,0);assert.equal(observed.admission.hostCapabilities,0);
   assert.equal(observed.admission.memoryInitialPages,1);assert.equal(observed.admission.memoryMaximumPages,1);
   t.diagnostic('ISOLATED_WORKER '+name+' '+isolatedDigest);
  }
  const overflow=join(work,'overflow.atto'),overflowOut=join(work,'overflow.wasm');
  const {writeFileSync}=await import('node:fs');
  writeFileSync(overflow,'fnc inc(int x):int{return x+1;} pub fnc main():int{return inc(9223372036854775807);}');
  const trap=spawnSync(compiler,['--isolated-core',overflow,'-o',overflowOut],{encoding:'utf8',timeout:10000});
  assert.equal(trap.status,0,trap.stderr);
  await assert.rejects(runIsolatedCoreGuest(readFileSync(overflowOut),{timeoutMs:5000}),/wasm runtime trap/);
 }finally{rmSync(work,{recursive:true,force:true});}
});
