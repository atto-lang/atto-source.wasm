import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {compileOresToWasm,readBoundedRegularFile} from '../scripts/compile-ores.mjs';
import {readAtomicRelease} from '../scripts/atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';

const cases=[
 ['canonical','9376b682711bd81d5a136b055ac3b8a31f61a784','fnc yes(bool x):bool{return x;} pub fnc main():int{if yes(true) then return 42; fi return 0;}',42n],
 ['alias-param','1d63d115f2dbdc155a0bba284a193e9b47464e50','fnc yes(boolean x):bool{return x;} pub fnc main():int{if yes(true) then return 42; fi return 0;}',42n],
 ['alias-return','c4c0d2611d1af2d4ed43beed6273d8cdfadc9d58','fnc yes(bool x):boolean{return x;} pub fnc main():int{if yes(false) then return 0; fi return 42;}',42n],
 ['typed-local','61e1beae3726a37e244b8169acc15cc65e2a54d7','pub fnc main():int{val boolean x=true; if x then return 42; fi return 0;}',42n],
 ['bad-value','378dc816a656da784bf217c2645b33627667aabf','fnc yes(boolean x):bool{return x;} pub fnc main():int{if yes(1) then return 42; fi return 0;}',null,/argument|bool|type mismatch/i],
 ['wrong-case','c6555201a174f31fa788cce17bad2fd5de7c0e08','fnc yes(Boolean x):bool{return true;} pub fnc main():int{if yes(true) then return 42; fi return 0;}',null,/unknown|class|type|unsupported/i],
];
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=s=>Buffer.from(s+'\n');
const gitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const digest=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const required=process.env.ATTO_BOOLEAN_ALIAS_WASM_REQUIRED==='1';
test('shared Boolean alias fixture bytes match Rust and native LLVM',()=>{
 assert.equal(new Set(cases.map(c=>c[0])).size,6);
 for(const [id,blob,source] of cases)assert.equal(gitBlob(bytes(source)),blob,id);
});
test('exact LLVM Boolean alias head to Wasm32 atomic release and isolated guest',{
 skip:!compiler&&!digest&&!required,timeout:180000
},async()=>{
 assert.ok(compiler&&isAbsolute(compiler),'real absolute compiler required');
 assert.match(digest||'',/^[a-f0-9]{64}$/);
 assert.equal(process.env.ORESLANG_LLVM_SOURCE_SHA,'2c8e37d24f678fd5713209870eb031527cf40268');
 assert.equal(process.env.ORESLANG_LLVM_SOURCE_TREE,'6e0c71de976ad24c62a25db6ab38330a989c4640');
 assert.equal(sha((await readBoundedRegularFile(compiler,256*1024*1024)).bytes),digest);
 const dir=await mkdtemp(join(tmpdir(),'atto-boolean-alias-wasm-'));
 try{
  for(const [id,blob,source,want,diagnostic] of cases){
   const input=join(dir,id+'.atto'),output=join(dir,id+'.wasm');
   const b=bytes(source);
   assert.equal(gitBlob(b),blob);
   await writeFile(input,b,{flag:'wx',mode:0o400});
   const build=()=>compileOresToWasm({compiler,compilerSha256:digest,source:input,output,environment:'browser',publication:'atomic'});
   if(want===null){
    await assert.rejects(build,e=>{
     assert.equal(e.status,1);assert.equal(e.signal,null);assert.equal(e.stdout,'');
     assert.match(String(e.stderr),diagnostic);return true;
    });
    for(const suffix of ['', '.artifact.json','.provenance.json','.current.json','.releases'])
     await assert.rejects(stat(output+suffix),{code:'ENOENT'});
    console.log('PASS reject',id,blob);
   }else{
    const built=await build(),release=await readAtomicRelease(output);
    assert.equal(built.sourceSha256,sha(b));assert.equal(built.compilerSha256,digest);
    assert.equal(built.wasmSha256,sha(release.wasm));
    assert.equal(release.manifest.wasmSha256,built.wasmSha256);
    const result=await runIsolatedCoreGuest(release.wasm,{expectedSha256:built.wasmSha256,timeoutMs:5000});
    assert.equal(result.value,want);assert.equal(result.admission.imports,0);assert.equal(result.admission.hostCapabilities,0);
    console.log('PASS guest',id,blob,String(want));
   }
   assert.equal(gitBlob(await readFile(input)),blob);
  }
 }finally{await rm(dir,{recursive:true,force:true})}
});
