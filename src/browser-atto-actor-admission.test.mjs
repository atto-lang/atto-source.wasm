import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeSyntheticAttoActorGuest} from '../tests/fixtures/synthetic-atto-integrated-actor.mjs';
import {inspectAttoActorAbi,admitAttoBrowserActor,ATTO_ACTOR_ABI}
  from './browser-atto-actor-admission.mjs';
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';

// Hand-encoded, STRICTLY synthetic versioned fixture; this is not Rust
// compiler-backed .atto source parity. Node WebAssembly validates and executes
// the actual module. Both handler exports share a mutable guest global *within*
// one instance; independently instantiated actor memories cannot alias.
const base=makeSyntheticAttoActorGuest;

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
