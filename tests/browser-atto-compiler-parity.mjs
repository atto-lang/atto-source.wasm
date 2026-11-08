/**
 * OPT-IN real .atto source -> Rust browser compiler-as-Wasm -> guest Wasm ->
 * multiple private guest instances on ONE tenant Worker.
 *
 * Requires a separately reviewed compiler binary from atto-lang/atto-source.rs.
 * No download/mirror occurs here; a caller-supplied digest is an identity
 * check, NOT trusted independent compiler provenance. It must be pinned by an
 * independently reviewed CI/release policy before promoting this receipt.
 *
 * Run:
 *  ATTO_COMPILER_WASM=/approved/atto_compiler.wasm \
 *  ATTO_COMPILER_SHA256=<64 lowercase hex> \
 *  ATTO_COMPILER_SOURCE_HEAD=<40 lowercase hex> \
 *  ATTO_COMPILER_SOURCE_TREE=<40 lowercase hex> \
 *    node --test tests/browser-atto-compiler-parity.mjs
 *
 * NOT part of default npm test. Missing provenance env is a FAIL, not skip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {compileApprovedAttoSource} from './helpers/approved-atto-compiler.mjs';
import {BrowserTenantSupervisor} from '../src/browser-tenant-supervisor.mjs';
import {admitAttoBrowserActor,ATTO_ACTOR_ABI}
  from '../src/browser-atto-actor-admission.mjs';

const ADAPTER=new URL('./browser-atto-tenant-node-adapter.mjs',import.meta.url);
class NodeModuleWorker {
  #worker;
  constructor(_url,{type}={}){
    assert.equal(type,'module');
    this.#worker=new Worker(ADAPTER,{type:'module'});
    this.#worker.on('message',data=>this.onmessage?.({data}));
    this.#worker.on('messageerror',e=>this.onmessageerror?.(e));
    this.#worker.on('error',e=>this.onerror?.(e));
  }
  postMessage(data){this.#worker.postMessage(data);}
  terminate(){void this.#worker.terminate();}
}
test('review-gated compiler: actual .atto actor guest runs in two instances/tenant',async t=>{
  const {guest,sourceHead:head,sourceTree:tree,
    compilerSha256:actual,guestSha256:guestDigest}=await compileApprovedAttoSource();
  const admitted=await admitAttoBrowserActor(guest,guestDigest,0);
  assert.equal(admitted.abi.actorId,0);
  const manifest=[{name:'reviewed-atto-guest',bytes:guest,sha256:guestDigest,
    profile:ATTO_ACTOR_ABI,actorId:0}];
  const mk=()=>new BrowserTenantSupervisor({
    workerUrl:'/browser-atto-tenant-worker.mjs',
    WorkerClass:NodeModuleWorker,manifest,deadlineMs:8000
  });
  const one=mk(),two=mk();
  t.after(()=>{one.close();two.close();});
  const a=await one.spawn(1,'reviewed-atto-guest');
  const b=await one.spawn(2,'reviewed-atto-guest');
  const c=await two.spawn(1,'reviewed-atto-guest');
  assert.deepEqual([await one.send(a,41n),await one.send(b,42n),
    await one.send(a,43n),await two.send(c,44n)],[42n,43n,44n,45n]);
  assert.throws(()=>two.send(a,1n),/unknown, stale/);
  await one.stop(a);
  assert.throws(()=>one.send(a,1n),/unknown, stale/);
  const restarted=await one.spawn(1,'reviewed-atto-guest');
  assert.equal(await one.send(restarted,41n),42n);
  assert.equal(await one.send(b,42n),43n);
  assert.equal(await two.send(c,44n),45n);
  console.log(JSON.stringify({sourceHead:head,sourceTree:tree,
    compilerSha256:actual,guestSha256:guestDigest,
    guestAbi:ATTO_ACTOR_ABI,actorReceipts:7}));
});
