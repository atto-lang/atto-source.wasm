import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {admitCoreGuest} from '../src/guest-admission.mjs';

function scalarWasm(){
 const dir=mkdtempSync(join(tmpdir(),'ores-wasm-fuzz-'));
 try{
  const out=join(dir,'fixture.wasm');
  const ir='target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n';
  const r=spawnSync(process.env.CLANG||'clang',[
   '--target=wasm32','-x','ir','-Oz','-nostdlib',
   '-Wl,--no-entry','-Wl,--export=main',
   '-Wl,--initial-memory=131072','-Wl,--max-memory=131072',
   '-o',out,'-'
  ],{input:ir,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)throw Error(r.error?.message||r.stderr);
  return readFileSync(out);
 }finally{rmSync(dir,{recursive:true,force:true});}
}
function* mutations(bytes){
 // Deterministic reproducible corpus, including core module header and
 // length/ABI/type/code sections. Every byte gets at most a bounded probe.
 let s=0x8a2d69f1;
 for(let i=0;i<160;i++){
  s=(Math.imul(s,1664525)+1013904223)>>>0;
  const pos=s%bytes.length;
  const flip=1<<((s>>>24)&7);
  const altered=Uint8Array.from(bytes);
  altered[pos]^=flip;
  yield altered;
 }
}
test('mutation corpus never bypasses an authentic byte digest',()=>{
 const base=scalarWasm();
 const pinned=createHash('sha256').update(base).digest('hex');
 assert.equal(admitCoreGuest(base,{expectedSha256:pinned}).sha256,pinned);
 let count=0;
 for(const changed of mutations(base)){
  assert.throws(()=>admitCoreGuest(changed,{expectedSha256:pinned}),/SHA-256 mismatch/);
  count++;
 }
 assert.equal(count,160);
});
test('unpinned mutated modules cannot fabricate capabilities, memory or ABI metadata',()=>{
 const base=scalarWasm();
 let count=0,accepted=0;
 for(const changed of mutations(base)){
  try{
   const claim=admitCoreGuest(changed);
   accepted++;
   assert.equal(claim.sha256,createHash('sha256').update(changed).digest('hex'));
   assert.equal(claim.imports,0);
   assert.equal(claim.hostCapabilities,0);
   assert.equal(claim.entry,'main');
   assert.equal(claim.profile,'core-wasm.i64-v1');
   assert.equal(claim.memoryMaximumPages,2);
   assert.ok(claim.memoryInitialPages<=claim.memoryMaximumPages);
  }catch(error){
   // The host is permitted to reject *any* mutation. However, regression
   // assertions above must not be swallowed as expected parse failures.
   if(error?.code==='ERR_ASSERTION')throw error;
  }
  count++;
 }
 assert.equal(count,160);
 assert.ok(accepted<=count);
});
