import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";
import {ActorArena} from "../src/actor-arena.mjs";

// AF01–AF20 are *not* established by these tests. Core Wasm cannot execute
// source actor turns. Host arena lifecycle is a separate safety substrate.
test("AF02/AF18 core Wasm actor execution is rejected before guest byte decoding",()=>{
  const invalidGuest = Uint8Array.from([0]);
  for(const actorPhysicalTurns of [1,2,4096,-1,1.5,true,"1",null]){
    assert.throws(
      ()=>compileAdmittedCoreGuest(invalidGuest,{actorPhysicalTurns}),
      /physical source actor execution is unsupported/);
  }
  // The option guard must not mutate the caller's input.
  assert.deepEqual(Array.from(invalidGuest),[0]);
  assert.throws(()=>compileAdmittedCoreGuest(invalidGuest),
    e=>!String(e.message).includes("actor execution is unsupported"));
});
test("AF04/AF07 actor arena waits for final turn and fences stale handles",()=>{
  const owner = new ActorArena({actorId:880,incarnation:1});
  const turn = owner.beginTurn();
  const slot = owner.allocPersistent(turn,4);
  owner.write(turn,slot,Uint8Array.from([4,3,2,1]));
  assert.throws(()=>owner.retire(),/active actor turn/);
  assert.deepEqual(Array.from(owner.read(turn,slot)),[4,3,2,1]);
  owner.endTurn(turn);
  owner.retire();
  assert.throws(()=>owner.beginTurn(),/retired/);
  const replacement = new ActorArena({actorId:880,incarnation:2});
  const next = replacement.beginTurn();
  assert.throws(()=>replacement.read(next,slot),/foreign or stale/);
  const newSlot = replacement.allocPersistent(next,4);
  assert.deepEqual(Array.from(replacement.read(next,newSlot)),[0,0,0,0]);
  replacement.endTurn(next);
  replacement.retire();
});
test("AF05 repeated host arena retire is idempotent, not guest supervisor proof",()=>{
  const a=new ActorArena({actorId:881,incarnation:1});
  const t=a.beginTurn();
  const h=a.allocScratch(t,16);
  a.write(t,h,new Uint8Array(16).fill(91));
  a.endTurn(t);
  a.retire();
  assert.doesNotThrow(()=>a.retire());
  assert.throws(()=>a.beginTurn(),/retired/);
});
