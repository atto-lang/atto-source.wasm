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
