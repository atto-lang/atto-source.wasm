// Dedicated verification lane, not a production compiler publication API.
// The ordinary Wasm bridge remains fail-closed for unsupported actors.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
const compiler=process.env.ATTO_LLVM_COMPILER;
const expectedSha=process.env.ATTO_LLVM_COMPILER_SHA256;
assert.ok(compiler&&isAbsolute(compiler)&&/^[0-9a-f]{64}$/.test(expectedSha||''),'absolute pinned compiler required');
const hash=b=>createHash('sha256').update(b).digest('hex');
assert.ok(statSync(compiler).isFile()&&statSync(compiler).size<=256*1024*1024);
const bytes=readFileSync(compiler);assert.equal(hash(bytes),expectedSha);
const work=mkdtempSync(join(tmpdir(),'atto-wasm-durable-'));
const source='define durable actor Counter as state count: int = 0; receive(ActorMail<int> mail) -> void { self.count = self.count + mail.value; } end';
function run(bin,args){
  const r=spawnSync(bin,args,{cwd:work,encoding:'utf8',timeout:60000,maxBuffer:1<<20});
  assert.equal(r.error,undefined);assert.equal(r.signal,null);return r;
}
try{
  const pinned=join(work,'compiler');
  writeFileSync(pinned,bytes,{flag:'wx',mode:0o500});
  function emit(text,ok=true){
    writeFileSync(join(work,'counter.atto'),text);
    const r=run(pinned,['--durable-counter-actor-v1','counter.atto']);
    assert.equal(r.status,ok?0:2,r.stderr);
    if(!ok){assert.equal(r.stdout,'');assert.ok(r.stderr.trim());}
    return r.stdout;
  }
  const ir=emit(source);assert.equal(ir,emit(source));
  for(const bad of [
    source.replace('durable actor','actor'),
    source.replace('ActorMail<int>','ActorMail<bool>'),
    source.replace('self.count + mail.value','self.count - mail.value'),
    source+'//\u0000',source+' pub fnc main(): int { return 0; }'
  ])emit(bad,false);
  writeFileSync(join(work,'guest.ll'),ir);
  const link=run(process.env.CLANG||'clang',['--target=wasm32-unknown-unknown','-Wno-override-module','-nostdlib','-O2',
    '-Wl,--no-entry','-Wl,--export=atto_durable_transition_v1','-Wl,--export=atto_durable_state_size_v1',
    '-Wl,--export=atto_durable_state_v1','-Wl,--export-memory','-Wl,--initial-memory=131072','-Wl,--max-memory=131072','guest.ll','-o','guest.wasm']);
  assert.equal(link.status,0,link.stderr);
  const wasm=readFileSync(join(work,'guest.wasm'));assert.ok(wasm.length<=1024*1024);
  const module=new WebAssembly.Module(wasm);
  assert.deepEqual(WebAssembly.Module.imports(module),[]);
  assert.deepEqual(WebAssembly.Module.exports(module).map(x=>x.name).sort(),
    ['atto_durable_state_size_v1','atto_durable_state_v1','atto_durable_transition_v1','memory']);
  const e=new WebAssembly.Instance(module,{}).exports;
  assert.equal(e.memory.buffer.byteLength,131072);
  assert.throws(()=>e.memory.grow(1),RangeError);
  const size=e.atto_durable_state_size_v1(),ptr=e.atto_durable_state_v1();
  assert.equal(size,53n);assert.ok(ptr>=0&&ptr+Number(size)<=e.memory.buffer.byteLength);
  const descriptor=Buffer.from(new Uint8Array(e.memory.buffer,ptr,Number(size)));
  assert.equal(descriptor.toString('hex'),'0107436f756e74657205636f756e7401244154544f53543031013782cc560597ec4601000100000000000000002b35b70ef92e387a');
  let count=0;
  function compare(s,o,d){
    const expected=s<0n||s>1000000000n?-1n:o===2n?(d===0n?s:-1n):o!==1n||d<=0n||d>1000000000n||s+d>1000000000n?-1n:s+d;
    assert.equal(e.atto_durable_transition_v1(s,o,d),expected);count++;return expected;
  }
  let s=0n;for(let i=0;i<100;i++)s=compare(s,1n,1n);assert.equal(s,100n);
  for(const state of [-1n,0n,100n,999999999n,1000000000n,1000000001n])
    for(const o of [0n,1n,2n,3n])
      for(const d of [-1n,0n,1n,42n,1000000000n,1000000001n])compare(state,o,d);
  assert.equal(count,244);
  console.log(JSON.stringify({status:'LLVM_WASM_DURABLE_SCHEMA_AND_244_TRANSITIONS_PASS',compilerSha256:expectedSha,sourceSha256:hash(source),wasmSha256:hash(wasm),descriptorSha256:hash(descriptor),count,imports:0,maxPages:2,strictNoJit:false,diskRecoveryExecuted:false}));
}finally{rmSync(work,{recursive:true,force:true});}
