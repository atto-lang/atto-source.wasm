import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const PAGE=65536;
function faultSecondBufferRead(action) {
  const base=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer');
  assert.equal(base.configurable,true,'host memory descriptor must be restorable');
  let reads=0;
  Object.defineProperty(WebAssembly.Memory.prototype,'buffer',{
    ...base,
    get(){
      if(++reads===2)throw Error('injected precommit buffer access fault');
      return base.get.call(this);
    }
  });
  try {
    assert.throws(action,/injected precommit buffer access fault/);
    assert.equal(reads,2,'fault must occur after plan/token preparation');
  } finally {
    Object.defineProperty(WebAssembly.Memory.prototype,'buffer',base);
  }
}

test('failed persistent arena preparation cannot strand high-water quota',()=>{
  const arena=new ActorArena({actorId:110,incarnation:1,kind:'private'});
  const turn=arena.beginTurn();
  faultSecondBufferRead(()=>arena.allocPersistent(turn,PAGE));
  const token=arena.allocPersistent(turn,PAGE);
  assert.equal(arena.read(turn,token).length,PAGE);
  assert.throws(()=>arena.allocPersistent(turn,1),/quota exhausted/);
  arena.dropPersistent(turn,token);
  arena.endTurn(turn);
  arena.retire();
});

test('failed free-segment preparation retains the entire reusable segment',()=>{
  const arena=new ActorArena({actorId:111,incarnation:1,kind:'untrusted'});
  const turn=arena.beginTurn();
  const previous=arena.allocPersistent(turn,128);
  const remainder=arena.allocPersistent(turn,PAGE-128);
  arena.write(turn,previous,new Uint8Array(128).fill(71));
  arena.dropPersistent(turn,previous);
  faultSecondBufferRead(()=>arena.allocPersistent(turn,128));
  const reused=arena.allocPersistent(turn,128);
  assert.deepEqual([...arena.read(turn,reused)],Array(128).fill(0));
  assert.throws(()=>arena.read(turn,previous),/stale/);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,remainder);
  arena.endTurn(turn);
  arena.retire();
});

test('failed scratch preparation does not consume disposable turn capacity',()=>{
  const arena=new ActorArena({actorId:112,incarnation:1});
  const turn=arena.beginTurn();
  faultSecondBufferRead(()=>arena.allocScratch(turn,PAGE));
  const token=arena.allocScratch(turn,PAGE);
  assert.equal(arena.read(turn,token).length,PAGE);
  assert.throws(()=>arena.allocScratch(turn,1),/quota exhausted/);
  arena.endTurn(turn);
  const next=arena.beginTurn();
  assert.equal(arena.read(next,arena.allocScratch(next,PAGE)).length,PAGE);
  arena.endTurn(next);
  arena.retire();
});

function withPatchedMethod(proto, name, replacement, action) {
  const original = Object.getOwnPropertyDescriptor(proto, name);
  assert.ok(original?.configurable, 'test requires restorable host method');
  Object.defineProperty(proto, name, {...original, value:replacement});
  try { return action(); }
  finally { Object.defineProperty(proto, name, original); }
}

test('foreign arena handles cannot be forged through patched WeakMap.get', () => {
  const arena=new ActorArena({actorId:113,incarnation:1});
  const turn=arena.beginTurn();
  const owned=arena.allocPersistent(turn,8);
  arena.write(turn,owned,new Uint8Array(8).fill(77));
  const foreign=Object.freeze({});
  withPatchedMethod(WeakMap.prototype,'get',()=>({offset:0,length:8}),()=>{
    assert.throws(()=>arena.read(turn,foreign),/foreign or stale arena handle/);
    assert.deepEqual([...arena.read(turn,owned)],Array(8).fill(77));
  });
  arena.dropPersistent(turn,owned);
  arena.endTurn(turn);
  arena.retire();
});

test('persistent handle revocation survives patched WeakMap.delete', () => {
  const arena=new ActorArena({actorId:114,incarnation:1});
  const turn=arena.beginTurn();
  const stale=arena.allocPersistent(turn,PAGE);
  withPatchedMethod(WeakMap.prototype,'delete',()=>false,()=>{
    arena.dropPersistent(turn,stale);
  });
  assert.throws(()=>arena.read(turn,stale),/stale/);
  const reused=arena.allocPersistent(turn,PAGE);
  arena.write(turn,reused,new Uint8Array(PAGE).fill(19));
  assert.throws(()=>arena.read(turn,stale),/stale/,
    'freed token must never alias a new owner of the same region');
  arena.dropPersistent(turn,reused);
  arena.endTurn(turn);
  arena.retire();
});

test('persistent free-list commit survives patched Array.push and Array.sort', () => {
  for(const name of ['push','sort']) {
    const arena=new ActorArena({actorId:name==='push'?115:116,incarnation:1});
    const turn=arena.beginTurn();
    const stale=arena.allocPersistent(turn,PAGE);
    withPatchedMethod(Array.prototype,name,()=>{throw Error('patched '+name);},()=>{
      arena.dropPersistent(turn,stale);
    });
    assert.throws(()=>arena.read(turn,stale),/stale/);
    const reused=arena.allocPersistent(turn,PAGE);
    assert.ok(arena.read(turn,reused).every(value=>value===0));
    arena.dropPersistent(turn,reused);
    arena.endTurn(turn);
    arena.retire();
  }
});

test('owned read cannot expose live arena memory through patched Uint8Array.slice', () => {
  const arena=new ActorArena({actorId:117,incarnation:1});
  const turn=arena.beginTurn();
  const handle=arena.allocPersistent(turn,4);
  arena.write(turn,handle,Uint8Array.of(1,2,3,4));
  let calls=0;
  const copy=withPatchedMethod(Uint8Array.prototype,'slice',function(start,end){
    calls++;
    return this.subarray(start,end);
  },()=>arena.read(turn,handle));
  assert.equal(calls,0,'arena read must use captured native slice');
  copy[0]=99;
  assert.deepEqual([...arena.read(turn,handle)],[1,2,3,4]);
  arena.dropPersistent(turn,handle);
  arena.endTurn(turn);
  arena.retire();
});

test('arena write ignores patched Uint8Array.set that drops payload', () => {
  const arena=new ActorArena({actorId:118,incarnation:1});
  const turn=arena.beginTurn();
  const handle=arena.allocPersistent(turn,4);
  let calls=0;
  withPatchedMethod(Uint8Array.prototype,'set',()=>{calls++;},()=>{
    arena.write(turn,handle,Uint8Array.of(9,8,7,6));
  });
  assert.equal(calls,0,'arena write must use captured native set');
  assert.deepEqual([...arena.read(turn,handle)],[9,8,7,6]);
  arena.dropPersistent(turn,handle);
  arena.endTurn(turn);
  arena.retire();
});

test('endTurn and retire zeroization survive patched Uint8Array.fill', () => {
  const arena=new ActorArena({actorId:119,incarnation:1});
  const turn=arena.beginTurn();
  const scratch=arena.allocScratch(turn,4);
  arena.write(turn,scratch,Uint8Array.of(5,6,7,8));
  let calls=0;
  withPatchedMethod(Uint8Array.prototype,'fill',()=>{calls++;throw Error('host fill override');},()=>{
    assert.doesNotThrow(()=>arena.endTurn(turn));
    assert.doesNotThrow(()=>arena.retire());
  });
  assert.equal(calls,0,'arena teardown must use captured native fill');
  assert.equal(arena.retired,true);
});
