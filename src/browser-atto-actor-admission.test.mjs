import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectAttoActorAbi,admitAttoBrowserActor,ATTO_ACTOR_ABI}
  from './browser-atto-actor-admission.mjs';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

// Hand-encoded, STRICTLY synthetic versioned fixture; this is not Rust
// compiler-backed .atto source parity. Node WebAssembly validates and executes
// the actual module. Both handler exports share a mutable guest global *within*
// one instance; independently instantiated actor memories cannot alias.
const u=n=>{
  const out=[];do{let b=n&127;n=Math.floor(n/128);if(n)b|=128;out.push(b);}while(n);return out;
};
const txt=s=>[...u(new TextEncoder().encode(s).length),...new TextEncoder().encode(s)];
const section=(id,body)=>[id,...u(body.length),...body];
const sig=(args,returns)=>[0x60,...u(args.length),...args,...u(returns.length),...returns];
const exp=(name,kind,index)=>[...txt(name),kind,...u(index)];
const body=ops=>[...u(ops.length+1),0x00,...ops];
const header=[0,97,115,109,1,0,0,0];
const base=({
  importModule='atto',importName='actor_spawn',
  handlerSignature=0x7e, memoryFlags=1,memoryMax=1,
  withStart=false, withTable=false, withActor1=true
}={})=>{
  const funcs=withActor1?3:2;
  const type=section(1,[3,...sig([0x7f],[0x7f]),...sig([],[0x7e]),
    ...sig([0x7e],[handlerSignature])]);
  const imports=section(2,[1,...txt(importModule),...txt(importName),0,0]);
  const functions=section(3,[funcs,1,...Array(funcs-1).fill(2)]);
  const table=withTable?section(4,[1,0x70,0,1]):[];
  const memory=section(5,[1,memoryFlags,1,...u(memoryMax)]);
  const globals=section(6,[2,0x7f,1,0x41,0,0x0b,
    0x7e,1,0x42,0,0x0b]);
  const exports=[...exp('main',0,1),...exp('panic_code',3,0),
    ...exp('memory',2,0),...exp('atto_actor_receive_0',0,2)];
  if(withActor1)exports.push(...exp('atto_actor_receive_1',0,3));
  const exportSec=section(7,[withActor1?5:4,...exports]);
  const start=withStart?section(8,[1]):[];
  const receive=[0x23,1,0x20,0,0x7c,0x24,1,0x23,1,0x0b];
  const code=section(10,[funcs,...body([0x42,0,0x0b]),
    ...body(receive),...(withActor1?body(receive):[])]);
  return Uint8Array.from([...header,...type,...imports,...functions,...table,
    ...memory,...globals,...exportSec,...start,...code]);
};

test('Rust integrated ABI adapter: strict import/function signatures and two independent real instances',async()=>{
  const bytes=base();
  assert.equal(WebAssembly.validate(bytes),true,'actual Node WebAssembly engine required');
  const abi=inspectAttoActorAbi(bytes,0);
  assert.deepEqual(abi.actorHandlers,['atto_actor_receive_0','atto_actor_receive_1']);
  assert.equal(abi.hasMemory,true);
  assert.equal(abi.importedFunctions,1);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const one=await admitAttoBrowserActor(bytes,sha256,0);
  const two=await admitAttoBrowserActor(bytes,sha256,1);
  const imports={atto:{actor_spawn:()=>{throw Error('nested actors forbidden')}}};
  const a=await WebAssembly.instantiate(one.module,imports);
  const b=await WebAssembly.instantiate(two.module,imports);
  assert.notEqual(a.exports.memory,b.exports.memory);
  assert.notEqual(a.exports.panic_code,b.exports.panic_code);
  assert.deepEqual([a.exports.atto_actor_receive_0(5n),
    b.exports.atto_actor_receive_1(10n),
    a.exports.atto_actor_receive_0(2n),
    b.exports.atto_actor_receive_1(1n)],[5n,10n,7n,11n]);
  assert.equal(ATTO_ACTOR_ABI,'atto.browser.actor.integrated.v1');
});

test('Rust integrated ABI adapter: reject wrong signature, host imports, table/start and memory budget',()=>{
  const candidates=[
    base({importName:'host_open'}),
    base({importModule:'malicious'}),
    base({handlerSignature:0x7f}),
    base({memoryMax:17}),
    base({memoryFlags:3,memoryMax:1}),
    base({withStart:true}),
    base({withTable:true}),
  ];
  for(const bytes of candidates)
    assert.throws(()=>inspectAttoActorAbi(bytes,0),/ATTO_ACTOR_ADMISSION/);
  assert.throws(()=>inspectAttoActorAbi(base(),3),/required actor receiver/);
  assert.throws(()=>inspectAttoActorAbi(base(),-1),/handler ID/);
  assert.throws(()=>inspectAttoActorAbi(base(),1025),/handler ID/);
  assert.throws(()=>inspectAttoActorAbi(base().subarray(0,7),0),/invalid or oversized/);
});

test('Rust integrated ABI adapter: default managed-scan does not authorize import profiles',()=>{
  assert.throws(()=>assertNoManagedWasm(base()),/host import/);
  assert.doesNotThrow(()=>assertNoManagedWasm(base(),{allowFunctionImports:true}));
});

test('Rust integrated ABI adapter: reject forged compiler digest before instantiation',async()=>{
  const bytes=base(),sha256=createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(admitAttoBrowserActor(bytes,'0'.repeat(64),0),/SHA-256 mismatch/);
  await assert.doesNotReject(admitAttoBrowserActor(bytes,sha256,1));
});
