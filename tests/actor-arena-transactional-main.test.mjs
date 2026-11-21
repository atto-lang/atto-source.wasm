import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const PAGE=65536;
// The current host captures WebAssembly.Memory.prototype.buffer before guest
// interaction. The older precommit getter-fault tests must now prove the getter
// cannot run, while still testing quota reuse and zeroed allocations.
function withPoisonedBufferGetter(action) {
  const base=Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype,'buffer');
  assert.equal(base.configurable,true,'host memory descriptor must be restorable');
  let intercepted=0;
  Object.defineProperty(WebAssembly.Memory.prototype,'buffer',{
    ...base,
    get(){intercepted++;throw Error('poisoned host memory getter');}
  });
  try {
    const result=action();
    assert.equal(intercepted,0,'arena must use its captured native memory getter');
    return result;
  } finally {
    Object.defineProperty(WebAssembly.Memory.prototype,'buffer',base);
  }
}

test('poisoned getter cannot strand persistent high-water quota',()=>{
  const arena=new ActorArena({actorId:110,incarnation:1,kind:'private'});
  const turn=arena.beginTurn();
  const token=withPoisonedBufferGetter(()=>arena.allocPersistent(turn,PAGE));
  assert.equal(arena.read(turn,token).length,PAGE);
  assert.throws(()=>arena.allocPersistent(turn,1),/quota exhausted/);
  arena.dropPersistent(turn,token);
  arena.endTurn(turn);
  arena.retire();
});

test('poisoned getter cannot corrupt reusable free-segment admission',()=>{
  const arena=new ActorArena({actorId:111,incarnation:1,kind:'untrusted'});
  const turn=arena.beginTurn();
  const previous=arena.allocPersistent(turn,128);
  const remainder=arena.allocPersistent(turn,PAGE-128);
  arena.write(turn,previous,new Uint8Array(128).fill(71));
  arena.dropPersistent(turn,previous);
  const reused=withPoisonedBufferGetter(()=>arena.allocPersistent(turn,128));
  assert.deepEqual([...arena.read(turn,reused)],Array(128).fill(0));
  assert.throws(()=>arena.read(turn,previous),/stale/);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,remainder);
  arena.endTurn(turn);
  arena.retire();
});

test('poisoned getter cannot consume disposable scratch capacity',()=>{
  const arena=new ActorArena({actorId:112,incarnation:1});
  const turn=arena.beginTurn();
  const token=withPoisonedBufferGetter(()=>arena.allocScratch(turn,PAGE));
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
  const copy=withPatchedMethod(Object.getPrototypeOf(Uint8Array.prototype),'slice',function(start,end){
    calls++;
    return this.subarray(start,end);
  },()=>arena.read(turn,handle));
  assert.equal(calls,0,'arena read must bypass patched slice and species constructors');
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
  withPatchedMethod(Object.getPrototypeOf(Uint8Array.prototype),'set',()=>{calls++;},()=>{
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
  withPatchedMethod(Object.getPrototypeOf(Uint8Array.prototype),'fill',()=>{calls++;throw Error('host fill override');},()=>{
    assert.doesNotThrow(()=>arena.endTurn(turn));
    assert.doesNotThrow(()=>arena.retire());
  });
  assert.equal(calls,0,'arena teardown must use captured native fill');
  assert.equal(arena.retired,true);
});


test('free-list reuse survives iterator patched to hide all staged spans', () => {
  const arena=new ActorArena({actorId:120,incarnation:1});
  const turn=arena.beginTurn();
  const abandoned=arena.allocPersistent(turn,8);
  const remaining=arena.allocPersistent(turn,PAGE-8);
  withPatchedMethod(Array.prototype,Symbol.iterator,function*(){},()=>{
    arena.dropPersistent(turn,abandoned);
  });
  const reused=arena.allocPersistent(turn,8);
  assert.equal(arena.read(turn,reused).length,8);
  assert.throws(()=>arena.read(turn,abandoned),/stale/);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,remaining);
  arena.endTurn(turn);
  arena.retire();
});

test('iterator-injected fake free span never overlaps live ownership', () => {
  const arena=new ActorArena({actorId:121,incarnation:1});
  const turn=arena.beginTurn();
  const abandoned=arena.allocPersistent(turn,8);
  const stillOwned=arena.allocPersistent(turn,PAGE-8);
  arena.write(turn,stillOwned,new Uint8Array(PAGE-8).fill(47));
  withPatchedMethod(Array.prototype,Symbol.iterator,function*(){
    yield {offset:0,length:PAGE};
  },()=>arena.dropPersistent(turn,abandoned));
  const reused=arena.allocPersistent(turn,8);
  arena.write(turn,reused,new Uint8Array(8).fill(19));
  assert.equal(arena.read(turn,stillOwned).every(b=>b===47),true,
    'free-list must never overlap still-owned bytes');
  assert.throws(()=>arena.allocPersistent(turn,1),/quota exhausted/);
  arena.dropPersistent(turn,reused);
  arena.dropPersistent(turn,stillOwned);
  arena.endTurn(turn);
  arena.retire();
});


test('owner whitelist resists Set.has tampering by guest code', () => {
  withPatchedMethod(Set.prototype,'has',()=>true,()=>{
    assert.throws(()=>new ActorArena({actorId:122,incarnation:1,kind:'external'}),
      /invalid actor arena owner/);
  });
});

test('actor metadata and allocation sizes resist patched Number.isSafeInteger', () => {
  withPatchedMethod(Number,'isSafeInteger',()=>true,()=>{
    assert.throws(()=>new ActorArena({actorId:1.5,incarnation:1}),
      /invalid actor arena owner/);
  });
  const arena=new ActorArena({actorId:123,incarnation:1});
  const turn=arena.beginTurn();
  withPatchedMethod(Number,'isSafeInteger',()=>true,()=>{
    assert.throws(()=>arena.allocPersistent(turn,0.5),/invalid arena allocation length/);
  });
  const valid=arena.allocPersistent(turn,8);
  arena.dropPersistent(turn,valid);
  arena.endTurn(turn);
  arena.retire();
});

test('beginTurn creates a frozen authority token under Object.freeze pollution',()=>{
  const arena=new ActorArena({actorId:124,incarnation:1});
  let token;
  withPatchedMethod(Object,'freeze',x=>x,()=>{ token=arena.beginTurn(); });
  assert.equal(Object.isFrozen(token),true);
  arena.endTurn(token);
  arena.retire();
});
