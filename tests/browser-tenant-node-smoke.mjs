/**
 * Explicit opt-in, REAL Node Worker + Clang wasm32 guest test.
 * Compiler source is synthetic C: NOT .atto compiler-backed browser parity.
 * Requires clang, wasm-ld and Node >= 22; Chromium has its own gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {BrowserTenantSupervisor} from '../src/browser-tenant-supervisor.mjs';

const ADAPTER = new URL('./browser-tenant-node-adapter.mjs', import.meta.url);
class NodeBrowserWorker {
  #worker;
  constructor(_url, {type} = {}) {
    if (type !== 'module') throw Error('test requires module Worker');
    this.#worker = new Worker(ADAPTER, {type: 'module'});
    this.#worker.on('message', data => this.onmessage?.({data}));
    this.#worker.on('messageerror', error => this.onmessageerror?.(error));
    this.#worker.on('error', error => this.onerror?.(error));
    this.#worker.on('exit', code => {
      if (code !== 0) this.onerror?.(Error('Node Worker exited: ' + code));
    });
  }
  postMessage(data) {this.#worker.postMessage(data);}
  terminate() {void this.#worker.terminate();}
}
function normalizeUnusedClangTable(input) {
  const parts=[input.subarray(0,8)];let at=8,seen=false;
  while(at<input.length){
    const first=at,id=input[at++];let n=0,shift=0,byte;
    do {
      if(at>=input.length||shift>28)throw Error('bad Wasm LEB');
      byte=input[at++];n+=(byte&127)*2**shift;shift+=7;
    } while(byte&128);
    if(at+n>input.length)throw Error('truncated Wasm fixture');
    if(id===4){
      if(seen||Buffer.compare(input.subarray(at,at+n),Buffer.from('0170010101','hex'))!==0)
        throw Error('unexpected Clang table; strict test fixture only');
      seen=true;
    } else parts.push(input.subarray(first,at+n));
    at+=n;
  }
  if(!seen)throw Error('expected one unused Clang table');
  const output=Buffer.concat(parts);
  if(!WebAssembly.validate(output))throw Error('normalized fixture invalid');
  return output;
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'atto-wasm-actor-node-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const file=join(root,'actor.c'),wasm=join(root,'actor.wasm');
  await writeFile(file,`static long long state;
__attribute__((export_name("oreslang_wasm_actor_init"))) void initialize(void){state=0;}
__attribute__((export_name("oreslang_wasm_actor_on_message"))) long long receive(long long v){
  if(v == -1) __builtin_trap();
  state+=v;return state;
}
__attribute__((export_name("oreslang_wasm_actor_teardown"))) void teardown(void){state=0;}
`);
  const compiled=spawnSync('clang',['--target=wasm32','-nostdlib','-O1',file,
    '-Wl,--no-entry','-Wl,--export-memory','-Wl,--initial-memory=131072',
    '-Wl,--max-memory=131072','-o',wasm],{encoding:'utf8'});
  assert.equal(compiled.status,0,'clang wasm32 required: '+(compiled.stderr||compiled.error));
  const bytes=normalizeUnusedClangTable(await readFile(wasm));
  return {name:'pinned-synthetic-c',bytes,
    sha256:createHash('sha256').update(bytes).digest('hex')};
}
function supervisor(manifest) {
  return new BrowserTenantSupervisor({
    workerUrl:'/browser-tenant-worker.mjs',
    manifest:[manifest],WorkerClass:NodeBrowserWorker,deadlineMs:10000
  });
}

test('real Wasm: two private actor instances in one tenant and separate second tenant',async t=>{
  const manifest=await fixture(t);
  const t1=supervisor(manifest),t2=supervisor(manifest);
  t.after(()=>{t1.close();t2.close();});
  const a=await t1.spawn(1,manifest.name);
  const b=await t1.spawn(2,manifest.name);
  const c=await t2.spawn(1,manifest.name);
  assert.deepEqual([
    await t1.send(a,5n),await t1.send(b,10n),await t1.send(a,2n),
    await t1.send(b,1n),await t2.send(c,3n)
  ],[5n,10n,7n,11n,3n]);
  assert.throws(()=>t2.send(a,5n),/unknown, stale/);
  await assert.rejects(t1.send(a,-1n),/actor-local Wasm unreachable/);
  assert.equal(t1.closed,false,'known unreachable did not poison tenant');
  assert.equal(await t1.send(b,1n),12n,'healthy neighbor preserved');
  assert.equal(await t2.send(c,1n),4n,'other tenant preserved');
  const reincarnated=await t1.spawn(1,manifest.name);
  assert.throws(()=>t1.send(a,1n),/unknown, stale/);
  assert.equal(await t1.send(reincarnated,3n),3n,'new actor has a fresh heap');
  assert.equal(t1.activeActors,2);
});

test('real Wasm: invalid artifact digest rejects spawn without killing tenant',async t=>{
  const manifest=await fixture(t);
  const worker=new NodeBrowserWorker('/browser-tenant-worker.mjs',{type:'module'});
  t.after(()=>worker.terminate());
  const inc='1'.repeat(32);
  const pending=new Map();
  let ticket=0;
  worker.onmessage=({data})=>{
    const p=pending.get(data.ticket);
    if(p){pending.delete(data.ticket);clearTimeout(p.timer);p.resolve(data);}
  };
  worker.onerror=error=>{
    for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(error);}
    pending.clear();
  };
  function ask(kind, extra={}){
    const id=++ticket;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Node Worker response deadline')),10000);
      pending.set(id,{resolve,reject,timer});
      worker.postMessage({ticket:id,id:1,incarnation:inc,kind,...extra});
    });
  }
  const denied=await ask('spawn',{
    bytes:manifest.bytes,approvedSha256:'0'.repeat(64),trusted:true
  });
  assert.equal(denied.kind,'rejected');
  const accepted=await ask('spawn',{
    bytes:manifest.bytes,approvedSha256:manifest.sha256,trusted:true
  });
  assert.equal(accepted.kind,'ack');
  const value=await ask('send',{value:7n});
  assert.equal(value.kind,'ack');
  assert.equal(value.result,7n);
});
