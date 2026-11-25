import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {compileOresToWasm,readBoundedRegularFile} from './compile-ores.mjs';
import {readAtomicRelease} from './atomic-release.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
const [compiler,pin,head,tree,clang,wasmLinker]=process.argv.slice(2);
if(!compiler||!clang||!wasmLinker||! /^[a-f0-9]{64}$/.test(pin??'')||! /^[a-f0-9]{40}$/.test(head??'')||! /^[a-f0-9]{40}$/.test(tree??''))
 throw Error('usage: node scripts/verify-llvm-quantity-wasm32.mjs compiler sha256 head tree clang wasm-ld');
const sha=x=>createHash('sha256').update(x).digest('hex');
const work=await mkdtemp(join(tmpdir(),'atto-llvm-quantity-wasm-'));
try{
 const executable=join(work,'compiler');
 const bytes=(await readBoundedRegularFile(resolve(compiler),256*1024*1024,'compiler bytes')).bytes;
 assert.equal(sha(bytes),pin);
 await writeFile(executable,bytes,{mode:0o500,flag:'wx'});
 const pre='define dimension Time; define unit Second: Time; define unit Millis: Time = Second / 1000;';
 const ref='type Positive = int where self > 0 and units in Second;';
 const src=(expr,typed=false)=>pre+(typed?ref:'')+'\npub fnc main() -> int { return '+expr+'; }';
 const positives=[
  ['compact',src('84<Second> / 2<Second>')],
  ['dot',src('84.<Second> / 2.<Second>')],
  ['legacy',src('84::<Second> / 2::<Second>')],
  ['keyword',src('(84 as Second) / (2 as Second)')],
  ['prefix',src('(<i64>42).<Second> / 1<Second>')],
  ['postfix',src('42::<i64>.<Second> / 1<Second>')],
  ['refinement-prefix',src('(<Positive>(42.<Second>)) / 1<Second>',true)],
  ['refinement-postfix',src('(42.<Second>::<Positive>) / 1<Second>',true)],
  ['refinement-keyword',src('(42.<Second> as Positive) / 1<Second>',true)],
  ['conversion',src('42000.<Millis>.to_unit<Second>() / 1<Second>')]
 ];
 for(const [id,source] of positives){
  const input=join(work,id+'.atto'),output=join(work,id+'.wasm');
  await writeFile(input,source,{flag:'wx'});
  const pub=await compileOresToWasm({compiler:executable,compilerSha256:pin,source:input,output,clang:resolve(clang),wasmLinker:resolve(wasmLinker),environment:'browser',publication:'atomic'});
  const release=await readAtomicRelease(output);
  assert.equal(pub.compilerSha256,pin,id);
  assert.equal(pub.sourceSha256,sha(source),id);
  assert.equal(pub.wasmSha256,sha(release.wasm),id);
  assert.equal(release.manifest.wasmSha256,pub.wasmSha256,id);
  const observed=await runIsolatedCoreGuest(release.wasm,{expectedSha256:pub.wasmSha256,timeoutMs:5000});
  assert.equal(observed.value,42n,id);
  assert.equal(observed.admission.hostCapabilities,0,id);
  console.log('WASM32_QUANTITY_PASS '+id+' '+pub.wasmSha256);
 }
 const negatives=[
  ['erasure',src('42<Second>::<i64>'),'E_UNIT_ERASURE'],
  ['retag',src('42.<Second>.<Second>'),'E_UNIT_ATTACHMENT'],
  ['wrong-scale',src('(42<Millis> as Positive) / 1<Second>',true),'E_UNIT_SCALE'],
  ['unknown-unit',src('42.<Missing>'),'E_UNIT_NAME']
 ];
 for(const [id,source,code] of negatives){
  const input=join(work,id+'.atto'),output=join(work,id+'.wasm');
  await writeFile(input,source,{flag:'wx'});
  const rejection=spawnSync(executable,['--tree-shake','--tree-shake-root=main','--target=wasm32',input],{cwd:work,encoding:'utf8',timeout:30000});
  if(rejection.error)throw rejection.error;
  assert.equal(rejection.signal,null,id);assert.equal(rejection.status,1,id+': '+rejection.stderr);
  assert.equal(rejection.stdout.trim(),'',id);assert.match(rejection.stderr,new RegExp(code+':'),id);
  await assert.rejects(compileOresToWasm({compiler:executable,compilerSha256:pin,source:input,output,clang:resolve(clang),wasmLinker:resolve(wasmLinker),environment:'browser',publication:'atomic'}),new RegExp(code+':'),id);
  assert.ok(!(await readdir(work)).some(n=>n.startsWith(id+'.wasm')),id+' published rejected artifact');
  console.log('WASM32_QUANTITY_REJECT '+id+' '+code);
 }
 assert.equal(sha(await readFile(executable)),pin);
 console.log('LLVM_COMPILER '+head+' '+tree+' '+pin);
 console.log('WASM32_QUANTITY_VERIFIED '+(positives.length+negatives.length)+' cases');
}finally{await rm(work,{recursive:true,force:true});}
