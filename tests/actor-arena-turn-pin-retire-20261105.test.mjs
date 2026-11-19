import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const arena=()=>new ActorArena({actorId:11,incarnation:2,kind:'shared'});

test('scratch handles expire at endTurn while persistent bytes remain privately owned',()=>{
 const a=arena(),t=a.beginTurn();
 const saved=a.allocPersistent(t,3),scratch=a.allocScratch(t,3);
 a.write(t,saved,Uint8Array.from([3,4,5]));
 a.write(t,scratch,Uint8Array.from([8,9,10]));
 const snapshot=a.read(t,saved);snapshot[0]=99;
 assert.deepEqual([...a.read(t,saved)],[3,4,5]);
 a.endTurn(t);
 const next=a.beginTurn();
 assert.deepEqual([...a.read(next,saved)],[3,4,5]);
 assert.throws(()=>a.read(next,scratch),/foreign or stale arena handle/);
 assert.throws(()=>a.read(t,saved),/actor turn authority required/);
 a.dropPersistent(next,saved);
 const replacement=a.allocPersistent(next,3);
 assert.deepEqual([...a.read(next,replacement)],[0,0,0]);
 assert.throws(()=>a.read(next,saved),/foreign or stale arena handle/);
 a.endTurn(next);a.retire();
 assert.equal(a.retired,true);
});

test('retirement logically seals actor access but physical release waits for last lifetime pin',()=>{
 const a=arena(),t=a.beginTurn();
 const pin1=a.pinLifetime(t),pin2=a.pinLifetime(t);
 assert.equal(a.pendingLifetimePins,2);
 assert.throws(()=>a.retire(),/active actor turn blocks retirement/);
 a.endTurn(t);a.retire();
 assert.equal(a.retired,true);
 assert.equal(a.pendingLifetimePins,2);
 assert.throws(()=>a.beginTurn(),/actor arena retired/);
 a.releaseLifetimePin(pin1);a.releaseLifetimePin(pin1);
 assert.equal(a.pendingLifetimePins,1);
 a.releaseLifetimePin(pin2);
 assert.equal(a.pendingLifetimePins,0);
 assert.throws(()=>a.releaseLifetimePin(Object.freeze({})),/foreign or unissued actor arena lifetime pin/);
 a.retire();
});

test('cross-arena turn and data-authority tokens never grant writes',()=>{
 const a=arena(),b=arena(),at=a.beginTurn(),bt=b.beginTurn();
 const h=a.allocPersistent(at,2);
 assert.throws(()=>a.allocScratch(bt,2),/actor turn authority required/);
 assert.throws(()=>b.read(bt,h),/foreign or stale arena handle/);
 assert.throws(()=>a.write(at,h,Uint8Array.from([7])),/exact-size Uint8Array/);
 assert.throws(()=>a.write(at,h,[7,8]),/exact-size Uint8Array/);
 a.endTurn(at);b.endTurn(bt);a.retire();b.retire();
});
