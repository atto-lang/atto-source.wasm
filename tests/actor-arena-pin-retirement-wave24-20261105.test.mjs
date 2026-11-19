import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

const arena=()=>new ActorArena({actorId:42,incarnation:7,kind:'shared'});

test('external lifetime pin blocks final retirement until its owner acknowledges',()=>{
 const a=arena(),turn=a.beginTurn();
 const handle=a.allocPersistent(turn,3),pin=a.pinLifetime(turn);
 a.write(turn,handle,Uint8Array.of(7,8,9));
 assert.deepEqual([...a.read(turn,handle)],[7,8,9]);
 a.endTurn(turn);
 a.retire();
 assert.equal(a.retired,true);
 assert.equal(a.pendingLifetimePins,1);
 assert.throws(()=>a.beginTurn(),/actor arena retired/);
 a.releaseLifetimePin(pin);
 assert.equal(a.pendingLifetimePins,0);
 a.releaseLifetimePin(pin);
 assert.equal(a.pendingLifetimePins,0);
 a.retire();
});

test('scratch bytes and scratch tickets expire at turn boundary',()=>{
 const a=arena(),first=a.beginTurn();
 const scratch=a.allocScratch(first,4);
 a.write(first,scratch,Uint8Array.of(10,11,12,13));
 a.endTurn(first);
 const second=a.beginTurn();
 assert.throws(()=>a.read(second,scratch),/foreign or stale arena handle/);
 const reused=a.allocScratch(second,4);
 assert.deepEqual([...a.read(second,reused)],[0,0,0,0]);
 a.endTurn(second);
 a.retire();
});

test('dropped persistent bytes are zeroed and stale handle cannot regain ownership',()=>{
 const a=arena(),t=a.beginTurn();
 const first=a.allocPersistent(t,2);
 a.write(t,first,Uint8Array.of(199,155));
 a.dropPersistent(t,first);
 assert.throws(()=>a.read(t,first),/foreign or stale arena handle/);
 const second=a.allocPersistent(t,2);
 assert.deepEqual([...a.read(t,second)],[0,0]);
 const copy=a.read(t,second);copy[0]=22;
 assert.deepEqual([...a.read(t,second)],[0,0]);
 a.endTurn(t);a.retire();
});

test('foreign pins and handles cannot access another actor incarnation',()=>{
 const a=arena(),b=new ActorArena({actorId:42,incarnation:8});
 const t1=a.beginTurn(),t2=b.beginTurn();
 const h=a.allocPersistent(t1,1),pin=a.pinLifetime(t1);
 assert.throws(()=>b.read(t2,h),/foreign or stale arena handle/);
 assert.throws(()=>b.releaseLifetimePin(pin),/foreign or unissued actor arena lifetime pin/);
 assert.throws(()=>a.retire(),/active actor turn blocks retirement/);
 a.endTurn(t1);b.endTurn(t2);
 a.retire();b.retire();a.releaseLifetimePin(pin);
 assert.equal(a.pendingLifetimePins,0);
});
