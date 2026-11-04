import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runExperimentalProcessGuest} from '../src/process-guest-runner.mjs';
const simple=Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,126,3,2,1,0,
  5,4,1,1,1,2,7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,10,6,1,4,0,66,42,11]);
const opt={unsafeDevelopmentMode:true,timeoutMs:2500};
function compile(ir, extra=[]){
  const dir=mkdtempSync(join(tmpdir(),'atto-guest-process-'));
  const path=join(dir,'guest.wasm');
  try{
    const args=['--target=wasm32','-x','ir','-O0','-nostdlib',
      '-Wl,--no-entry','-Wl,--export=main','-Wl,--initial-memory=131072',
      '-Wl,--max-memory=131072',...extra,'-o',path,'-'];
    const r=spawnSync(process.env.CLANG||'clang',args,{input:ir,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(r.status,0,r.stderr||r.error?.message);
    return readFileSync(path);
  }finally{rmSync(dir,{force:true,recursive:true});}
}
test('disabled by default, no implication of OS-sandbox authorization',async()=>{
  await assert.rejects(runExperimentalProcessGuest(simple),/UNTRUSTED_PROCESS_SANDBOX_NOT_IMPLEMENTED/);
  await assert.rejects(runExperimentalProcessGuest(simple,{unsafeDevelopmentMode:false}),/UNTRUSTED_PROCESS_SANDBOX_NOT_IMPLEMENTED/);
});
test('real core Wasm is JIT-compiled and invoked in a separate Node process',async()=>{
  assert.equal(WebAssembly.validate(simple),true);
  const result=await runExperimentalProcessGuest(simple,opt);
  assert.equal(result.value,42n);
  assert.equal(result.admission.sha256,createHash('sha256').update(simple).digest('hex'));
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.admission),true);
  assert.equal(Object.isFrozen(result.execution),true);
  assert.throws(()=>{result.admission.sha256='0'.repeat(64);},TypeError);
  assert.equal(result.execution.actualWasmGuestExecuted,true);
  assert.equal(result.execution.hostileSandboxCertified,false);
  assert.equal(result.execution.attolangActorExecuted,false);
});
test('explicit artifact pin must bind the bytes actually executed',async()=>{
  const sha=createHash('sha256').update(simple).digest('hex');
  assert.equal((await runExperimentalProcessGuest(simple,{...opt,expectedSha256:sha})).value,42n);
  await assert.rejects(runExperimentalProcessGuest(simple,{...opt,expectedSha256:'f'.repeat(64)}),/SHA-256 mismatch/);
});
test('reject forged or irrelevant launch configuration',async()=>{
  await assert.rejects(runExperimentalProcessGuest(simple,{...opt,requireOsSandbox:false}),/invalid process runner options/);
  await assert.rejects(runExperimentalProcessGuest(simple,{...opt,timeoutMs:0}),/invalid timeoutMs/);
  await assert.rejects(runExperimentalProcessGuest(simple,{...opt,maxMemoryPages:257}),/invalid maxMemoryPages/);
});
test('no SharedArrayBuffer races at submission',async()=>{
  const input=new Uint8Array(new SharedArrayBuffer(simple.length));input.set(simple);
  await assert.rejects(runExperimentalProcessGuest(input,opt),/SharedArrayBuffer-backed/);
});
test('host-importing core Wasm is rejected before execution',async()=>{
  const wasm=compile('target triple = "wasm32-unknown-unknown"\ndeclare i64 @unauthorized()\ndefine i64 @main() { %x = call i64 @unauthorized()\n ret i64 %x }\n',['-Wl,--allow-undefined']);
  assert.ok(WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length>0);
  await assert.rejects(runExperimentalProcessGuest(wasm,opt),/host imports denied/);
});
test('nonterminating Wasm can be terminated without killing parent',async()=>{
  const spin=compile('target triple = "wasm32-unknown-unknown"\ndefine i64 @main() {\nentry:\n br label %spin\nspin:\n br label %spin\n}\n');
  await assert.rejects(runExperimentalProcessGuest(spin,{...opt,timeoutMs:350}),/execution deadline exceeded/);
  assert.equal((await runExperimentalProcessGuest(simple,opt)).value,42n);
});
test('independent invocations cannot share mutable Wasm linear memory',async()=>{
  const wasm=compile('target triple = "wasm32-unknown-unknown"\n@counter = internal global i64 0\ndefine i64 @main() {\nentry:\n %old = load i64, ptr @counter\n %new = add i64 %old, 1\n store i64 %new, ptr @counter\n ret i64 %new\n}\n');
  const [a,b]=await Promise.all([runExperimentalProcessGuest(wasm,opt),runExperimentalProcessGuest(wasm,opt)]);
  assert.equal(a.value,1n);assert.equal(b.value,1n);
});
test('guest runtime trap cannot terminate the supervisor or poison another invocation',async()=>{
  const wasm=compile('target triple = "wasm32-unknown-unknown"\ndefine i64 @main() {\nentry:\n unreachable\n}\n');
  await assert.rejects(runExperimentalProcessGuest(wasm,opt),/guest rejected or failed:/);
  assert.equal((await runExperimentalProcessGuest(simple,opt)).value,42n);
});
test('accessor, symbol and mutation-backed launch options fail closed',async()=>{
  const accessor=Object.defineProperty({...opt},'timeoutMs',{
    enumerable:true,get(){throw Error('hostile getter must never execute');}
  });
  await assert.rejects(runExperimentalProcessGuest(simple,accessor),/invalid process runner options/);
  const unknownSymbol={...opt,[Symbol('hidden')]:1};
  await assert.rejects(runExperimentalProcessGuest(simple,unknownSymbol),/invalid process runner options/);
});
test('concurrency limit rejects fifth worker and releases all four slots after confirmed exit',async()=>{
  const spin=compile('target triple = "wasm32-unknown-unknown"\ndefine i64 @main() {\nentry:\n br label %spin\nspin:\n br label %spin\n}\n');
  const running=Array.from({length:4},()=>runExperimentalProcessGuest(spin,{...opt,timeoutMs:900}));
  await assert.rejects(runExperimentalProcessGuest(simple,opt),/concurrency quota exceeded/);
  const ended=await Promise.allSettled(running);
  assert.equal(ended.length,4);
  for(const result of ended){
    assert.equal(result.status,'rejected');
    assert.match(String(result.reason),/execution deadline exceeded/);
  }
  assert.equal((await runExperimentalProcessGuest(simple,opt)).value,42n);
});
